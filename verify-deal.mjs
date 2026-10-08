/* Проверка сквозного потока сделки. Запуск: node verify-deal.mjs */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { RULES } = require('./rules.js');
globalThis.RULES = RULES;
globalThis.ENGINE = require('./engine.js');
const D = require('./deal-engine.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const throws = (name, fn, needle) => {
  try { fn(); fail++; console.log('  FAIL ' + name + '  → не бросило ошибку'); }
  catch (e) {
    const good = e instanceof D.DealError && (!needle || e.message.includes(needle));
    if (good) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + '  → ' + e.message); }
  }
};
const group = n => console.log('\n' + n);

const T = d => `2026-10-${String(d).padStart(2, '0')}T10:00:00.000Z`;
const seed = (preset = '30_70') => ({
  ref: 'TWH-D-000001', route: 'UZ', incoterms: 'DAP', transport: 'road', currency: 'USD',
  category: 'bakery', payment_preset: preset, frame_limit: 500000,
  delivery_place: 'г. Ташкент, склад Покупателя',
  companies: {
    supplier: { name: 'ТОО «Алатау»', country: 'Казахстан', reg: 'БИН 1', rep: 'А.К.', address: 'Алматы', bank: 'Halyk', iban: 'KZ11', swift: 'HSBKKZKX' },
    buyer: { name: 'ООО «Восток»', country: 'Узбекистан', reg: 'ИНН 2', rep: 'Ш.Р.', address: 'Ташкент', bank: 'Ипотека', iban: 'UZ22', swift: 'IPTBUZ22' }
  }
});
const items = [
  { name: 'Вафли «Артек»', hs: '1905.32', unit: 'кг', qty: 10000, price: 2.35 },
  { name: 'Печенье «Юбилейное»', hs: '1905.31', unit: 'кг', qty: 6000, price: 1.9 }
];
const agreed = (preset) => {
  let s = D.createDeal(seed(preset), T(1));
  s = D.approveContract(s, 'supplier', T(1));
  s = D.approveContract(s, 'buyer', T(2));
  return s;
};
const withSpec = (preset) => {
  let s = agreed(preset);
  s = D.createSpec(s, 'supplier', { items, delivery_date: '2026-10-30' }, T(3));
  s = D.approveSpec(s, 'buyer', 'spec1', T(4));
  return s;
};

group('Договор');
{
  const s0 = D.createDeal(seed(), T(1));
  ok('сделка создана, договор на согласовании', s0.contract.status === 'IN_REVIEW' && s0.deal.status === 'CONTRACTING');
  const s1 = D.approveContract(s0, 'supplier', T(1));
  ok('одно согласование не делает договор согласованным', s1.contract.status === 'IN_REVIEW');
  ok('исходный state не мутирован', s0.contract.approvals.supplier === null);
  const s2 = D.updateContract(s1, 'buyer', { payment_preset: '50_50' }, T(1));
  ok('правка сбрасывает согласования и поднимает версию', s2.contract.version === 2 && s2.contract.approvals.supplier === null);
  const s3 = D.approveContract(D.approveContract(s2, 'supplier', T(2)), 'buyer', T(2));
  ok('обе стороны на одной версии → AGREED, сделка ACTIVE', s3.contract.status === 'AGREED' && s3.deal.status === 'ACTIVE');
  throws('нельзя создать спецификацию до согласования договора', () => D.createSpec(s1, 'supplier', { items }, T(2)), 'договор');
  throws('нельзя править поле вне белого списка', () => D.updateContract(s0, 'buyer', { status: 'AGREED' }, T(1)), 'нельзя');
  ok('поля для генератора договора: рамочный лимит как сумма', D.contractFields(s3).unit_price === 500000);
}

group('Спецификация');
{
  let s = agreed();
  s = D.createSpec(s, 'supplier', { items, delivery_date: '2026-10-30' }, T(3));
  const sp = s.specs[0];
  ok('сумма спецификации 10000×2.35 + 6000×1.9 = 34900', D.specTotal(sp) === 34900, String(D.specTotal(sp)));
  ok('автор согласен автоматически, вторая сторона нет', sp.approvals.supplier === 1 && sp.approvals.buyer === null);
  const s2 = D.updateSpec(s, 'buyer', 'spec1', { items: [{ ...items[0], qty: 12000 }, items[1]] }, T(3));
  ok('правка покупателем сбрасывает согласие поставщика', s2.specs[0].approvals.supplier === null && s2.specs[0].approvals.buyer === 2);
  throws('превышение рамочного лимита запрещено', () => D.createSpec(agreed(), 'supplier', { items: [{ name: 'X', qty: 1, price: 600000 }] }, T(3)), 'лимит');
  throws('пустая спецификация запрещена', () => D.createSpec(agreed(), 'supplier', { items: [] }, T(3)), 'позиция');
  throws('нулевая цена запрещена', () => D.createSpec(agreed(), 'supplier', { items: [{ name: 'X', qty: 1, price: 0 }] }, T(3)), 'цена');
  const s3 = D.approveSpec(s, 'buyer', 'spec1', T(4));
  ok('согласование второй стороной → AGREED', s3.specs[0].status === 'AGREED');
  throws('согласованную спецификацию нельзя править', () => D.updateSpec(s3, 'buyer', 'spec1', { delivery_date: '2026-11-01' }, T(4)), 'нельзя');
  throws('после первой спецификации договор не правится', () => D.updateContract(s3, 'buyer', { currency: 'EUR' }, T(4)), 'допсоглашением');
  ok('остаток лимита считается по всем спецификациям', D.summary(s3).left === 500000 - 34900);
}

group('График платежей 30/70');
{
  const s = withSpec('30_70');
  const pays = s.payments;
  ok('создано два платежа', pays.length === 2);
  ok('аванс 30% = 10470', pays[0].amount === 10470, String(pays[0].amount));
  ok('остаток 70% = 24430, сумма платежей = сумме спецификации', pays[1].amount === 24430 && pays[0].amount + pays[1].amount === 34900);
  ok('аванс сразу к оплате, остаток ждёт отгрузки', pays[0].status === 'AWAITING_PAYMENT' && pays[1].status === 'PENDING');
  ok('на аванс выставлен счёт', s.invoices.length === 1 && s.invoices[0].payment_id === pays[0].id);
  ok('срок аванса +3 дня от согласования', pays[0].due_at === '2026-10-07', pays[0].due_at);
  ok('реквизиты зафиксированы снимком', pays[0].bank_snapshot.iban === 'KZ11');
  const changed = JSON.parse(JSON.stringify(s)); changed.companies.supplier.iban = 'KZ99';
  ok('смена IBAN в профиле не меняет созданный платёж', changed.payments[0].bank_snapshot.iban === 'KZ11');
}

group('Оплата: роли и статусы');
{
  const s = withSpec('30_70');
  throws('поставщик не может отметить оплату за покупателя', () => D.markPaymentSent(s, 'supplier', 'pay1', { bank_reference: 'X' }, T(5)), 'Покупатель');
  throws('без банковского референса оплату не отметить', () => D.markPaymentSent(s, 'buyer', 'pay1', {}, T(5)), 'референс');
  throws('нельзя оплатить платёж, который ещё не к оплате', () => D.markPaymentSent(s, 'buyer', 'pay2', { bank_reference: 'X' }, T(5)), 'не ожидает');
  const s2 = D.markPaymentSent(s, 'buyer', 'pay1', { bank_reference: 'SWIFT-001' }, T(5));
  ok('после отметки — оплачено, ждёт подтверждения', s2.payments[0].status === 'PAID_UNCONFIRMED');
  throws('покупатель не может сам подтвердить поступление', () => D.confirmPayment(s2, 'buyer', 'pay1', T(5)), 'Поставщик');
  const s3 = D.confirmPayment(s2, 'supplier', 'pay1', T(6));
  ok('подтверждение → сверено со счётом', s3.payments[0].status === 'RECONCILED' && s3.invoices[0].status === 'PAID');
}

group('Отгрузка и CMR');
{
  const s = withSpec('30_70');
  throws('без аванса отгрузка запрещена', () => D.issueCMR(s, 'supplier', 'spec1', { vehicle: '123ABC02' }, T(5)), 'Аванс');
  let p = D.confirmPayment(D.markPaymentSent(s, 'buyer', 'pay1', { bank_reference: 'R1' }, T(5)), 'supplier', 'pay1', T(6));
  throws('без госномера CMR не выписать', () => D.issueCMR(p, 'supplier', 'spec1', {}, T(7)), 'госномер');
  throws('покупатель не выписывает CMR', () => D.issueCMR(p, 'buyer', 'spec1', { vehicle: 'A' }, T(7)), 'Поставщик');
  p = D.issueCMR(p, 'supplier', 'spec1', { vehicle: '123ABC02 / 45XY02' }, T(7));
  ok('CMR выписана, спецификация в пути', p.cmrs.length === 1 && p.specs[0].status === 'IN_DELIVERY');
  ok('CMR взяла товары из спецификации', p.cmrs[0].goods.length === 2 && p.cmrs[0].goods[0].qty === 10000);
  ok('отгрузка выставила счёт на остаток 70%', p.payments[1].status === 'AWAITING_PAYMENT' && p.invoices.length === 2);
  throws('повторно отгрузить ту же спецификацию нельзя', () => D.issueCMR(p, 'supplier', 'spec1', { vehicle: 'A' }, T(7)), 'согласована');
  p = D.confirmDelivery(p, 'buyer', 'cmr1', T(10));
  ok('получение подтверждено, но не исполнена: остаток не оплачен', p.specs[0].status === 'DELIVERED');
  p = D.confirmPayment(D.markPaymentSent(p, 'buyer', 'pay2', { bank_reference: 'R2' }, T(11)), 'supplier', 'pay2', T(12));
  ok('всё оплачено и получено → спецификация исполнена', p.specs[0].status === 'FULFILLED');
  ok('сводка: оплачено 34900, к оплате 0', D.summary(p).paid === 34900 && D.summary(p).awaiting === 0);
  ok('хронология записала каждое действие', p.events.length >= 15, String(p.events.length));
  ok('у каждого события есть время и актор', p.events.every(e => e.at && e.actor && e.type));
}

group('Эскроу');
{
  let s = withSpec('escrow');
  ok('один платёж 100%, метод ESCROW', s.payments.length === 1 && s.payments[0].method === 'ESCROW' && s.payments[0].amount === 34900);
  s = D.markPaymentSent(s, 'buyer', 'pay1', { bank_reference: 'ESC-1' }, T(5));
  ok('депонирование → на эскроу', s.payments[0].status === 'HELD_IN_ESCROW');
  throws('поставщик не может забрать средства с эскроу вручную', () => D.confirmPayment(s, 'supplier', 'pay1', T(6)), 'автоматически');
  s = D.issueCMR(s, 'supplier', 'spec1', { vehicle: 'A1' }, T(6));
  ok('отгрузка разрешена после депонирования', s.cmrs.length === 1);
  s = D.confirmDelivery(s, 'buyer', 'cmr1', T(9));
  ok('получение раскрывает эскроу и сверяет платёж', s.payments[0].status === 'RECONCILED');
  ok('спецификация исполнена', s.specs[0].status === 'FULFILLED');
  ok('событие ESCROW_RELEASED записано', s.events.some(e => e.type === 'ESCROW_RELEASED'));
}

group('Постоплата и аккредитив');
{
  let s = withSpec('net_30');
  ok('постоплата: до получения ничего не к оплате', s.payments[0].status === 'PENDING' && s.invoices.length === 0);
  s = D.issueCMR(s, 'supplier', 'spec1', { vehicle: 'A1' }, T(5));
  s = D.confirmDelivery(s, 'buyer', 'cmr1', T(8));
  ok('после получения счёт выставлен со сроком +30 дней', s.payments[0].status === 'AWAITING_PAYMENT' && s.payments[0].due_at === '2026-11-07', s.payments[0].due_at);
  let l = withSpec('lc');
  ok('аккредитив: отгрузка без аванса разрешена', D.shipmentBlockers(l, 'spec1').length === 0);
  l = D.issueCMR(l, 'supplier', 'spec1', { vehicle: 'A1' }, T(5));
  ok('аккредитив: раскрытие против документов после CMR', l.payments[0].status === 'AWAITING_PAYMENT' && l.payments[0].method === 'LC');
}

group('Подсказки «Ваш ход»');
{
  const s0 = D.createDeal(seed(), T(1));
  ok('обе стороны видят согласование договора', D.nextActions(s0, 'buyer')[0].kind === 'approve_contract');
  const s = withSpec('30_70');
  ok('покупатель видит оплату аванса', D.nextActions(s, 'buyer').some(a => a.kind === 'pay'));
  ok('поставщик не видит отгрузку до аванса', !D.nextActions(s, 'supplier').some(a => a.kind === 'ship'));
}

group('Документы');
{
  let s = withSpec('30_70');
  s = D.confirmPayment(D.markPaymentSent(s, 'buyer', 'pay1', { bank_reference: 'R1' }, T(5)), 'supplier', 'pay1', T(6));
  s = D.issueCMR(s, 'supplier', 'spec1', { vehicle: 'A1' }, T(7));
  const txt = bl => bl.map(b => (b.ru || '') + ' ' + (b.en || '') + (b.rows ? b.rows.flat().join(' ') : '')).join('\n');
  const spec = txt(D.specBlocks(s, 'spec1'));
  ok('спецификация: номер договора, итог, сумма прописью', spec.includes('TWH-2026-00001') && spec.includes('34') && spec.includes('Тридцать четыре тысячи девятьсот'));
  ok('спецификация в форме завода: 17 пунктов, упаковка, цена партии, реквизиты',
    ['1. Стороны', '5. Упаковка', '10. Цена партии', '15. Сопроводительные документы', '16. Платёжные реквизиты Продавца', '17. Платёжные реквизиты Покупателя'].every(k => spec.includes(k)));
  ok('несколько товаров → «продукция в ассортименте» и таблица', spec.includes('Продукция в ассортименте') && spec.includes('Печенье'));
  ok('сопроводительные документы из правил маршрута: вне ЕАЭС есть экспортная декларация', spec.includes('Экспортная декларация') && spec.includes('CMR'));
  const inv = txt(D.invoiceBlocks(s, 'inv1'));
  ok('счёт: реквизиты из снимка и референс платежа', inv.includes('KZ11') && inv.includes('PAY-0001'));
  const cmr = txt(D.cmrBlocks(s, 'cmr1'));
  ok('CMR: отправитель, получатель, товары, ссылка на спецификацию', cmr.includes('Алатау') && cmr.includes('Восток') && cmr.includes('Вафли') && cmr.includes('Спецификация №1'));
  ok('у каждого абзаца документов есть английский текст',
    [...D.specBlocks(s, 'spec1'), ...D.invoiceBlocks(s, 'inv1'), ...D.cmrBlocks(s, 'cmr1')].filter(b => b.type === 'p').every(b => b.en && b.en.length > 5));
}

console.log(`\n${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
