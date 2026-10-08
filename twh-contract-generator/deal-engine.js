/* TWH Deal Workspace — движок сделки (прототип v0.2).
 *
 * Сквозной поток из архитектуры TWH v0.1 (письмо Бекмырзы от 20.09.2026):
 *   рамочный договор → спецификация → счёт → оплата (Payment Digital Twin) → CMR → закрытие.
 * Всё считается из одной сделки: данные вводятся один раз и протекают в каждый следующий документ.
 *
 * Правила работы:
 *  - Каждое действие — команда (state, actor, args, now) → новый state. Исходный state не мутируется.
 *  - Недопустимый переход бросает DealError с понятным текстом. UI просто показывает его.
 *  - Каждое изменение пишет событие в state.events (audit by design).
 *  - Реквизиты фиксируются снимком (snapshot) в момент создания платежа и CMR.
 *  - TWH не принимает и не хранит деньги. Платёж — цифровой двойник внешнего банковского перевода.
 *
 * Без DOM. Работает в браузере и в Node (verify-deal.mjs).
 */

/* Всё внутри IIFE: в браузере скрипты делят одну глобальную область,
 * и одинаковые имена с engine.js (например, money) ломали бы загрузку. Наружу — только DEAL. */
(function () {
/* eslint-disable no-undef */
const DR = (typeof RULES !== 'undefined') ? RULES : require('./rules.js').RULES;
const DE = (typeof ENGINE !== 'undefined') ? ENGINE : require('./engine.js');

class DealError extends Error {}
const fail = msg => { throw new DealError(msg); };

const ACTORS = { supplier: 'Поставщик', buyer: 'Покупатель' };
const other = a => (a === 'supplier' ? 'buyer' : 'supplier');

/* ---------- графики платежей по пресетам оплаты ----------
 * trigger: когда платёж становится к оплате
 *   on_spec_agreed — сразу после согласования спецификации (аванс)
 *   on_shipment    — после выставления CMR (отгрузка)
 *   on_delivery    — после подтверждения получения
 * release_on: 'delivery' — средства "раскрываются" только после получения (эскроу)
 */
const SCHEDULES = {
  '30_70': [
    { pct: 30, trigger: 'on_spec_agreed', due_days: 3, purpose_ru: 'Аванс 30%', purpose_en: '30% advance' },
    { pct: 70, trigger: 'on_shipment', due_days: 5, purpose_ru: 'Окончательный платёж 70% после CMR', purpose_en: '70% balance against CMR' }
  ],
  '50_50': [
    { pct: 50, trigger: 'on_spec_agreed', due_days: 3, purpose_ru: 'Аванс 50%', purpose_en: '50% advance' },
    { pct: 50, trigger: 'on_shipment', due_days: 5, purpose_ru: 'Окончательный платёж 50% по CMR', purpose_en: '50% balance against CMR' }
  ],
  prepay_100: [
    { pct: 100, trigger: 'on_spec_agreed', due_days: 5, purpose_ru: '100% предоплата', purpose_en: '100% prepayment' }
  ],
  lc: [
    { pct: 100, trigger: 'on_shipment', due_days: 5, method: 'LC', purpose_ru: 'Аккредитив: раскрытие против документов', purpose_en: 'L/C: payment against documents' }
  ],
  net_30: [
    { pct: 100, trigger: 'on_delivery', due_days: 30, purpose_ru: 'Постоплата 100% через 30 дней', purpose_en: '100% net 30' }
  ],
  escrow: [
    { pct: 100, trigger: 'on_spec_agreed', due_days: 3, method: 'ESCROW', release_on: 'delivery', purpose_ru: 'Депонирование 100% (эскроу TWH)', purpose_en: '100% escrow deposit' }
  ]
};

const PAYMENT_STATUS_RU = {
  PENDING: 'Ещё не к оплате',
  AWAITING_PAYMENT: 'Ожидает оплаты',
  PAID_UNCONFIRMED: 'Оплачено, ждёт подтверждения',
  HELD_IN_ESCROW: 'На эскроу до получения товара',
  CONFIRMED: 'Подтверждено получателем',
  RECONCILED: 'Сверено со счётом',
  CANCELLED: 'Отменено'
};

const SPEC_STATUS_RU = {
  IN_REVIEW: 'На согласовании',
  AGREED: 'Согласована',
  IN_DELIVERY: 'В пути',
  DELIVERED: 'Доставлена',
  FULFILLED: 'Исполнена'
};

const CONTRACT_STATUS_RU = { IN_REVIEW: 'На согласовании', AGREED: 'Согласован обеими сторонами' };
const CMR_STATUS_RU = { ISSUED: 'Выписана, груз в пути', DELIVERED: 'Груз получен' };

/* ---------- утилиты ---------- */
const clone = o => JSON.parse(JSON.stringify(o));
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n, w) => String(n).padStart(w, '0');
const addDays = (iso, d) => {
  const t = new Date(iso); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10);
};
const day = iso => String(iso).slice(0, 10);

function log(s, actor, type, ref, text, now) {
  s.seq.evt += 1;
  s.events.push({ id: s.seq.evt, at: now, actor, type, ref, text });
}

function needRole(actor, allowed, action) {
  if (!ACTORS[actor]) fail('Неизвестная роль: ' + actor);
  if (!allowed.includes(actor)) fail(`${action}: это действие выполняет ${allowed.map(a => ACTORS[a]).join(' или ')}.`);
}

const specTotal = sp => round2(sp.items.reduce((a, it) => a + round2((Number(it.qty) || 0) * (Number(it.price) || 0)), 0));
const usedLimit = (s, exceptId) => round2(s.specs.filter(x => x.id !== exceptId).reduce((a, x) => a + specTotal(x), 0));

/* ---------- создание сделки ---------- */
function createDeal(seed, now) {
  const s = {
    v: 2,
    seq: { spec: 0, inv: 0, pay: 0, cmr: 0, evt: 0 },
    companies: clone(seed.companies),
    deal: {
      ref: seed.ref || 'TWH-D-000001',
      status: 'CONTRACTING',
      created_at: now,
      route: seed.route, incoterms: seed.incoterms, transport: seed.transport || 'road',
      currency: seed.currency || 'USD', category: seed.category || 'bakery',
      payment_preset: seed.payment_preset || '30_70', vat_mode: seed.vat_mode || 'export_0',
      frame_limit: round2(seed.frame_limit || 1000000),
      delivery_place: seed.delivery_place || ''
    },
    contract: {
      number: seed.contract_number || 'TWH-2026-00001',
      version: 1, status: 'IN_REVIEW',
      approvals: { supplier: null, buyer: null },
      terms: clone(seed.contract_terms || {})
    },
    specs: [], invoices: [], payments: [], cmrs: [], events: []
  };
  log(s, 'system', 'DEAL_CREATED', s.deal.ref, `Сделка ${s.deal.ref} создана, рамочный договор ${s.contract.number} на согласовании`, now);
  return s;
}

/* Поля для генератора договора (engine.js) из данных сделки. */
function contractFields(s) {
  const sup = s.companies.supplier, buy = s.companies.buyer, d = s.deal, t = s.contract.terms;
  const yr = String(s.contract.number).split('-')[1] || '2026';
  const seq = Number(String(s.contract.number).split('-')[2]) || 1;
  return {
    contract_year: yr, contract_seq: seq, date: day(s.deal.created_at), place: t.place || 'Алматы',
    supplier_name: sup.name, supplier_country: sup.country, supplier_reg: sup.reg, supplier_rep: sup.rep,
    supplier_basis: sup.basis || 'Устава', supplier_address: sup.address, supplier_bank: sup.bank,
    supplier_iban: sup.iban, supplier_swift: sup.swift,
    buyer_name: buy.name, buyer_country: buy.country, buyer_reg: buy.reg, buyer_rep: buy.rep,
    buyer_basis: buy.basis || 'Устава', buyer_address: buy.address, buyer_bank: buy.bank,
    buyer_iban: buy.iban, buyer_swift: buy.swift,
    category: d.category, goods_name: t.goods_name || 'Товар согласно Спецификациям к настоящему Договору',
    hs_code: t.hs_code || '', origin_country: sup.country,
    /* Рамочный договор: сумма = лимит, конкретика — в спецификациях. */
    quantity: 1, unit: 'рамочный лимит', unit_price: d.frame_limit,
    goods_specs: 'Ассортимент, количество, цена и сроки поставки определяются Спецификациями, являющимися неотъемлемой частью Договора.',
    currency: d.currency, vat_mode: d.vat_mode, payment_method: d.payment_preset === 'escrow' ? 'escrow' : (d.payment_preset === 'lc' ? 'lc' : 'wire'),
    payment_preset: d.payment_preset, route: d.route, transport: d.transport, incoterms: d.incoterms,
    delivery_place: d.delivery_place, delivery_date: t.delivery_date || '',
    shelf_life_value: t.shelf_life_value || 9, shelf_life_unit: 'months', min_remaining_pct: t.min_remaining_pct || 75,
    contains_animal_products: !!t.contains_animal_products
  };
}

/* ---------- договор ---------- */
const CONTRACT_EDITABLE = ['payment_preset', 'incoterms', 'currency', 'frame_limit', 'delivery_place', 'route'];

function updateContract(state, actor, patch, now) {
  needRole(actor, ['supplier', 'buyer'], 'Изменение договора');
  const s = clone(state);
  if (s.specs.length) fail('Договор уже действует: по нему есть спецификации. Изменения оформляются допсоглашением.');
  const changed = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!CONTRACT_EDITABLE.includes(k)) fail('Поле нельзя менять в прототипе: ' + k);
    const val = k === 'frame_limit' ? round2(v) : v;
    if (s.deal[k] !== val) { s.deal[k] = val; changed.push(k); }
  }
  if (!changed.length) return state;
  s.contract.version += 1;
  s.contract.status = 'IN_REVIEW';
  s.contract.approvals = { supplier: null, buyer: null };
  s.deal.status = 'CONTRACTING';
  log(s, actor, 'CONTRACT_UPDATED', s.contract.number,
    `${ACTORS[actor]} изменил договор (${changed.join(', ')}), версия ${s.contract.version}. Согласования сброшены.`, now);
  return s;
}

function approveContract(state, actor, now) {
  needRole(actor, ['supplier', 'buyer'], 'Согласование договора');
  const s = clone(state);
  if (s.contract.status === 'AGREED') fail('Договор уже согласован.');
  s.contract.approvals[actor] = s.contract.version;
  log(s, actor, 'CONTRACT_APPROVED', s.contract.number, `${ACTORS[actor]} согласовал версию ${s.contract.version} договора`, now);
  const a = s.contract.approvals;
  if (a.supplier === s.contract.version && a.buyer === s.contract.version) {
    s.contract.status = 'AGREED';
    s.deal.status = 'ACTIVE';
    log(s, 'system', 'CONTRACT_AGREED', s.contract.number, `Договор ${s.contract.number} согласован обеими сторонами`, now);
  }
  return s;
}

/* ---------- спецификации ---------- */
function validItems(items) {
  if (!Array.isArray(items) || !items.length) fail('В спецификации должна быть хотя бы одна позиция.');
  items.forEach((it, i) => {
    if (!String(it.name || '').trim()) fail(`Позиция ${i + 1}: укажите наименование.`);
    if (!(Number(it.qty) > 0)) fail(`Позиция ${i + 1}: количество должно быть больше нуля.`);
    if (!(Number(it.price) > 0)) fail(`Позиция ${i + 1}: цена должна быть больше нуля.`);
  });
  return items.map(it => ({ name: String(it.name).trim(), hs: it.hs || '', unit: it.unit || 'кг',
    qty: Number(it.qty), price: round2(it.price) }));
}

function createSpec(state, actor, args, now) {
  needRole(actor, ['supplier', 'buyer'], 'Создание спецификации');
  const s = clone(state);
  if (s.contract.status !== 'AGREED') fail('Сначала обе стороны должны согласовать рамочный договор.');
  const items = validItems(args.items);
  const total = round2(items.reduce((a, it) => a + it.qty * it.price, 0));
  const left = round2(s.deal.frame_limit - usedLimit(s));
  if (total > left) fail(`Сумма спецификации ${total.toLocaleString('ru-RU')} ${s.deal.currency} превышает остаток лимита договора ${left.toLocaleString('ru-RU')} ${s.deal.currency}.`);
  s.seq.spec += 1;
  const sp = {
    id: 'spec' + s.seq.spec, number: s.seq.spec, date: day(now), version: 1,
    status: 'IN_REVIEW', approvals: { supplier: null, buyer: null },
    items, delivery_date: args.delivery_date || addDays(now, 21),
    delivery_place: args.delivery_place || s.deal.delivery_place,
    created_by: actor
  };
  sp.approvals[actor] = 1; // автор согласен с тем, что создал
  s.specs.push(sp);
  log(s, actor, 'SPEC_CREATED', `Спецификация №${sp.number}`,
    `${ACTORS[actor]} создал спецификацию №${sp.number} на ${total.toLocaleString('ru-RU')} ${s.deal.currency}`, now);
  return s;
}

function updateSpec(state, actor, specId, patch, now) {
  needRole(actor, ['supplier', 'buyer'], 'Изменение спецификации');
  const s = clone(state);
  const sp = s.specs.find(x => x.id === specId) || fail('Спецификация не найдена.');
  if (sp.status !== 'IN_REVIEW') fail('Согласованную спецификацию нельзя менять. Создайте новую.');
  if (patch.items) {
    const items = validItems(patch.items);
    const total = round2(items.reduce((a, it) => a + it.qty * it.price, 0));
    const left = round2(s.deal.frame_limit - usedLimit(s, sp.id));
    if (total > left) fail(`Сумма спецификации превышает остаток лимита договора ${left.toLocaleString('ru-RU')} ${s.deal.currency}.`);
    sp.items = items;
  }
  if (patch.delivery_date) sp.delivery_date = patch.delivery_date;
  if (patch.delivery_place) sp.delivery_place = patch.delivery_place;
  sp.version += 1;
  sp.approvals = { supplier: null, buyer: null };
  sp.approvals[actor] = sp.version;
  log(s, actor, 'SPEC_UPDATED', `Спецификация №${sp.number}`,
    `${ACTORS[actor]} изменил спецификацию №${sp.number}, версия ${sp.version}. Согласование второй стороны сброшено.`, now);
  return s;
}

function approveSpec(state, actor, specId, now) {
  needRole(actor, ['supplier', 'buyer'], 'Согласование спецификации');
  let s = clone(state);
  const sp = s.specs.find(x => x.id === specId) || fail('Спецификация не найдена.');
  if (sp.status !== 'IN_REVIEW') fail('Спецификация уже согласована.');
  sp.approvals[actor] = sp.version;
  log(s, actor, 'SPEC_APPROVED', `Спецификация №${sp.number}`, `${ACTORS[actor]} согласовал спецификацию №${sp.number}`, now);
  if (sp.approvals.supplier === sp.version && sp.approvals.buyer === sp.version) {
    sp.status = 'AGREED';
    sp.agreed_at = now;
    log(s, 'system', 'SPEC_AGREED', `Спецификация №${sp.number}`, `Спецификация №${sp.number} согласована, сформирован график платежей`, now);
    s = buildPayments(s, sp.id, now);
    s = fireTrigger(s, sp.id, 'on_spec_agreed', now);
  }
  return s;
}

/* ---------- платежи и счета ---------- */
function buildPayments(s, specId, now) {
  const sp = s.specs.find(x => x.id === specId);
  const sched = SCHEDULES[s.deal.payment_preset] || SCHEDULES['30_70'];
  const total = specTotal(sp);
  const sup = s.companies.supplier;
  let allocated = 0;
  sched.forEach((m, i) => {
    s.seq.pay += 1;
    const last = i === sched.length - 1;
    const amount = last ? round2(total - allocated) : round2(total * m.pct / 100);
    allocated = round2(allocated + amount);
    s.payments.push({
      id: 'pay' + s.seq.pay, ref: 'PAY-' + pad(s.seq.pay, 4), spec_id: sp.id,
      pct: m.pct, amount, currency: s.deal.currency,
      purpose_ru: m.purpose_ru, purpose_en: m.purpose_en,
      method: m.method || 'BANK_TRANSFER', trigger: m.trigger, due_days: m.due_days,
      release_on: m.release_on || null,
      payer: 'buyer', payee: 'supplier',
      /* Снимок реквизитов: если поставщик потом сменит IBAN, этот платёж останется со старыми. */
      bank_snapshot: { beneficiary: sup.name, bank: sup.bank, iban: sup.iban, swift: sup.swift },
      status: 'PENDING', invoice_id: null,
      bank_reference: null, evidence_name: null,
      due_at: null, initiated_at: null, confirmed_at: null, reconciled_at: null
    });
  });
  return s;
}

function issueInvoice(s, pay, now) {
  s.seq.inv += 1;
  const yr = String(now).slice(0, 4);
  const inv = {
    id: 'inv' + s.seq.inv, number: `INV-${yr}-${pad(s.seq.inv, 4)}`, date: day(now),
    spec_id: pay.spec_id, payment_id: pay.id, amount: pay.amount, currency: pay.currency,
    purpose_ru: pay.purpose_ru, due: pay.due_at, status: 'ISSUED'
  };
  s.invoices.push(inv);
  pay.invoice_id = inv.id;
  return inv;
}

function fireTrigger(state, specId, trigger, now) {
  const s = state;
  const sp = s.specs.find(x => x.id === specId);
  s.payments.filter(p => p.spec_id === specId && p.trigger === trigger && p.status === 'PENDING').forEach(p => {
    p.status = 'AWAITING_PAYMENT';
    p.due_at = addDays(now, p.due_days);
    const inv = issueInvoice(s, p, now);
    log(s, 'system', 'INVOICE_ISSUED', inv.number,
      `Выставлен счёт ${inv.number} по спецификации №${sp.number}: ${p.purpose_ru}, ${p.amount.toLocaleString('ru-RU')} ${p.currency}, срок ${p.due_at}`, now);
  });
  return s;
}

function markPaymentSent(state, actor, payId, args, now) {
  needRole(actor, ['buyer'], 'Отметка об оплате');
  const s = clone(state);
  const p = s.payments.find(x => x.id === payId) || fail('Платёж не найден.');
  if (p.status !== 'AWAITING_PAYMENT') fail(`Платёж ${p.ref} сейчас не ожидает оплаты (${PAYMENT_STATUS_RU[p.status]}).`);
  const ref = String((args && args.bank_reference) || '').trim();
  if (!ref) fail('Укажите номер банковского платежа (референс SWIFT / платёжного поручения).');
  p.bank_reference = ref;
  p.evidence_name = (args && args.evidence_name) || null;
  p.initiated_at = now;
  p.status = p.release_on ? 'HELD_IN_ESCROW' : 'PAID_UNCONFIRMED';
  log(s, actor, 'PAYMENT_INITIATED', p.ref,
    p.release_on
      ? `Покупатель депонировал ${p.amount.toLocaleString('ru-RU')} ${p.currency} (реф. ${ref}). Средства будут раскрыты поставщику после подтверждения получения товара.`
      : `Покупатель отметил оплату ${p.amount.toLocaleString('ru-RU')} ${p.currency}, реф. ${ref}`, now);
  return s;
}

function reconcile(s, p, now) {
  const inv = s.invoices.find(x => x.id === p.invoice_id);
  p.status = 'RECONCILED';
  p.reconciled_at = now;
  if (inv) inv.status = 'PAID';
  log(s, 'system', 'PAYMENT_RECONCILED', p.ref, `Платёж ${p.ref} сверен со счётом ${inv ? inv.number : ''}, счёт закрыт`, now);
}

function confirmPayment(state, actor, payId, now) {
  needRole(actor, ['supplier'], 'Подтверждение поступления');
  let s = clone(state);
  const p = s.payments.find(x => x.id === payId) || fail('Платёж не найден.');
  if (p.status === 'HELD_IN_ESCROW') fail('Средства на эскроу раскрываются автоматически после подтверждения получения товара покупателем.');
  if (p.status !== 'PAID_UNCONFIRMED') fail(`Платёж ${p.ref} нельзя подтвердить: ${PAYMENT_STATUS_RU[p.status]}.`);
  p.status = 'CONFIRMED';
  p.confirmed_at = now;
  log(s, actor, 'PAYMENT_CONFIRMED', p.ref, `Поставщик подтвердил поступление ${p.amount.toLocaleString('ru-RU')} ${p.currency}`, now);
  reconcile(s, p, now);
  s = maybeFulfil(s, p.spec_id, now);
  return s;
}

/* ---------- отгрузка и CMR ---------- */
function shipmentBlockers(s, specId) {
  const sp = s.specs.find(x => x.id === specId);
  const out = [];
  if (!sp) return ['Спецификация не найдена.'];
  if (sp.status !== 'AGREED') out.push('Спецификация должна быть согласована и ещё не отгружена.');
  s.payments.filter(p => p.spec_id === specId && p.trigger === 'on_spec_agreed').forEach(p => {
    if (p.release_on && p.status !== 'HELD_IN_ESCROW') out.push(`Покупатель ещё не депонировал средства (${p.ref}).`);
    if (!p.release_on && p.status !== 'RECONCILED') out.push(`Аванс ${p.ref} ещё не поступил и не подтверждён.`);
  });
  return out;
}

function issueCMR(state, actor, specId, args, now) {
  needRole(actor, ['supplier'], 'Выписка CMR');
  let s = clone(state);
  const blockers = shipmentBlockers(s, specId);
  if (blockers.length) fail('Отгрузка невозможна: ' + blockers.join(' '));
  const sp = s.specs.find(x => x.id === specId);
  const vehicle = String((args && args.vehicle) || '').trim();
  if (!vehicle) fail('Укажите госномер тягача и прицепа.');
  const sup = s.companies.supplier, buy = s.companies.buyer;
  s.seq.cmr += 1;
  const cmr = {
    id: 'cmr' + s.seq.cmr, number: `CMR-${String(now).slice(0, 4)}-${pad(s.seq.cmr, 4)}`, date: day(now),
    spec_id: sp.id, status: 'ISSUED',
    sender: { name: sup.name, address: sup.address, country: sup.country },
    consignee: { name: buy.name, address: buy.address, country: buy.country },
    place_loading: sup.address, place_delivery: sp.delivery_place,
    carrier: (args && args.carrier) || '', vehicle,
    gross_weight: Number(args && args.gross_weight) || round2(sp.items.reduce((a, it) => a + (it.unit === 'кг' ? it.qty : 0), 0) * 1.08),
    goods: clone(sp.items), incoterms: s.deal.incoterms,
    signed_sender_at: now, signed_consignee_at: null
  };
  s.cmrs.push(cmr);
  sp.status = 'IN_DELIVERY';
  sp.cmr_id = cmr.id;
  log(s, actor, 'CMR_ISSUED', cmr.number, `Поставщик выписал ${cmr.number} по спецификации №${sp.number}, машина ${vehicle}. Груз в пути.`, now);
  s = fireTrigger(s, sp.id, 'on_shipment', now);
  return s;
}

function confirmDelivery(state, actor, cmrId, now) {
  needRole(actor, ['buyer'], 'Подтверждение получения');
  let s = clone(state);
  const cmr = s.cmrs.find(x => x.id === cmrId) || fail('CMR не найдена.');
  if (cmr.status !== 'ISSUED') fail('Получение по этой CMR уже подтверждено.');
  cmr.status = 'DELIVERED';
  cmr.signed_consignee_at = now;
  const sp = s.specs.find(x => x.id === cmr.spec_id);
  sp.status = 'DELIVERED';
  log(s, actor, 'DELIVERY_CONFIRMED', cmr.number, `Покупатель подписал ${cmr.number} в графе 24: товар получен`, now);
  /* Эскроу: получение товара раскрывает средства поставщику. */
  s.payments.filter(p => p.spec_id === sp.id && p.release_on === 'delivery' && p.status === 'HELD_IN_ESCROW').forEach(p => {
    p.status = 'CONFIRMED';
    p.confirmed_at = now;
    log(s, 'system', 'ESCROW_RELEASED', p.ref, `Условие эскроу выполнено, ${p.amount.toLocaleString('ru-RU')} ${p.currency} раскрыты поставщику`, now);
    reconcile(s, p, now);
  });
  s = fireTrigger(s, sp.id, 'on_delivery', now);
  s = maybeFulfil(s, sp.id, now);
  return s;
}

function maybeFulfil(s, specId, now) {
  const sp = s.specs.find(x => x.id === specId);
  if (!sp || sp.status !== 'DELIVERED') return s;
  const pays = s.payments.filter(p => p.spec_id === specId);
  if (pays.length && pays.every(p => p.status === 'RECONCILED')) {
    sp.status = 'FULFILLED';
    sp.fulfilled_at = now;
    log(s, 'system', 'SPEC_FULFILLED', `Спецификация №${sp.number}`,
      `Спецификация №${sp.number} исполнена полностью: товар получен, все платежи сверены`, now);
  }
  return s;
}

/* ---------- сводка и подсказка «что дальше» ---------- */
function summary(s) {
  const used = usedLimit(s);
  const paid = round2(s.payments.filter(p => p.status === 'RECONCILED').reduce((a, p) => a + p.amount, 0));
  const awaiting = round2(s.payments.filter(p => ['AWAITING_PAYMENT', 'PAID_UNCONFIRMED'].includes(p.status)).reduce((a, p) => a + p.amount, 0));
  const escrow = round2(s.payments.filter(p => p.status === 'HELD_IN_ESCROW').reduce((a, p) => a + p.amount, 0));
  return {
    limit: s.deal.frame_limit, used, left: round2(s.deal.frame_limit - used),
    paid, awaiting, escrow,
    specs: s.specs.length, fulfilled: s.specs.filter(x => x.status === 'FULFILLED').length
  };
}

/* Следующие действия для роли — то, что UI показывает кнопками «Ваш ход». */
function nextActions(s, actor) {
  const out = [];
  if (s.contract.status !== 'AGREED') {
    if (s.contract.approvals[actor] !== s.contract.version) out.push({ kind: 'approve_contract', text: `Согласовать договор (версия ${s.contract.version})` });
    else out.push({ kind: 'wait', text: `Ждём согласования договора от стороны «${ACTORS[other(actor)]}»` });
    return out;
  }
  s.specs.forEach(sp => {
    if (sp.status === 'IN_REVIEW' && sp.approvals[actor] !== sp.version)
      out.push({ kind: 'approve_spec', id: sp.id, text: `Согласовать спецификацию №${sp.number}` });
  });
  s.payments.forEach(p => {
    const sp = s.specs.find(x => x.id === p.spec_id);
    if (actor === 'buyer' && p.status === 'AWAITING_PAYMENT')
      out.push({ kind: 'pay', id: p.id, text: `Оплатить ${p.ref}: ${p.purpose_ru}, ${p.amount.toLocaleString('ru-RU')} ${p.currency} (спец. №${sp.number})` });
    if (actor === 'supplier' && p.status === 'PAID_UNCONFIRMED')
      out.push({ kind: 'confirm_payment', id: p.id, text: `Подтвердить поступление ${p.ref}, ${p.amount.toLocaleString('ru-RU')} ${p.currency}` });
  });
  if (actor === 'supplier') s.specs.forEach(sp => {
    if (sp.status === 'AGREED' && !shipmentBlockers(s, sp.id).length)
      out.push({ kind: 'ship', id: sp.id, text: `Отгрузить по спецификации №${sp.number} и выписать CMR` });
  });
  if (actor === 'buyer') s.cmrs.forEach(c => {
    if (c.status === 'ISSUED') out.push({ kind: 'deliver', id: c.id, text: `Подтвердить получение груза по ${c.number}` });
  });
  return out;
}

/* ---------- документы (блоки для docx.js и превью) ---------- */
const money = (v, cur) => (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (cur || '');

function specBlocks(s, specId) {
  const sp = s.specs.find(x => x.id === specId);
  const cur = s.deal.currency, total = specTotal(sp);
  const words = DE.amountInWords(total, cur);
  const preset = DR.payment_presets.find(p => p.id === s.deal.payment_preset) || DR.payment_presets[0];
  const b = [];
  b.push({ type: 'title', ru: `СПЕЦИФИКАЦИЯ № ${sp.number}`, en: `SPECIFICATION No. ${sp.number}` });
  b.push({ type: 'p', ru: `к Договору поставки № ${s.contract.number} от ${DE.formatDate(day(s.deal.created_at), 'ru')}. Дата спецификации: ${DE.formatDate(sp.date, 'ru')}.`,
    en: `to Supply Contract No. ${s.contract.number} dated ${DE.formatDate(day(s.deal.created_at), 'en')}. Specification date: ${DE.formatDate(sp.date, 'en')}.` });
  b.push({ type: 'p', ru: `Поставщик: ${s.companies.supplier.name}. Покупатель: ${s.companies.buyer.name}.`,
    en: `Supplier: ${s.companies.supplier.name}. Buyer: ${s.companies.buyer.name}.` });
  b.push({ type: 'table', rows: [
    ['№', 'Наименование / Description', 'ТН ВЭД / HS', 'Ед. / Unit', 'Кол-во / Qty', 'Цена / Price', 'Сумма / Amount'],
    ...sp.items.map((it, i) => [String(i + 1), it.name, it.hs, it.unit, String(it.qty), money(it.price, cur), money(it.qty * it.price, cur)]),
    ['', 'ИТОГО / TOTAL', '', '', '', '', money(total, cur)]
  ] });
  b.push({ type: 'p', ru: `Общая сумма: ${money(total, cur)} (${words.ru}).`, en: `Total: ${money(total, cur)} (${words.en}).` });
  b.push({ type: 'p', ru: `Условия поставки: ${s.deal.incoterms} (Incoterms® 2020), ${sp.delivery_place}. Срок поставки: до ${DE.formatDate(sp.delivery_date, 'ru')}.`,
    en: `Delivery: ${s.deal.incoterms} (Incoterms® 2020), ${sp.delivery_place}. Delivery date: by ${DE.formatDate(sp.delivery_date, 'en')}.` });
  b.push({ type: 'p', ru: `Условия оплаты: ${preset.ru}`, en: `Payment terms: ${preset.en}` });
  b.push({ type: 'p', ru: `Остаток лимита по Договору после настоящей Спецификации: ${money(s.deal.frame_limit - usedLimit(s), cur)}.`,
    en: `Remaining contract limit after this Specification: ${money(s.deal.frame_limit - usedLimit(s), cur)}.` });
  b.push({ type: 'table', rows: [
    ['ПОСТАВЩИК / SUPPLIER', 'ПОКУПАТЕЛЬ / BUYER'],
    [s.companies.supplier.name, s.companies.buyer.name],
    [sp.approvals.supplier === sp.version ? 'Согласовано в TWH' : '______________', sp.approvals.buyer === sp.version ? 'Согласовано в TWH' : '______________']
  ] });
  return b;
}

function invoiceBlocks(s, invId) {
  const inv = s.invoices.find(x => x.id === invId);
  const p = s.payments.find(x => x.id === inv.payment_id);
  const sp = s.specs.find(x => x.id === inv.spec_id);
  const words = DE.amountInWords(inv.amount, inv.currency);
  const bank = p.bank_snapshot;
  return [
    { type: 'title', ru: `СЧЁТ НА ОПЛАТУ № ${inv.number}`, en: `INVOICE No. ${inv.number}` },
    { type: 'p', ru: `Дата: ${DE.formatDate(inv.date, 'ru')}. Срок оплаты: ${DE.formatDate(inv.due, 'ru')}.`, en: `Date: ${DE.formatDate(inv.date, 'en')}. Due: ${DE.formatDate(inv.due, 'en')}.` },
    { type: 'table', rows: [
      ['Продавец / Seller', `${s.companies.supplier.name}, ${s.companies.supplier.address}, ${s.companies.supplier.reg}`],
      ['Покупатель / Buyer', `${s.companies.buyer.name}, ${s.companies.buyer.address}, ${s.companies.buyer.reg}`],
      ['Основание / Basis', `Договор ${s.contract.number}, Спецификация №${sp.number}`],
      ['Назначение / Purpose', `${p.purpose_ru} / ${p.purpose_en}`]
    ] },
    { type: 'table', rows: [
      ['Позиция / Item', 'Кол-во / Qty', 'Цена / Price', 'Сумма / Amount'],
      ...sp.items.map(it => [it.name, `${it.qty} ${it.unit}`, money(it.price, inv.currency), money(it.qty * it.price, inv.currency)]),
      ['Итого по спецификации / Specification total', '', '', money(specTotal(sp), inv.currency)],
      [`К оплате по счёту (${p.pct}%) / Amount due (${p.pct}%)`, '', '', money(inv.amount, inv.currency)]
    ] },
    { type: 'p', ru: `К оплате: ${money(inv.amount, inv.currency)} (${words.ru}). ${(DR.vat_modes.find(v => v.id === s.deal.vat_mode) || {}).ru || ''}.`,
      en: `Amount due: ${money(inv.amount, inv.currency)} (${words.en}).` },
    { type: 'table', rows: [
      ['Банковские реквизиты получателя / Beneficiary bank details', ''],
      ['Получатель / Beneficiary', bank.beneficiary],
      ['Банк / Bank', bank.bank],
      ['IBAN', bank.iban],
      ['SWIFT/BIC', bank.swift],
      ['Референс платежа / Payment reference', `${inv.number} / ${p.ref}`]
    ] }
  ];
}

function cmrBlocks(s, cmrId) {
  const c = s.cmrs.find(x => x.id === cmrId);
  const sp = s.specs.find(x => x.id === c.spec_id);
  return [
    { type: 'title', ru: `МЕЖДУНАРОДНАЯ ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ CMR № ${c.number}`, en: `INTERNATIONAL CONSIGNMENT NOTE CMR No. ${c.number}` },
    { type: 'p', ru: 'Перевозка осуществляется в соответствии с Конвенцией о договоре международной дорожной перевозки грузов (КДПГ/CMR, Женева, 1956).',
      en: 'This carriage is subject to the Convention on the Contract for the International Carriage of Goods by Road (CMR, Geneva 1956).' },
    { type: 'table', rows: [
      ['1. Отправитель / Sender', `${c.sender.name}, ${c.sender.address}, ${c.sender.country}`],
      ['2. Получатель / Consignee', `${c.consignee.name}, ${c.consignee.address}, ${c.consignee.country}`],
      ['3. Место разгрузки / Place of delivery', c.place_delivery],
      ['4. Место и дата погрузки / Place and date of loading', `${c.place_loading}, ${DE.formatDate(c.date, 'ru')}`],
      ['5. Прилагаемые документы / Documents attached', `Договор ${s.contract.number}, Спецификация №${sp.number}, инвойс, упаковочный лист, декларация ЕАЭС`],
      ['16. Перевозчик / Carrier', c.carrier || '______________'],
      ['Тягач / прицеп / Vehicle', c.vehicle],
      ['Условия поставки / Incoterms', c.incoterms]
    ] },
    { type: 'table', rows: [
      ['6–9. Наименование груза / Goods', 'ТН ВЭД / HS', 'Кол-во / Qty', 'Ед. / Unit'],
      ...c.goods.map(g => [g.name, g.hs, String(g.qty), g.unit]),
      ['11. Вес брутто, кг / Gross weight, kg', '', String(c.gross_weight), 'кг']
    ] },
    { type: 'table', rows: [
      ['22. Подпись отправителя / Sender', '23. Подпись перевозчика / Carrier', '24. Груз получен / Goods received'],
      [`Подписано в TWH ${DE.formatDate(day(c.signed_sender_at), 'ru')}`, '______________',
        c.signed_consignee_at ? `Подписано в TWH ${DE.formatDate(day(c.signed_consignee_at), 'ru')}` : '______________']
    ] }
  ];
}

const DEAL = {
  DealError, ACTORS, SCHEDULES, PAYMENT_STATUS_RU, SPEC_STATUS_RU, CONTRACT_STATUS_RU, CMR_STATUS_RU,
  createDeal, contractFields, updateContract, approveContract,
  createSpec, updateSpec, approveSpec,
  markPaymentSent, confirmPayment, issueCMR, confirmDelivery,
  shipmentBlockers, summary, nextActions, specTotal,
  specBlocks, invoiceBlocks, cmrBlocks
};
if (typeof module !== 'undefined' && module.exports) module.exports = DEAL;
if (typeof globalThis !== 'undefined') globalThis.DEAL = DEAL;
})();
