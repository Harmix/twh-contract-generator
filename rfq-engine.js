/* TWH — каталог и RFQ (прототип v0.3).
 *
 * Запрос Бекмырзы от 12.10.2026: завод выкладывает товары с описанием, покупатель выбирает
 * конкретный товар (наименование, цена, качество, количество) и отправляет RFQ. Данные RFQ
 * дальше сами текут в договор, спецификацию, счёт и CMR. Без этого платформа — просто
 * «автоматизированный курьер документов».
 *
 * Поля RFQ — по его списку: Product, Quantity, Specification, Origin, Destination, Incoterm,
 * Currency, Payment Terms, Delivery Terms, Documents, Compliance Attributes, Offer Deadline.
 *
 * Поток: товар в каталоге → RFQ → предложение поставщика → принятие → сделка (deal-engine.js).
 * После согласования договора спецификация №1 создаётся из принятого предложения автоматически:
 * количество и цены стороны уже согласовали в RFQ и предложении, вводить их повторно не нужно.
 *
 * Те же правила, что и в deal-engine.js: команды без мутаций, понятные ошибки, журнал событий.
 */
(function () {
/* eslint-disable no-undef */
const MR = (typeof RULES !== 'undefined') ? RULES : require('./rules.js').RULES;
const ME = (typeof ENGINE !== 'undefined') ? ENGINE : require('./engine.js');
const MD = (typeof DEAL !== 'undefined') ? DEAL : require('./deal-engine.js');

const DealError = MD.DealError;
const fail = msg => { throw new DealError(msg); };
const ACTORS = MD.ACTORS;
const clone = o => JSON.parse(JSON.stringify(o));
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const day = iso => String(iso).slice(0, 10);
const pad = (n, w) => String(n).padStart(w, '0');
const addDays = (iso, d) => { const t = new Date(iso); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const fmt = n => Number(n).toLocaleString('ru-RU');

const RFQ_STATUS_RU = { SENT: 'Отправлен поставщику', OFFERED: 'Получено предложение', ACCEPTED: 'Принят, создана сделка', DECLINED: 'Отклонён поставщиком', CLOSED: 'Закрыт покупателем' };
const OFFER_STATUS_RU = { SUBMITTED: 'На рассмотрении', ACCEPTED: 'Принято', REJECTED: 'Отклонено', SUPERSEDED: 'Заменено новым' };

/* Атрибуты соответствия, которые покупатель может потребовать в RFQ. */
const COMPLIANCE = [
  { id: 'eaeu_decl', ru: 'Декларация о соответствии ЕАЭС (ТР ТС 021/2011)' },
  { id: 'quality_cert', ru: 'Удостоверение качества и безопасности' },
  { id: 'halal', ru: 'Сертификат Халал' },
  { id: 'shelf_75', ru: 'Остаточный срок годности не менее 75% при отгрузке' },
  { id: 'gost', ru: 'Соответствие ГОСТ / СТ РК, указанному в карточке товара' },
  { id: 'iso22000', ru: 'Система менеджмента безопасности пищевой продукции ISO 22000 / FSSC 22000' }
];

function log(w, actor, type, ref, text, now) {
  w.seq.evt += 1;
  w.events.push({ id: 'm' + w.seq.evt, at: now, actor, type, ref, text });
}
function needRole(actor, allowed, action) {
  if (!ACTORS[actor]) fail('Неизвестная роль: ' + actor);
  if (!allowed.includes(actor)) fail(`${action}: это действие выполняет ${allowed.map(a => ACTORS[a]).join(' или ')}.`);
}

/* ---------- рабочее пространство ---------- */
function createWorkspace(seed, now) {
  const w = {
    v: 3,
    seq: { prod: 0, rfq: 0, offer: 0, evt: 0 },
    companies: clone(seed.companies),
    catalog: [], rfqs: [], offers: [], deal: null, events: []
  };
  (seed.catalog || []).forEach(p => addProductRaw(w, p));
  log(w, 'system', 'WORKSPACE_CREATED', 'TWH', `Каталог поставщика опубликован: ${w.catalog.length} товаров`, now);
  return w;
}

function validProduct(p) {
  if (!String(p.name || '').trim()) fail('У товара должно быть наименование.');
  if (!(Number(p.price) > 0)) fail('Укажите цену товара.');
  if (!String(p.unit || '').trim()) fail('Укажите единицу измерения.');
  return {
    name: String(p.name).trim(), description: p.description || '', hs: p.hs || '',
    origin: p.origin || 'Казахстан', unit: p.unit, price: round2(p.price), currency: p.currency || 'USD',
    moq: Number(p.moq) || 0, packaging: p.packaging || 'Гофротара (картон)',
    shelf_life_months: Number(p.shelf_life_months) || null, standard: p.standard || '',
    compliance: Array.isArray(p.compliance) ? p.compliance.slice() : []
  };
}
function addProductRaw(w, p) {
  w.seq.prod += 1;
  w.catalog.push({ id: 'prod' + w.seq.prod, sku: 'SKU-' + pad(w.seq.prod, 3), ...validProduct(p), published: true });
  return w;
}
function addProduct(state, actor, p, now) {
  needRole(actor, ['supplier'], 'Добавление товара в каталог');
  const w = addProductRaw(clone(state), p);
  const prod = w.catalog[w.catalog.length - 1];
  log(w, actor, 'PRODUCT_PUBLISHED', prod.sku, `Поставщик опубликовал товар «${prod.name}», ${prod.price} ${prod.currency}/${prod.unit}`, now);
  return w;
}

/* ---------- RFQ ---------- */
/* Документы по умолчанию — из тех же правил, что и в генераторе договора. */
function defaultDocuments(w, route, incoterms, category) {
  const d = ME.derive({ route, incoterms, category: category || 'bakery', transport: 'road', vat_mode: 'export_0', currency: 'USD', quantity: 1, unit_price: 1 });
  const docs = d.documents.map(x => x.ru);
  if (!d.route.eaeu) docs.push('Экспортная декларация');
  return docs;
}

function createRFQ(state, actor, args, now) {
  needRole(actor, ['buyer'], 'Отправка RFQ');
  const w = clone(state);
  if (w.deal) fail('В демо одна сделка. Сбросьте демо, чтобы начать новый RFQ.');
  if (w.rfqs.some(r => ['SENT', 'OFFERED'].includes(r.status))) fail('У вас уже есть открытый RFQ. Дождитесь предложения или закройте его.');
  const lines = (args.items || []).filter(i => Number(i.qty) > 0);
  if (!lines.length) fail('Выберите хотя бы один товар и укажите количество.');
  const items = lines.map(l => {
    const p = w.catalog.find(x => x.id === l.product_id) || fail('Товар не найден в каталоге.');
    if (p.moq && Number(l.qty) < p.moq) fail(`«${p.name}»: минимальная партия ${fmt(p.moq)} ${p.unit}.`);
    return {
      product_id: p.id, sku: p.sku, name: p.name, hs: p.hs, unit: p.unit, origin: p.origin,
      packaging: p.packaging, standard: p.standard, list_price: p.price,
      qty: Number(l.qty), target_price: Number(l.target_price) || null,
      specification: String(l.specification || '').trim()
    };
  });
  const route = args.route || 'UZ';
  if (!MR.routes[route]) fail('Неизвестное направление поставки.');
  const incoterms = args.incoterms || 'DAP';
  if (!MR.incoterms[incoterms]) fail('Неизвестный Incoterms.');
  if (!String(args.delivery_place || '').trim()) fail('Укажите место поставки (Destination).');
  const deadline = args.offer_deadline || addDays(now, 3);
  if (deadline < day(now)) fail('Срок для предложений уже прошёл. Укажите дату в будущем.');
  const delivery = args.delivery_date || addDays(now, 30);
  if (delivery <= deadline) fail('Срок поставки должен быть позже срока подачи предложений.');
  w.seq.rfq += 1;
  const rfq = {
    id: 'rfq' + w.seq.rfq, ref: `RFQ-${String(now).slice(0, 4)}-${pad(w.seq.rfq, 4)}`, created_at: now,
    status: 'SENT', buyer: 'buyer', supplier: 'supplier',
    items,
    origin: [...new Set(items.map(i => i.origin))].join(', '),
    route, destination_country: MR.routes[route].name_ru, delivery_place: String(args.delivery_place).trim(),
    incoterms, currency: args.currency || 'USD', payment_preset: args.payment_preset || '30_70',
    delivery_date: delivery, transport: 'road',
    documents: Array.isArray(args.documents) && args.documents.length ? args.documents : defaultDocuments(w, route, incoterms),
    compliance: Array.isArray(args.compliance) ? args.compliance.slice() : [],
    offer_deadline: deadline,
    note: String(args.note || '').trim()
  };
  w.rfqs.push(rfq);
  log(w, actor, 'RFQ_SENT', rfq.ref,
    `Покупатель отправил ${rfq.ref}: ${items.map(i => `${i.name} — ${fmt(i.qty)} ${i.unit}`).join('; ')}. ${incoterms} ${rfq.delivery_place}, предложения до ${deadline}`, now);
  return w;
}

function closeRFQ(state, actor, rfqId, now) {
  needRole(actor, ['buyer'], 'Закрытие RFQ');
  const w = clone(state);
  const r = w.rfqs.find(x => x.id === rfqId) || fail('RFQ не найден.');
  if (!['SENT', 'OFFERED'].includes(r.status)) fail('Этот RFQ уже закрыт.');
  r.status = 'CLOSED';
  w.offers.filter(o => o.rfq_id === r.id && o.status === 'SUBMITTED').forEach(o => { o.status = 'REJECTED'; });
  log(w, actor, 'RFQ_CLOSED', r.ref, `Покупатель закрыл ${r.ref}`, now);
  return w;
}

function declineRFQ(state, actor, rfqId, reason, now) {
  needRole(actor, ['supplier'], 'Отказ от RFQ');
  const w = clone(state);
  const r = w.rfqs.find(x => x.id === rfqId) || fail('RFQ не найден.');
  if (r.status !== 'SENT') fail('Отклонить можно только RFQ без предложения.');
  const why = String(reason || '').trim();
  if (!why) fail('Укажите причину отказа, покупателю это важно.');
  r.status = 'DECLINED';
  r.decline_reason = why;
  log(w, actor, 'RFQ_DECLINED', r.ref, `Поставщик отклонил ${r.ref}: ${why}`, now);
  return w;
}

/* ---------- предложение поставщика ---------- */
const offerTotal = (rfq, o) => round2(rfq.items.reduce((a, it, i) => a + it.qty * (Number(o.prices[i]) || 0), 0));

function submitOffer(state, actor, rfqId, args, now) {
  needRole(actor, ['supplier'], 'Предложение по RFQ');
  const w = clone(state);
  const r = w.rfqs.find(x => x.id === rfqId) || fail('RFQ не найден.');
  if (!['SENT', 'OFFERED'].includes(r.status)) fail(`${r.ref} уже не принимает предложения (${RFQ_STATUS_RU[r.status]}).`);
  if (day(now) > r.offer_deadline) fail(`Срок подачи предложений по ${r.ref} истёк ${r.offer_deadline}.`);
  const prices = r.items.map((it, i) => {
    const p = round2(args && args.prices ? args.prices[i] : it.list_price);
    if (!(p > 0)) fail(`Укажите цену для «${it.name}».`);
    return p;
  });
  const lead = Number(args && args.lead_time_days);
  if (!(lead > 0)) fail('Укажите срок изготовления и отгрузки в днях.');
  const shipBy = addDays(now, lead);
  w.offers.filter(o => o.rfq_id === r.id && o.status === 'SUBMITTED').forEach(o => { o.status = 'SUPERSEDED'; });
  w.seq.offer += 1;
  const o = {
    id: 'off' + w.seq.offer, ref: `OFF-${pad(w.seq.offer, 4)}`, rfq_id: r.id, created_at: now,
    status: 'SUBMITTED', prices, lead_time_days: lead, ship_by: shipBy,
    valid_until: (args && args.valid_until) || addDays(now, 7),
    meets_delivery: shipBy <= r.delivery_date,
    compliance_confirmed: Array.isArray(args && args.compliance_confirmed) ? args.compliance_confirmed : r.compliance.slice(),
    note: String((args && args.note) || '').trim()
  };
  o.total = offerTotal(r, o);
  w.offers.push(o);
  r.status = 'OFFERED';
  log(w, actor, 'OFFER_SUBMITTED', o.ref,
    `Поставщик предложил ${fmt(o.total)} ${r.currency} по ${r.ref}, отгрузка за ${lead} дн. (до ${shipBy})${o.meets_delivery ? '' : ' — позже запрошенного срока'}`, now);
  return w;
}

function rejectOffer(state, actor, offerId, now) {
  needRole(actor, ['buyer'], 'Отклонение предложения');
  const w = clone(state);
  const o = w.offers.find(x => x.id === offerId) || fail('Предложение не найдено.');
  if (o.status !== 'SUBMITTED') fail('Это предложение уже не на рассмотрении.');
  o.status = 'REJECTED';
  const r = w.rfqs.find(x => x.id === o.rfq_id);
  r.status = 'SENT';
  log(w, actor, 'OFFER_REJECTED', o.ref, `Покупатель отклонил ${o.ref}. ${r.ref} снова открыт для предложения`, now);
  return w;
}

/* Принятие предложения создаёт сделку. Всё, что согласовано, переносится без повторного ввода. */
function acceptOffer(state, actor, offerId, now) {
  needRole(actor, ['buyer'], 'Принятие предложения');
  const w = clone(state);
  const o = w.offers.find(x => x.id === offerId) || fail('Предложение не найдено.');
  if (o.status !== 'SUBMITTED') fail('Это предложение уже не на рассмотрении.');
  if (day(now) > o.valid_until) fail(`Предложение ${o.ref} действовало до ${o.valid_until}. Попросите поставщика обновить его.`);
  const r = w.rfqs.find(x => x.id === o.rfq_id);
  if (w.deal) fail('Сделка уже создана.');
  o.status = 'ACCEPTED';
  r.status = 'ACCEPTED';
  w.offers.filter(x => x.rfq_id === r.id && x.id !== o.id && x.status === 'SUBMITTED').forEach(x => { x.status = 'REJECTED'; });

  const items = r.items.map((it, i) => ({ name: it.name, hs: it.hs, unit: it.unit, qty: it.qty, price: o.prices[i] }));
  const products = r.items.map(it => w.catalog.find(p => p.id === it.product_id)).filter(Boolean);
  const shelf = Math.min(...products.map(p => p.shelf_life_months || 99));
  const seed = {
    ref: 'TWH-D-' + pad(Number(String(r.ref).slice(-4)), 6),
    route: r.route, incoterms: r.incoterms, transport: r.transport, currency: r.currency,
    category: 'bakery', payment_preset: r.payment_preset, vat_mode: 'export_0',
    frame_limit: o.total, delivery_place: r.delivery_place,
    contract_number: `TWH-${String(now).slice(0, 4)}-${pad(w.seq.rfq, 5)}`,
    contract_terms: {
      place: 'Алматы', goods_name: r.items.map(i => i.name).join('; '),
      hs_code: [...new Set(r.items.map(i => i.hs).filter(Boolean))].join(', '),
      lot_unit: 'партия согласно Спецификации №1',
      shelf_life_value: shelf < 99 ? shelf : 9, min_remaining_pct: 75,
      delivery_date: r.delivery_date
    },
    companies: w.companies
  };
  let deal = MD.createDeal(seed, now);
  deal.origin = {
    rfq_id: r.id, rfq_ref: r.ref, offer_id: o.id, offer_ref: o.ref,
    pending_spec: { items, delivery_date: r.delivery_date, delivery_place: r.delivery_place,
      packaging: [...new Set(r.items.map(i => i.packaging))].join('; '),
      other_terms: [r.compliance.length ? 'Требования покупателя: ' + r.compliance.map(c => (COMPLIANCE.find(x => x.id === c) || { ru: c }).ru).join('; ') : '',
        r.items.some(i => i.specification) ? 'Спецификация товара: ' + r.items.filter(i => i.specification).map(i => `${i.name}: ${i.specification}`).join('; ') : '']
        .filter(Boolean).join('. ') }
  };
  w.deal = deal;
  log(w, actor, 'OFFER_ACCEPTED', o.ref,
    `Покупатель принял ${o.ref} на ${fmt(o.total)} ${r.currency}. Создана сделка ${deal.deal.ref}, договор ${deal.contract.number} собран из RFQ и предложения`, now);
  return w;
}

/* ---------- обёртки над командами сделки ---------- */
function dealCmd(state, fn) {
  if (!state.deal) fail('Сделки ещё нет: сначала покупатель принимает предложение по RFQ.');
  const w = clone(state);
  w.deal = fn(w.deal);
  return w;
}

/* После согласования договора спецификация №1 появляется из принятого предложения,
 * сразу согласованной обеими сторонами: количество и цены они уже согласовали. */
function approveContract(state, actor, now) {
  let w = dealCmd(state, d => MD.approveContract(d, actor, now));
  const d = w.deal;
  if (d.contract.status === 'AGREED' && d.origin && d.origin.pending_spec && !d.specs.length) {
    const ps = d.origin.pending_spec;
    let nd = MD.createSpec(d, 'supplier', ps, now);
    nd = MD.approveSpec(nd, 'buyer', nd.specs[0].id, now);
    nd.events.push({ id: 'auto1', at: now, actor: 'system', type: 'SPEC_FROM_OFFER', ref: 'Спецификация №1',
      text: `Спецификация №1 создана автоматически из ${d.origin.rfq_ref} и ${d.origin.offer_ref}: товары, количество, цены и сроки перенесены без повторного ввода` });
    nd.origin.pending_spec = null;
    w.deal = nd;
  }
  return w;
}

/* ---------- откуда взялось каждое поле договора ---------- */
function contractSources(w) {
  if (!w.deal || !w.deal.origin) return [];
  const r = w.rfqs.find(x => x.id === w.deal.origin.rfq_id);
  const o = w.offers.find(x => x.id === w.deal.origin.offer_id);
  const cur = r.currency;
  return [
    ['Товары и коды ТН ВЭД', r.items.map(i => `${i.name} (${i.hs})`).join('; '), 'Каталог поставщика → RFQ'],
    ['Количество', r.items.map(i => `${fmt(i.qty)} ${i.unit}`).join('; '), r.ref],
    ['Происхождение', r.origin, 'Каталог поставщика'],
    ['Цены', r.items.map((i, k) => `${fmt(o.prices[k])} ${cur}/${i.unit}`).join('; '), o.ref],
    ['Сумма договора', `${fmt(o.total)} ${cur}`, o.ref],
    ['Срок отгрузки', `${o.lead_time_days} дн., до ${o.ship_by}`, o.ref],
    ['Incoterms и место поставки', `${r.incoterms}, ${r.delivery_place}`, r.ref],
    ['Направление, право и арбитраж', `${r.destination_country}: правила маршрута`, r.ref + ' → правила TWH'],
    ['Валюта и условия оплаты', `${cur}, ${(MR.payment_presets.find(p => p.id === r.payment_preset) || {}).label}`, r.ref],
    ['Документы к отгрузке', r.documents.join('; '), r.ref + ' → правила TWH'],
    ['Требования к качеству', r.compliance.map(c => (COMPLIANCE.find(x => x.id === c) || { ru: c }).ru).join('; ') || '—', r.ref],
    ['Срок годности', `${w.deal.contract.terms.shelf_life_value} мес. (минимальный по товарам), остаток не менее 75%`, 'Каталог поставщика'],
    ['Реквизиты сторон', `${w.companies.supplier.name}; ${w.companies.buyer.name}`, 'Профили компаний']
  ];
}

/* ---------- «Ваш ход» и сводная хронология ---------- */
function nextActions(w, actor) {
  if (w.deal) {
    return MD.nextActions(w.deal, actor);
  }
  const out = [];
  const open = w.rfqs.find(r => ['SENT', 'OFFERED'].includes(r.status));
  if (actor === 'buyer') {
    if (!open) out.push({ kind: 'goto_catalog', text: 'Выберите товары в каталоге поставщика и отправьте RFQ' });
    const offer = open && w.offers.find(o => o.rfq_id === open.id && o.status === 'SUBMITTED');
    if (offer) out.push({ kind: 'review_offer', id: offer.id, text: `Рассмотреть предложение ${offer.ref} по ${open.ref}: ${fmt(offer.total)} ${open.currency}` });
    else if (open) out.push({ kind: 'wait', text: `Ждём предложения поставщика по ${open.ref} (до ${open.offer_deadline})` });
  } else {
    if (open && open.status === 'SENT') out.push({ kind: 'answer_rfq', id: open.id, text: `Ответить на ${open.ref}: ${open.items.length} поз., поставка до ${open.delivery_date}` });
    else if (open) out.push({ kind: 'wait', text: `Ждём решения покупателя по предложению на ${open.ref}` });
    else out.push({ kind: 'wait', text: 'Новых запросов нет. Каталог опубликован, покупатели видят товары.' });
  }
  return out;
}

function timeline(w) {
  return [...w.events, ...((w.deal && w.deal.events) || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)) || 0);
}

const MARKET = {
  RFQ_STATUS_RU, OFFER_STATUS_RU, COMPLIANCE,
  createWorkspace, addProduct, createRFQ, closeRFQ, declineRFQ,
  submitOffer, rejectOffer, acceptOffer, offerTotal, defaultDocuments,
  dealCmd, approveContract, contractSources, nextActions, timeline
};
if (typeof module !== 'undefined' && module.exports) module.exports = MARKET;
if (typeof globalThis !== 'undefined') globalThis.MARKET = MARKET;
})();
