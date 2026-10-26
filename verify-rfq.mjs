/* Проверка регистрации, каталога, подбора поставщиков и RFQ. Запуск: node verify-rfq.mjs */
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

const seed = { companies: [
  { role: 'supplier', name: 'ТОО «Алатау»', country: 'Казахстан', reg: '041240004821', email: 'a@alatau.kz', city: 'Алматы', address: 'Алматы',
    iban: 'KZ123456789012345678', swift: 'HSBKKZKX', bank: 'Halyk', certs: ['eaeu_decl', 'quality_cert'], export_to: ['UZ', 'KG'], lead_time_days: 12,
    products: [
      { name: 'Вафли «Артек»', hs: '1905.32', unit: 'кг', price: 2.35, moq: 2000, shelf_life_months: 9 },
      { name: 'Печенье «Юбилейное»', hs: '1905.31', unit: 'кг', price: 1.9, moq: 1000, shelf_life_months: 6 }] },
  { role: 'supplier', name: 'ТОО «Тараз Тәтті»', country: 'Казахстан', reg: '150540011223', email: 'sales@taraz.kz', city: 'Тараз', address: 'Тараз',
    iban: 'KZ556010002000654321', swift: 'HSBKKZKX', bank: 'Halyk', certs: ['eaeu_decl', 'quality_cert', 'halal'], export_to: ['UZ'], lead_time_days: 20,
    products: [
      { name: 'Вафли «Тараз»', hs: '1905.32', unit: 'кг', price: 2.15, moq: 5000, shelf_life_months: 8 },
      { name: 'Печенье овсяное', hs: '1905.31', unit: 'кг', price: 1.8, moq: 3000, shelf_life_months: 5 }] },
  { role: 'supplier', name: 'ТОО «Шымкент Кондитер»', country: 'Казахстан', reg: '090340012345', email: 'info@shym.kz', city: 'Шымкент', address: 'Шымкент',
    iban: 'KZ986010002000123456', swift: 'HSBKKZKX', bank: 'Halyk', certs: ['eaeu_decl'], export_to: [], lead_time_days: 45,
    products: [{ name: 'Вафли «Шымкент»', hs: '1905.32', unit: 'кг', price: 2.6, moq: 1000, shelf_life_months: 6 }] },
  { role: 'buyer', name: 'ООО «Восток»', country: 'Узбекистан', reg: 'ИНН 302456789', email: 'buy@vostok.uz', address: 'Ташкент', iban: 'UZ987654321098765432', swift: 'IPTBUZ22', bank: 'Ипотека' }
] };
const rfqArgs = {
  lines: [{ hs: '1905.32', name: 'Вафли', qty: 10000, target_price: 2.3, specification: 'влажность не более 4,5%' }, { hs: '1905.31', name: 'Печенье', qty: 6000, target_price: 1.9 }],
  route: 'UZ', delivery_place: 'Ташкент, склад', incoterms: 'DAP', currency: 'USD', payment_preset: '30_70',
  delivery_date: '2026-10-31', offer_deadline: '2026-10-05', compliance: ['eaeu_decl', 'halal', 'shelf_75']
};

group('Регистрация компаний');
let w = M.createWorkspace(seed, T(1));
ok('3 поставщика, 1 покупатель, 5 товаров', w.companies.filter(c => c.role === 'supplier').length === 3 && w.catalog.length === 5);
ok('БИН сохранён с префиксом', w.companies[0].reg === 'БИН 041240004821');
const base = { role: 'buyer', name: 'ТОО «Новый»', country: 'Казахстан', reg: '123456789012', email: 'new@new.kz' };
throws('БИН не из 12 цифр', () => M.registerCompany(w, { ...base, reg: '12345' }, T(1)), '12 цифр');
throws('плохой e-mail', () => M.registerCompany(w, { ...base, email: 'bad' }, T(1)), 'e-mail');
throws('повтор e-mail', () => M.registerCompany(w, { ...base, email: 'a@alatau.kz' }, T(1)), 'уже зарегистрирована');
throws('повтор БИН', () => M.registerCompany(w, { ...base, reg: '041240004821' }, T(1)), 'регистрационным номером');
throws('KZ IBAN не 20 символов', () => M.registerCompany(w, { ...base, iban: 'KZ1234567890123' }, T(1)), '20 символов');
throws('SWIFT неверный', () => M.registerCompany(w, { ...base, swift: 'ABC' }, T(1)), 'SWIFT');
throws('поставщику нужен IBAN', () => M.registerCompany(w, { ...base, role: 'supplier' }, T(1)), 'IBAN');
const w1 = M.registerCompany(w, { ...base, iban: 'KZ123456789012345670' }, T(1));
ok('регистрация проходит и пишется в журнал', w1.companies.length === 5 && w1.events.some(e => e.type === 'COMPANY_REGISTERED'));
throws('покупатель не публикует товары', () => M.addProduct(w, 'co4', { name: 'X', hs: '1905', price: 1, unit: 'кг' }, T(1)), 'поставщик');
throws('код ТН ВЭД в формате', () => M.addProduct(w, 'co1', { name: 'X', hs: '19', price: 1, unit: 'кг' }, T(1)), 'ТН ВЭД');
ok('поставщик публикует товар', M.addProduct(w, 'co1', { name: 'Пряники', hs: '1905.90.20', price: 2.1, unit: 'кг' }, T(1)).catalog.length === 6);

group('RFQ и подбор поставщиков');
throws('поставщик не создаёт RFQ', () => M.createRFQ(w, 'co1', rfqArgs, T(1)), 'покупатель');
throws('без позиций нельзя', () => M.createRFQ(w, 'co4', { ...rfqArgs, lines: [] }, T(1)), 'позицию');
throws('без места поставки нельзя', () => M.createRFQ(w, 'co4', { ...rfqArgs, delivery_place: '' }, T(1)), 'Destination');
throws('поставка раньше дедлайна предложений нельзя', () => M.createRFQ(w, 'co4', { ...rfqArgs, delivery_date: '2026-10-03' }, T(1)), 'позже');
w = M.createRFQ(w, 'co4', rfqArgs, T(1));
const r = w.rfqs[0];
ok('RFQ в черновике, подобрано 3 поставщика', r.status === 'DRAFT' && r.matches.length === 3);
const by = id => r.matches.find(m => m.supplier_id === id);
ok('у каждой оценки 6 критериев, сумма весов 100', r.matches.every(m => m.factors.length === 6) && Object.values(M.WEIGHTS).reduce((a, b) => a + b, 0) === 100);
ok('оценка = сумма баллов по критериям', r.matches.every(m => m.score === m.factors.reduce((a, f) => a + f.points, 0)));
ok('Шымкент покрывает 1 из 2 позиций — неполный, в конце', !by('co3').complete && r.matches[r.matches.length - 1].supplier_id === 'co3');
ok('Тараз: все сертификаты, включая Халал', by('co2').factors.find(f => f.key === 'compliance').points === M.WEIGHTS.compliance);
ok('Алатау: нет Халал — объяснение это говорит', by('co1').factors.find(f => f.key === 'compliance').note.includes('Халал'));
ok('Тараз: мин. партия печенья 3000 ≤ 6000, вафель 5000 ≤ 10000 — баллы за партию', by('co2').factors.find(f => f.key === 'moq').points === M.WEIGHTS.moq);
ok('срок: Алатау 12 дн. успевает, баллы полные', by('co1').factors.find(f => f.key === 'delivery').points === M.WEIGHTS.delivery);
ok('опыт по направлению: Шымкент без поставок в УЗ — 0', by('co3').factors.find(f => f.key === 'experience').points === 0);
ok('подбор выбрал товары поставщика под каждую позицию', by('co1').product_ids.every(Boolean) && by('co3').product_ids[1] === null);
throws('неполному поставщику RFQ не отправить', () => M.sendRFQ(w, 'co4', 'rfq1', ['co3'], T(1)), 'не все позиции');
throws('без выбора поставщиков не отправить', () => M.sendRFQ(w, 'co4', 'rfq1', [], T(1)), 'хотя бы одного');
w = M.sendRFQ(w, 'co4', 'rfq1', ['co1', 'co2'], T(1));
ok('отправлен двум поставщикам', w.rfqs[0].status === 'SENT' && w.rfqs[0].recipients.length === 2);
ok('поставщик видит запрос в «Ваш ход»', M.nextActions(w, 'co1')[0].kind === 'goto_rfq');
ok('Шымкенту запрос не пришёл', M.nextActions(w, 'co3')[0].kind === 'wait');

group('Предложения и сравнение');
throws('не получатель не может ответить', () => M.submitOffer(w, 'co3', 'rfq1', { lead_time_days: 10 }, T(2)), 'не отправлялся');
throws('без срока отгрузки нельзя', () => M.submitOffer(w, 'co1', 'rfq1', {}, T(2)), 'срок');
throws('после дедлайна нельзя', () => M.submitOffer(w, 'co1', 'rfq1', { lead_time_days: 10 }, T(9)), 'истёк');
throws('чужой товар в предложении нельзя', () => M.submitOffer(w, 'co1', 'rfq1', { lead_time_days: 10, product_ids: ['prod3', 'prod2'] }, T(2)), 'свой товар');
w = M.submitOffer(w, 'co1', 'rfq1', { prices: [2.3, 1.85], lead_time_days: 12 }, T(2));
w = M.submitOffer(w, 'co2', 'rfq1', { prices: [2.15, 1.8], lead_time_days: 20 }, T(2));
const cmp = M.compareOffers(w, 'rfq1');
ok('Алатау 34 100, Тараз 32 300', w.offers[0].total === 34100 && w.offers[1].total === 32300);
ok('сравнение: дешевле Тараз, быстрее Алатау', cmp[0].supplier.id === 'co2' && cmp[0].cheapest && cmp.find(x => x.supplier.id === 'co1').fastest);
ok('разница с лучшей ценой посчитана', cmp.find(x => x.supplier.id === 'co1').over_best === 1800);
ok('покупатель видит «Сравните предложения»', M.nextActions(w, 'co4')[0].text.includes('Сравните'));
throws('отказ без причины нельзя', () => M.declineRFQ(M.sendRFQ(M.createRFQ(M.createWorkspace(seed, T(1)), 'co4', rfqArgs, T(1)), 'co4', 'rfq1', ['co1'], T(1)), 'co1', 'rfq1', '', T(2)), 'причину');

group('Принятие → сделка с выбранным поставщиком');
throws('поставщик не принимает предложения', () => M.acceptOffer(w, 'co1', 'off2', T(3)), 'покупатель');
throws('просроченное не принять', () => M.acceptOffer(w, 'co4', 'off2', T(20)), 'действовало');
let w2 = M.acceptOffer(w, 'co4', 'off2', T(3));
const d = w2.deal;
ok('сделка с Тараз, второе предложение отклонено', d.parties.supplier_id === 'co2' && w2.offers[0].status === 'REJECTED');
ok('реквизиты поставщика в сделке — Тараз', d.companies.supplier.name === 'ТОО «Тараз Тәтті»' && d.companies.supplier.iban === 'KZ556010002000654321');
ok('сумма договора = сумма предложения', d.deal.frame_limit === 32300);
ok('товары в договоре — товары Тараз', D.contractFields(d).goods_name.includes('Вафли «Тараз»'));
ok('источники полей: поставщик с оценкой подбора', M.contractSources(w2)[0][1].includes('/100'));
ok('Алатау не участник сделки', M.dealRole(w2, 'co1') === null && M.nextActions(w2, 'co1')[0].text.includes('не участвует'));
throws('не участник не может согласовать договор', () => M.approveContract(w2, 'co1', T(4)), 'не участвует');

group('Согласование → спецификация из предложения → исполнение');
w2 = M.approveContract(w2, 'co2', T(4));
w2 = M.approveContract(w2, 'co4', T(4));
const sp = w2.deal.specs[0];
ok('спецификация №1 из предложения, согласована', sp && sp.status === 'AGREED' && sp.items[0].name === 'Вафли «Тараз»' && sp.items[0].price === 2.15);
ok('требования и спецификация товара в «Иных условиях»', sp.other_terms.includes('Халал') && sp.other_terms.includes('влажность'));
ok('аванс 30% = 9690', w2.deal.payments[0].amount === 9690, String(w2.deal.payments[0].amount));
w2 = M.dealCmd(w2, 'co4', (s, role) => D.markPaymentSent(s, role, 'pay1', { bank_reference: 'R1' }, T(5)));
w2 = M.dealCmd(w2, 'co2', (s, role) => D.confirmPayment(s, role, 'pay1', T(5)));
w2 = M.dealCmd(w2, 'co2', (s, role) => D.issueCMR(s, role, 'spec1', { vehicle: 'A1' }, T(6)));
w2 = M.dealCmd(w2, 'co4', (s, role) => D.confirmDelivery(s, role, 'cmr1', T(9)));
w2 = M.dealCmd(w2, 'co4', (s, role) => D.markPaymentSent(s, role, 'pay2', { bank_reference: 'R2' }, T(9)));
w2 = M.dealCmd(w2, 'co2', (s, role) => D.confirmPayment(s, role, 'pay2', T(10)));
ok('исполнено от регистрации до оплаты остатка', w2.deal.specs[0].status === 'FULFILLED');
ok('роли в сделке проверяются: покупатель не выписывает CMR', (() => { try { M.dealCmd(w2, 'co4', (s, role) => D.issueCMR(s, role, 'spec1', { vehicle: 'A' }, T(10))); return false; } catch (e) { return e.message.includes('Поставщик'); } })());
const tl = M.timeline(w2);
ok('хронология от каталога до исполнения', tl.some(e => e.type === 'RFQ_SENT') && tl.some(e => e.type === 'SPEC_FULFILLED'));
ok('имя актора в хронологии по компании', M.actorName(w2, 'supplier') === 'ТОО «Тараз Тәтті»' && M.actorName(w2, 'co4') === 'ООО «Восток»');
const cmrTxt = D.cmrBlocks(w2.deal, 'cmr1').map(b => (b.rows || []).flat().join(' ')).join(' ');
ok('CMR: отправитель Тараз, товары Тараз', cmrTxt.includes('Тараз Тәтті') && cmrTxt.includes('Печенье овсяное'));

console.log(`\n${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
