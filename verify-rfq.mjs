/* Проверка каталога и RFQ. Запуск: node verify-rfq.mjs */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { RULES } = require('./rules.js');
globalThis.RULES = RULES;
globalThis.ENGINE = require('./engine.js');
globalThis.DEAL = require('./deal-engine.js');
const D = globalThis.DEAL;
const M = require('./rfq-engine.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  → ' + x : '')); } };
const throws = (n, fn, needle) => {
  try { fn(); fail++; console.log('  FAIL ' + n + '  → не бросило'); }
  catch (e) { const g = e instanceof D.DealError && (!needle || e.message.includes(needle)); g ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + '  → ' + e.message)); }
};
const group = n => console.log('\n' + n);
const T = d => `2026-10-${String(d).padStart(2, '0')}T10:00:00.000Z`;

const seed = {
  companies: {
    supplier: { name: 'ТОО «Алатау»', country: 'Казахстан', reg: 'БИН 1', rep: 'А.К.', address: 'Алматы', bank: 'Halyk', iban: 'KZ11', swift: 'HSBKKZKX' },
    buyer: { name: 'ООО «Восток»', country: 'Узбекистан', reg: 'ИНН 2', rep: 'Ш.Р.', address: 'Ташкент', bank: 'Ипотека', iban: 'UZ22', swift: 'IPTBUZ22' }
  },
  catalog: [
    { name: 'Вафли «Артек»', hs: '1905.32', unit: 'кг', price: 2.35, moq: 2000, shelf_life_months: 9, standard: 'СТ РК 1183-2003' },
    { name: 'Печенье «Юбилейное»', hs: '1905.31', unit: 'кг', price: 1.9, moq: 1000, shelf_life_months: 6 }
  ]
};
const rfqArgs = {
  items: [{ product_id: 'prod1', qty: 10000, specification: 'влажность не более 4,5%' }, { product_id: 'prod2', qty: 6000 }],
  route: 'UZ', delivery_place: 'Ташкент, склад', incoterms: 'DAP', currency: 'USD', payment_preset: '30_70',
  delivery_date: '2026-11-10', offer_deadline: '2026-10-05', compliance: ['eaeu_decl', 'shelf_75']
};

group('Каталог');
let w = M.createWorkspace(seed, T(1));
ok('два товара в каталоге с артикулами', w.catalog.length === 2 && w.catalog[0].sku === 'SKU-001');
throws('покупатель не публикует товары', () => M.addProduct(w, 'buyer', { name: 'X', price: 1, unit: 'кг' }, T(1)), 'Поставщик');
throws('товар без цены не публикуется', () => M.addProduct(w, 'supplier', { name: 'X', unit: 'кг' }, T(1)), 'цену');
ok('поставщик добавляет товар', M.addProduct(w, 'supplier', { name: 'Пряники', price: 2.1, unit: 'кг' }, T(1)).catalog.length === 3);

group('RFQ — поля из письма Бекмырзы');
throws('поставщик не отправляет RFQ', () => M.createRFQ(w, 'supplier', rfqArgs, T(1)), 'Покупатель');
throws('ниже минимальной партии нельзя', () => M.createRFQ(w, 'buyer', { ...rfqArgs, items: [{ product_id: 'prod1', qty: 500 }] }, T(1)), 'минимальная партия');
throws('без места поставки нельзя', () => M.createRFQ(w, 'buyer', { ...rfqArgs, delivery_place: '' }, T(1)), 'Destination');
throws('срок предложений в прошлом нельзя', () => M.createRFQ(w, 'buyer', { ...rfqArgs, offer_deadline: '2026-09-01' }, T(1)), 'прошёл');
throws('поставка раньше срока предложений нельзя', () => M.createRFQ(w, 'buyer', { ...rfqArgs, delivery_date: '2026-10-03' }, T(1)), 'позже');
w = M.createRFQ(w, 'buyer', rfqArgs, T(1));
const r = w.rfqs[0];
const fields = ['items', 'origin', 'route', 'delivery_place', 'incoterms', 'currency', 'payment_preset', 'delivery_date', 'documents', 'compliance', 'offer_deadline'];
ok('все 12 полей RFQ заполнены (Product, Quantity, Specification внутри items)', fields.every(f => r[f] !== undefined && r[f] !== '') && r.items[0].qty === 10000 && r.items[0].specification);
ok('происхождение взято из каталога', r.origin === 'Казахстан');
ok('документы по умолчанию из правил маршрута: вне ЕАЭС есть экспортная декларация', r.documents.includes('Экспортная декларация') && r.documents.some(d => d.includes('CMR')));
ok('данные товара зафиксированы снимком в RFQ', r.items[0].hs === '1905.32' && r.items[0].list_price === 2.35);
throws('второй открытый RFQ запрещён', () => M.createRFQ(w, 'buyer', rfqArgs, T(1)), 'открытый');
ok('поставщик видит «Ответить на RFQ»', M.nextActions(w, 'supplier')[0].kind === 'answer_rfq');

group('Предложение');
throws('покупатель не делает предложение', () => M.submitOffer(w, 'buyer', 'rfq1', { lead_time_days: 10 }, T(2)), 'Поставщик');
throws('без срока отгрузки нельзя', () => M.submitOffer(w, 'supplier', 'rfq1', {}, T(2)), 'срок');
throws('после дедлайна нельзя', () => M.submitOffer(w, 'supplier', 'rfq1', { lead_time_days: 10 }, T(9)), 'истёк');
let w2 = M.submitOffer(w, 'supplier', 'rfq1', { prices: [2.3, 1.85], lead_time_days: 14 }, T(2));
const o = w2.offers[0];
ok('сумма предложения 10000×2.30 + 6000×1.85 = 34100', o.total === 34100, String(o.total));
ok('успевает к сроку поставки', o.meets_delivery === true);
ok('RFQ в статусе «получено предложение»', w2.rfqs[0].status === 'OFFERED');
const w3 = M.submitOffer(w2, 'supplier', 'rfq1', { prices: [2.25, 1.85], lead_time_days: 14 }, T(3));
ok('новое предложение заменяет старое', w3.offers[0].status === 'SUPERSEDED' && w3.offers[1].status === 'SUBMITTED');
ok('покупатель видит «Рассмотреть предложение»', M.nextActions(w2, 'buyer')[0].kind === 'review_offer');
const wr = M.rejectOffer(w2, 'buyer', 'off1', T(3));
ok('отклонение снова открывает RFQ', wr.rfqs[0].status === 'SENT' && wr.offers[0].status === 'REJECTED');
throws('просроченное предложение не принять', () => M.acceptOffer(w2, 'buyer', 'off1', T(20)), 'действовало');

group('Принятие → сделка, данные текут без повторного ввода');
let w4 = M.acceptOffer(w2, 'buyer', 'off1', T(3));
const d = w4.deal;
ok('сделка создана, договор на согласовании', d && d.contract.status === 'IN_REVIEW');
ok('сумма договора = сумма предложения', d.deal.frame_limit === 34100);
ok('маршрут, Incoterms, место, оплата — из RFQ', d.deal.route === 'UZ' && d.deal.incoterms === 'DAP' && d.deal.delivery_place === 'Ташкент, склад' && d.deal.payment_preset === '30_70');
ok('срок годности — минимальный из карточек (6 мес.)', d.contract.terms.shelf_life_value === 6);
const cf = D.contractFields(d);
ok('договор: товары и ТН ВЭД из RFQ', cf.goods_name.includes('Вафли') && cf.hs_code.includes('1905.32'));
throws('второе принятие невозможно', () => M.acceptOffer(w4, 'buyer', 'off1', T(3)), 'не на рассмотрении');
ok('источник каждого поля договора показан', M.contractSources(w4).length >= 12 && M.contractSources(w4).some(s => s[2] === 'OFF-0001'));

group('Согласование договора создаёт спецификацию №1 из предложения');
w4 = M.approveContract(w4, 'supplier', T(4));
ok('после одного согласования спецификации ещё нет', w4.deal.specs.length === 0);
w4 = M.approveContract(w4, 'buyer', T(4));
const sp = w4.deal.specs[0];
ok('спецификация №1 создана и сразу согласована', sp && sp.status === 'AGREED');
ok('позиции, количество и цены — из предложения', sp.items[0].qty === 10000 && sp.items[0].price === 2.3 && sp.items[1].price === 1.85);
ok('требования покупателя и спецификация товара перенесены в «Иные условия»', sp.other_terms.includes('ЕАЭС') && sp.other_terms.includes('влажность'));
ok('сразу выставлен счёт на аванс 30% = 10230', w4.deal.invoices.length === 1 && w4.deal.payments[0].amount === 10230, String(w4.deal.payments[0] && w4.deal.payments[0].amount));
ok('событие «создана из RFQ и предложения» в хронологии', M.timeline(w4).some(e => e.type === 'SPEC_FROM_OFFER'));

group('Дальше обычный поток сделки до исполнения');
w4 = M.dealCmd(w4, s => D.markPaymentSent(s, 'buyer', 'pay1', { bank_reference: 'R1' }, T(5)));
w4 = M.dealCmd(w4, s => D.confirmPayment(s, 'supplier', 'pay1', T(5)));
w4 = M.dealCmd(w4, s => D.issueCMR(s, 'supplier', 'spec1', { vehicle: 'A1' }, T(6)));
w4 = M.dealCmd(w4, s => D.confirmDelivery(s, 'buyer', 'cmr1', T(9)));
w4 = M.dealCmd(w4, s => D.markPaymentSent(s, 'buyer', 'pay2', { bank_reference: 'R2' }, T(9)));
w4 = M.dealCmd(w4, s => D.confirmPayment(s, 'supplier', 'pay2', T(10)));
ok('исполнено от каталога до оплаты остатка', w4.deal.specs[0].status === 'FULFILLED');
const tl = M.timeline(w4);
ok('хронология объединяет RFQ и сделку по времени', tl[0].type === 'WORKSPACE_CREATED' && tl.some(e => e.type === 'RFQ_SENT') && tl.some(e => e.type === 'SPEC_FULFILLED'));
const cmrTxt = D.cmrBlocks(w4.deal, 'cmr1').map(b => (b.rows || []).flat().join(' ')).join(' ');
ok('CMR содержит товары, пришедшие из каталога', cmrTxt.includes('Вафли «Артек»') && cmrTxt.includes('1905.31'));

group('Отказы и закрытие');
throws('отказ без причины нельзя', () => M.declineRFQ(w, 'supplier', 'rfq1', '', T(2)), 'причину');
ok('отказ с причиной', M.declineRFQ(w, 'supplier', 'rfq1', 'Нет мощностей в ноябре', T(2)).rfqs[0].status === 'DECLINED');
ok('покупатель закрывает RFQ', M.closeRFQ(w2, 'buyer', 'rfq1', T(2)).rfqs[0].status === 'CLOSED');

console.log(`\n${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
