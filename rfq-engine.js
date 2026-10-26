/* TWH — регистрация компаний, каталог, подбор поставщиков и RFQ (прототип v0.4).
 *
 * v0.3 (12.10.2026): каталог одного завода → RFQ → предложение → сделка.
 * v0.4 (запрос Бекмырзы от 14.10.2026): «добавить для полноты цикла регистрацию и подбор поставщиков».
 *
 * Что нового:
 *  - Компании регистрируются сами: роль, реквизиты, проверка БИН, IBAN и SWIFT по формату.
 *  - В каталоге товары нескольких поставщиков.
 *  - Покупатель собирает RFQ из позиций (товар из каталога или код ТН ВЭД), система подбирает
 *    поставщиков и ставит оценку 0–100 с объяснением по шести критериям, как в архитектуре TWH v0.1.
 *  - Покупатель выбирает, кому отправить RFQ. Каждый поставщик отвечает своими товарами и ценами.
 *  - Покупатель сравнивает предложения и принимает одно — создаётся сделка (deal-engine.js).
 *
 * Правила те же: команды без мутаций, понятные ошибки на русском, журнал событий.
 * Входа по паролю в прототипе нет: компания выбирается в шапке. Пароли в браузере не храним.
 */
(function () {
/* eslint-disable no-undef */
const MR = (typeof RULES !== 'undefined') ? RULES : require('./rules.js').RULES;
const ME = (typeof ENGINE !== 'undefined') ? ENGINE : require('./engine.js');
const MD = (typeof DEAL !== 'undefined') ? DEAL : require('./deal-engine.js');

const DealError = MD.DealError;
const fail = msg => { throw new DealError(msg); };
const clone = o => JSON.parse(JSON.stringify(o));
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const day = iso => String(iso).slice(0, 10);
const pad = (n, w) => String(n).padStart(w, '0');
const addDays = (iso, d) => { const t = new Date(iso); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const fmt = n => Number(n).toLocaleString('ru-RU');
const fmt2 = n => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ROLE_RU = { buyer: 'Покупатель', supplier: 'Поставщик' };
const RFQ_STATUS_RU = { DRAFT: 'Черновик: выберите поставщиков', SENT: 'Отправлен поставщикам', ACCEPTED: 'Принят, создана сделка', CLOSED: 'Закрыт покупателем' };
const RECIPIENT_STATUS_RU = { SENT: 'Ждём ответа', OFFERED: 'Прислал предложение', DECLINED: 'Отказался' };
const OFFER_STATUS_RU = { SUBMITTED: 'На рассмотрении', ACCEPTED: 'Принято', REJECTED: 'Отклонено', SUPERSEDED: 'Заменено новым' };

/* Атрибуты соответствия: покупатель требует в RFQ, поставщик указывает при регистрации. */
const COMPLIANCE = [
  { id: 'eaeu_decl', ru: 'Декларация о соответствии ЕАЭС (ТР ТС 021/2011)', short: 'Декларация ЕАЭС' },
  { id: 'quality_cert', ru: 'Удостоверение качества и безопасности', short: 'Удостоверение качества' },
  { id: 'halal', ru: 'Сертификат Халал', short: 'Халал' },
  { id: 'shelf_75', ru: 'Остаточный срок годности не менее 75% при отгрузке', short: 'Остаток срока ≥ 75%' },
  { id: 'gost', ru: 'Соответствие ГОСТ / СТ РК, указанному в карточке товара', short: 'ГОСТ / СТ РК' },
  { id: 'iso22000', ru: 'Система менеджмента безопасности пищевой продукции ISO 22000 / FSSC 22000', short: 'ISO 22000' }
];
const compRu = id => (COMPLIANCE.find(c => c.id === id) || { ru: id }).ru;
const compShort = id => (COMPLIANCE.find(c => c.id === id) || { short: id }).short;

/* Веса подбора. Сумма — 100. */
const WEIGHTS = { coverage: 35, compliance: 20, delivery: 15, price: 15, moq: 10, experience: 5 };

function log(w, actor, type, ref, text, now) {
  w.seq.evt += 1;
  w.events.push({ id: 'm' + w.seq.evt, at: now, actor, type, ref, text });
}
const company = (w, id) => w.companies.find(c => c.id === id);
function needCompany(w, id, role, action) {
  const c = company(w, id) || fail('Сначала выберите или зарегистрируйте компанию.');
  if (role && c.role !== role) fail(`${action}: это действие выполняет ${ROLE_RU[role].toLowerCase()}, а «${c.name}» зарегистрирована как ${ROLE_RU[c.role].toLowerCase()}.`);
  return c;
}

/* ---------- регистрация ---------- */
/* Проверяем формат, а не существование: настоящую проверку счёта по IBAN даст
   метод /v1/accounts/{iban}/exists системы Open Banking НПК, когда будет банк-партнёр. */
function validateCompany(w, p) {
  const errs = [];
  const name = String(p.name || '').trim();
  if (!['buyer', 'supplier'].includes(p.role)) errs.push('Выберите роль: покупатель или поставщик.');
  if (name.length < 3) errs.push('Укажите наименование компании.');
  const country = String(p.country || '').trim();
  if (!country) errs.push('Укажите страну регистрации.');
  const reg = String(p.reg || '').replace(/\s/g, '');
  if (country === 'Казахстан') {
    if (!/^\d{12}$/.test(reg)) errs.push('БИН должен состоять из 12 цифр.');
  } else if (reg.length < 5) errs.push('Укажите регистрационный номер или ИНН.');
  const email = String(p.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errs.push('Укажите корректный e-mail.');
  const iban = String(p.iban || '').replace(/\s/g, '').toUpperCase();
  if (iban) {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) errs.push('IBAN: две буквы страны, две цифры, затем номер счёта.');
    else if (iban.startsWith('KZ') && iban.length !== 20) errs.push('Казахстанский IBAN состоит из 20 символов.');
  } else if (p.role === 'supplier') errs.push('Поставщику нужен IBAN: на него будут выставляться счета.');
  const swift = String(p.swift || '').replace(/\s/g, '').toUpperCase();
  if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) errs.push('SWIFT/BIC: 8 или 11 символов.');
  if (w.companies.some(c => c.email === email)) errs.push('Компания с таким e-mail уже зарегистрирована.');
  if (reg && w.companies.some(c => String(c.reg).replace(/\D/g, '') === reg.replace(/\D/g, '') && c.country === country)) errs.push('Компания с таким регистрационным номером уже есть.');
  if (errs.length) fail(errs.join(' '));
  return { name, country, reg, email, iban, swift };
}

function registerRaw(w, p, now) {
  const v = validateCompany(w, p);
  w.seq.co += 1;
  const c = {
    id: 'co' + w.seq.co, role: p.role, name: v.name, country: v.country,
    reg: v.country === 'Казахстан' ? 'БИН ' + v.reg : v.reg,
    rep: String(p.rep || '').trim() || '—', basis: p.basis || 'Устава',
    address: String(p.address || '').trim() || '—', city: String(p.city || '').trim(),
    bank: String(p.bank || '').trim() || '—', iban: v.iban || '—', swift: v.swift || '—',
    email: v.email, registered_at: now,
    certs: p.role === 'supplier' && Array.isArray(p.certs) ? p.certs.filter(x => COMPLIANCE.some(c => c.id === x)) : [],
    export_to: p.role === 'supplier' && Array.isArray(p.export_to) ? p.export_to.filter(x => MR.routes[x]) : [],
    lead_time_days: p.role === 'supplier' ? Math.max(1, Number(p.lead_time_days) || 14) : null
  };
  w.companies.push(c);
  return c;
}

function registerCompany(state, p, now) {
  const w = clone(state);
  const c = registerRaw(w, p, now);
  log(w, c.id, 'COMPANY_REGISTERED', c.name, `Зарегистрирована компания «${c.name}» (${ROLE_RU[c.role].toLowerCase()}, ${c.country})`, now);
  return w;
}

/* ---------- каталог ---------- */
function validProduct(p) {
  if (!String(p.name || '').trim()) fail('У товара должно быть наименование.');
  if (!(Number(p.price) > 0)) fail('Укажите цену товара.');
  if (!String(p.unit || '').trim()) fail('Укажите единицу измерения.');
  if (!/^\d{4}(\.\d{2}(\.\d{2})?)?$/.test(String(p.hs || '').trim())) fail('Код ТН ВЭД в формате 1905 или 1905.32.');
  return {
    name: String(p.name).trim(), description: p.description || '', hs: String(p.hs).trim(),
    unit: p.unit, price: round2(p.price), currency: p.currency || 'USD',
    moq: Number(p.moq) || 0, packaging: p.packaging || 'Гофротара (картон)',
    shelf_life_months: Number(p.shelf_life_months) || null, standard: p.standard || ''
  };
}
function addProductRaw(w, supplierId, p) {
  const s = company(w, supplierId);
  w.seq.prod += 1;
  const prod = { id: 'prod' + w.seq.prod, sku: 'SKU-' + pad(w.seq.prod, 3), supplier_id: supplierId, origin: s.country, ...validProduct(p) };
  w.catalog.push(prod);
  return prod;
}
function addProduct(state, actorId, p, now) {
  const w = clone(state);
  const s = needCompany(w, actorId, 'supplier', 'Публикация товара');
  const prod = addProductRaw(w, s.id, p);
  log(w, s.id, 'PRODUCT_PUBLISHED', prod.sku, `«${s.name}» опубликовала товар «${prod.name}», ${fmt2(prod.price)} ${prod.currency}/${prod.unit}`, now);
  return w;
}

/* ---------- рабочее пространство ---------- */
function createWorkspace(seed, now) {
  const w = { v: 4, seq: { co: 0, prod: 0, rfq: 0, offer: 0, evt: 0 }, companies: [], catalog: [], rfqs: [], offers: [], deal: null, events: [] };
  (seed.companies || []).forEach(c => {
    const created = registerRaw(w, c, now);
    (c.products || []).forEach(p => addProductRaw(w, created.id, p));
  });
  log(w, 'system', 'WORKSPACE_CREATED', 'TWH',
    `На платформе ${w.companies.filter(c => c.role === 'supplier').length} поставщика и ${w.catalog.length} товаров в каталоге`, now);
  return w;
}

/* ---------- подбор поставщиков ---------- */
const hsMatch = (productHs, lineHs) => String(productHs).startsWith(String(lineHs)) || String(lineHs).startsWith(String(productHs));

function defaultDocuments(route, incoterms) {
  const d = ME.derive({ route, incoterms, category: 'bakery', transport: 'road', vat_mode: 'export_0', currency: 'USD', quantity: 1, unit_price: 1 });
  const docs = d.documents.map(x => x.ru);
  if (!d.route.eaeu) docs.push('Экспортная декларация');
  return docs;
}

/* Оценка одного поставщика по RFQ: шесть критериев, у каждого объяснение. */
function scoreSupplier(w, rfq, s, now) {
  const picks = rfq.lines.map(line => {
    const cands = w.catalog.filter(p => p.supplier_id === s.id && hsMatch(p.hs, line.hs));
    if (!cands.length) return null;
    const fit = cands.filter(p => !p.moq || p.moq <= line.qty);
    return (fit.length ? fit : cands).sort((a, b) => a.price - b.price)[0];
  });
  const covered = picks.filter(Boolean).length;
  if (!covered) return null;
  const n = rfq.lines.length;
  const factors = [];

  const cov = covered / n;
  factors.push({ key: 'coverage', label: 'Ассортимент', points: Math.round(WEIGHTS.coverage * cov), max: WEIGHTS.coverage,
    note: cov === 1 ? `есть все позиции запроса (${n} из ${n})` : `есть ${covered} из ${n} позиций` });

  const req = rfq.compliance.filter(c => c !== 'shelf_75');
  const has = req.filter(c => s.certs.includes(c));
  const compShare = req.length ? has.length / req.length : 1;
  const missing = req.filter(c => !s.certs.includes(c)).map(compShort);
  factors.push({ key: 'compliance', label: 'Документы и сертификаты', points: Math.round(WEIGHTS.compliance * compShare), max: WEIGHTS.compliance,
    note: !req.length ? 'покупатель не требовал сертификатов' : (missing.length ? `нет: ${missing.join(', ')}` : 'есть все требуемые') });

  const daysLeft = daysBetween(day(now), rfq.delivery_date);
  const lead = s.lead_time_days;
  const delShare = lead <= daysLeft ? 1 : Math.max(0, 1 - (lead - daysLeft) / Math.max(daysLeft, 1));
  factors.push({ key: 'delivery', label: 'Срок', points: Math.round(WEIGHTS.delivery * delShare), max: WEIGHTS.delivery,
    note: lead <= daysLeft ? `обычно отгружает за ${lead} дн., до срока поставки ${daysLeft} дн.` : `обычно ${lead} дн., а до срока поставки ${daysLeft} дн.` });

  const priced = rfq.lines.map((l, i) => ({ l, p: picks[i] })).filter(x => x.p && x.l.target_price);
  let priceShare = 1, priceNote = 'целевая цена не указана';
  if (priced.length) {
    const ratio = priced.reduce((a, x) => a + x.p.price / x.l.target_price, 0) / priced.length;
    priceShare = ratio <= 1 ? 1 : Math.max(0, 1 - (ratio - 1) * 4);
    priceNote = ratio <= 1 ? `прайс в пределах целевой цены (${Math.round(ratio * 100)}%)` : `прайс выше целевой на ${Math.round((ratio - 1) * 100)}%`;
  }
  factors.push({ key: 'price', label: 'Цена по прайсу', points: Math.round(WEIGHTS.price * priceShare), max: WEIGHTS.price, note: priceNote });

  const moqBad = rfq.lines.map((l, i) => ({ l, p: picks[i] })).filter(x => x.p && x.p.moq && x.p.moq > x.l.qty);
  factors.push({ key: 'moq', label: 'Минимальная партия', points: moqBad.length ? 0 : WEIGHTS.moq, max: WEIGHTS.moq,
    note: moqBad.length ? `мин. партия больше запроса: ${moqBad.map(x => `${x.p.name} от ${fmt(x.p.moq)} ${x.p.unit}`).join('; ')}` : 'объём запроса не меньше минимальной партии' });

  const exp = s.export_to.includes(rfq.route);
  factors.push({ key: 'experience', label: 'Опыт по направлению', points: exp ? WEIGHTS.experience : 0, max: WEIGHTS.experience,
    note: exp ? `уже поставляет в ${MR.routes[rfq.route].name_ru}` : `поставок в ${MR.routes[rfq.route].name_ru} не указано` });

  const score = factors.reduce((a, f) => a + f.points, 0);
  return { supplier_id: s.id, score, complete: covered === n, factors, product_ids: picks.map(p => (p ? p.id : null)) };
}

function matchSuppliers(w, rfq, now) {
  return w.companies.filter(c => c.role === 'supplier')
    .map(s => scoreSupplier(w, rfq, s, now)).filter(Boolean)
    .sort((a, b) => (b.complete - a.complete) || (b.score - a.score));
}

/* ---------- RFQ ---------- */
function createRFQ(state, actorId, args, now) {
  const w = clone(state);
  const buyer = needCompany(w, actorId, 'buyer', 'Создание RFQ');
  if (w.deal) fail('В демо одна сделка. Сбросьте демо, чтобы начать новую.');
  if (w.rfqs.some(r => r.buyer_id === buyer.id && ['DRAFT', 'SENT'].includes(r.status))) fail('У вас уже есть открытый RFQ. Завершите или закройте его.');
  const lines = (args.lines || []).filter(l => Number(l.qty) > 0).map(l => {
    const hs = String(l.hs || '').trim();
    if (!/^\d{4}(\.\d{2}(\.\d{2})?)?$/.test(hs)) fail('У каждой позиции должен быть код ТН ВЭД.');
    return { hs, name: String(l.name || '').trim() || `Товар ТН ВЭД ${hs}`, unit: l.unit || 'кг', qty: Number(l.qty),
      target_price: Number(l.target_price) > 0 ? round2(l.target_price) : null,
      specification: String(l.specification || '').trim(), from_product: l.from_product || null };
  });
  if (!lines.length) fail('Добавьте хотя бы одну позицию с количеством.');
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
    status: 'DRAFT', buyer_id: buyer.id, lines,
    route, destination_country: MR.routes[route].name_ru, delivery_place: String(args.delivery_place).trim(),
    incoterms, currency: args.currency || 'USD', payment_preset: args.payment_preset || '30_70',
    delivery_date: delivery, transport: 'road',
    documents: defaultDocuments(route, incoterms),
    compliance: Array.isArray(args.compliance) ? args.compliance.slice() : [],
    offer_deadline: deadline, recipients: [], matches: []
  };
  rfq.matches = matchSuppliers(w, rfq, now);
  w.rfqs.push(rfq);
  log(w, buyer.id, 'RFQ_CREATED', rfq.ref,
    `«${buyer.name}» составила ${rfq.ref}: ${lines.map(l => `${l.name} — ${fmt(l.qty)} ${l.unit}`).join('; ')}. Подобрано поставщиков: ${rfq.matches.length}`, now);
  return w;
}

function sendRFQ(state, actorId, rfqId, supplierIds, now) {
  const w = clone(state);
  const buyer = needCompany(w, actorId, 'buyer', 'Отправка RFQ');
  const r = w.rfqs.find(x => x.id === rfqId && x.buyer_id === buyer.id) || fail('RFQ не найден.');
  if (r.status !== 'DRAFT') fail('Этот RFQ уже отправлен.');
  const ids = [...new Set(supplierIds || [])];
  if (!ids.length) fail('Выберите хотя бы одного поставщика.');
  ids.forEach(id => {
    const m = r.matches.find(x => x.supplier_id === id) || fail('Этого поставщика нет в подборе по запросу.');
    if (!m.complete) fail(`«${company(w, id).name}» поставляет не все позиции запроса, ему нельзя отправить этот RFQ целиком.`);
  });
  r.recipients = ids.map(id => ({ supplier_id: id, status: 'SENT' }));
  r.status = 'SENT';
  log(w, buyer.id, 'RFQ_SENT', r.ref, `${r.ref} отправлен поставщикам: ${ids.map(id => '«' + company(w, id).name + '»').join(', ')}. Предложения до ${r.offer_deadline}`, now);
  return w;
}

function closeRFQ(state, actorId, rfqId, now) {
  const w = clone(state);
  const buyer = needCompany(w, actorId, 'buyer', 'Закрытие RFQ');
  const r = w.rfqs.find(x => x.id === rfqId && x.buyer_id === buyer.id) || fail('RFQ не найден.');
  if (!['DRAFT', 'SENT'].includes(r.status)) fail('Этот RFQ уже закрыт.');
  r.status = 'CLOSED';
  w.offers.filter(o => o.rfq_id === r.id && o.status === 'SUBMITTED').forEach(o => { o.status = 'REJECTED'; });
  log(w, buyer.id, 'RFQ_CLOSED', r.ref, `Покупатель закрыл ${r.ref}`, now);
  return w;
}

function recipientOf(r, supplierId) {
  return r.recipients.find(x => x.supplier_id === supplierId) || fail('Этот RFQ вам не отправлялся.');
}

function declineRFQ(state, actorId, rfqId, reason, now) {
  const w = clone(state);
  const s = needCompany(w, actorId, 'supplier', 'Отказ от RFQ');
  const r = w.rfqs.find(x => x.id === rfqId) || fail('RFQ не найден.');
  const rec = recipientOf(r, s.id);
  if (rec.status !== 'SENT') fail('Вы уже ответили на этот запрос.');
  const why = String(reason || '').trim();
  if (!why) fail('Укажите причину отказа, покупателю это важно.');
  rec.status = 'DECLINED';
  rec.decline_reason = why;
  log(w, s.id, 'RFQ_DECLINED', r.ref, `«${s.name}» отказалась от ${r.ref}: ${why}`, now);
  return w;
}

/* ---------- предложения ---------- */
function submitOffer(state, actorId, rfqId, args, now) {
  const w = clone(state);
  const s = needCompany(w, actorId, 'supplier', 'Предложение по RFQ');
  const r = w.rfqs.find(x => x.id === rfqId) || fail('RFQ не найден.');
  if (r.status !== 'SENT') fail(`${r.ref} уже не принимает предложения (${RFQ_STATUS_RU[r.status]}).`);
  const rec = recipientOf(r, s.id);
  if (rec.status === 'DECLINED') fail('Вы отказались от этого запроса.');
  if (day(now) > r.offer_deadline) fail(`Срок подачи предложений по ${r.ref} истёк ${r.offer_deadline}.`);
  const match = r.matches.find(m => m.supplier_id === s.id);
  const productIds = r.lines.map((l, i) => (args && args.product_ids && args.product_ids[i]) || match.product_ids[i]);
  productIds.forEach((pid, i) => {
    const p = w.catalog.find(x => x.id === pid && x.supplier_id === s.id) || fail(`Для позиции ${i + 1} выберите свой товар.`);
    if (!hsMatch(p.hs, r.lines[i].hs)) fail(`«${p.name}» не подходит к позиции ${i + 1} по коду ТН ВЭД.`);
  });
  const prices = r.lines.map((l, i) => {
    const p = round2(args && args.prices ? args.prices[i] : w.catalog.find(x => x.id === productIds[i]).price);
    if (!(p > 0)) fail(`Укажите цену для позиции ${i + 1}.`);
    return p;
  });
  const lead = Number(args && args.lead_time_days);
  if (!(lead > 0)) fail('Укажите срок изготовления и отгрузки в днях.');
  const shipBy = addDays(now, lead);
  w.offers.filter(o => o.rfq_id === r.id && o.supplier_id === s.id && o.status === 'SUBMITTED').forEach(o => { o.status = 'SUPERSEDED'; });
  w.seq.offer += 1;
  const o = {
    id: 'off' + w.seq.offer, ref: `OFF-${pad(w.seq.offer, 4)}`, rfq_id: r.id, supplier_id: s.id, created_at: now,
    status: 'SUBMITTED', product_ids: productIds, prices, lead_time_days: lead, ship_by: shipBy,
    valid_until: (args && args.valid_until) || addDays(now, 7), meets_delivery: shipBy <= r.delivery_date,
    note: String((args && args.note) || '').trim()
  };
  o.total = round2(r.lines.reduce((a, l, i) => a + l.qty * prices[i], 0));
  w.offers.push(o);
  rec.status = 'OFFERED';
  log(w, s.id, 'OFFER_SUBMITTED', o.ref,
    `«${s.name}» предложила ${fmt2(o.total)} ${r.currency} по ${r.ref}, отгрузка за ${lead} дн.${o.meets_delivery ? '' : ' (позже запрошенного срока)'}`, now);
  return w;
}

function rejectOffer(state, actorId, offerId, now) {
  const w = clone(state);
  const buyer = needCompany(w, actorId, 'buyer', 'Отклонение предложения');
  const o = w.offers.find(x => x.id === offerId) || fail('Предложение не найдено.');
  const r = w.rfqs.find(x => x.id === o.rfq_id);
  if (r.buyer_id !== buyer.id) fail('Это предложение не по вашему запросу.');
  if (o.status !== 'SUBMITTED') fail('Это предложение уже не на рассмотрении.');
  o.status = 'REJECTED';
  log(w, buyer.id, 'OFFER_REJECTED', o.ref, `Покупатель отклонил ${o.ref} от «${company(w, o.supplier_id).name}»`, now);
  return w;
}

/* Сравнение предложений для покупателя: сумма, срок, оценка подбора, отклонение от лучшей цены. */
function compareOffers(w, rfqId) {
  const r = w.rfqs.find(x => x.id === rfqId);
  const live = w.offers.filter(o => o.rfq_id === rfqId && ['SUBMITTED', 'ACCEPTED', 'REJECTED'].includes(o.status));
  const best = Math.min(...live.filter(o => o.status !== 'REJECTED').map(o => o.total));
  const fastest = Math.min(...live.filter(o => o.status !== 'REJECTED').map(o => o.lead_time_days));
  return live.map(o => {
    const m = r.matches.find(x => x.supplier_id === o.supplier_id) || { score: 0 };
    return { offer: o, supplier: company(w, o.supplier_id), score: m.score,
      cheapest: o.total === best, fastest: o.lead_time_days === fastest,
      over_best: isFinite(best) ? round2(o.total - best) : 0 };
  }).sort((a, b) => a.offer.total - b.offer.total);
}

function acceptOffer(state, actorId, offerId, now) {
  const w = clone(state);
  const buyer = needCompany(w, actorId, 'buyer', 'Принятие предложения');
  const o = w.offers.find(x => x.id === offerId) || fail('Предложение не найдено.');
  const r = w.rfqs.find(x => x.id === o.rfq_id);
  if (r.buyer_id !== buyer.id) fail('Это предложение не по вашему запросу.');
  if (o.status !== 'SUBMITTED') fail('Это предложение уже не на рассмотрении.');
  if (day(now) > o.valid_until) fail(`Предложение ${o.ref} действовало до ${o.valid_until}. Попросите поставщика обновить его.`);
  if (w.deal) fail('Сделка уже создана.');
  const supplier = company(w, o.supplier_id);
  o.status = 'ACCEPTED';
  r.status = 'ACCEPTED';
  w.offers.filter(x => x.rfq_id === r.id && x.id !== o.id && x.status === 'SUBMITTED').forEach(x => { x.status = 'REJECTED'; });

  const products = o.product_ids.map(id => w.catalog.find(p => p.id === id));
  const items = r.lines.map((l, i) => ({ name: products[i].name, hs: products[i].hs, unit: l.unit, qty: l.qty, price: o.prices[i] }));
  const shelf = Math.min(...products.map(p => p.shelf_life_months || 99));
  const snap = c => ({ name: c.name, country: c.country, reg: c.reg, rep: c.rep, basis: c.basis, address: c.address, bank: c.bank, iban: c.iban, swift: c.swift });
  const seed = {
    ref: 'TWH-D-' + pad(w.seq.rfq, 6),
    route: r.route, incoterms: r.incoterms, transport: r.transport, currency: r.currency,
    category: 'bakery', payment_preset: r.payment_preset, vat_mode: 'export_0',
    frame_limit: o.total, delivery_place: r.delivery_place,
    contract_number: `TWH-${String(now).slice(0, 4)}-${pad(w.seq.rfq, 5)}`,
    contract_terms: {
      place: supplier.city || 'Алматы', goods_name: items.map(i => i.name).join('; '),
      hs_code: [...new Set(items.map(i => i.hs))].join(', '),
      lot_unit: 'партия согласно Спецификации №1',
      shelf_life_value: shelf < 99 ? shelf : 9, min_remaining_pct: 75, delivery_date: r.delivery_date
    },
    companies: { supplier: snap(supplier), buyer: snap(buyer) }
  };
  const deal = MD.createDeal(seed, now);
  deal.parties = { supplier_id: supplier.id, buyer_id: buyer.id };
  deal.origin = {
    rfq_id: r.id, rfq_ref: r.ref, offer_id: o.id, offer_ref: o.ref,
    pending_spec: { items, delivery_date: r.delivery_date, delivery_place: r.delivery_place,
      packaging: [...new Set(products.map(p => p.packaging))].join('; '),
      other_terms: [r.compliance.length ? 'Требования покупателя: ' + r.compliance.map(compRu).join('; ') : '',
        r.lines.some(l => l.specification) ? 'Спецификация товара: ' + r.lines.map((l, i) => (l.specification ? `${products[i].name}: ${l.specification}` : '')).filter(Boolean).join('; ') : '']
        .filter(Boolean).join('. ') }
  };
  w.deal = deal;
  log(w, buyer.id, 'OFFER_ACCEPTED', o.ref,
    `Покупатель принял ${o.ref} от «${supplier.name}» на ${fmt2(o.total)} ${r.currency}. Создана сделка ${deal.deal.ref}, договор ${deal.contract.number} собран из RFQ и предложения`, now);
  return w;
}

/* ---------- сделка: роль выбранной компании ---------- */
function dealRole(w, actorId) {
  if (!w.deal || !w.deal.parties) return null;
  if (w.deal.parties.supplier_id === actorId) return 'supplier';
  if (w.deal.parties.buyer_id === actorId) return 'buyer';
  return null;
}
function dealCmd(state, actorId, fn) {
  if (!state.deal) fail('Сделки ещё нет: сначала покупатель принимает предложение по RFQ.');
  const role = dealRole(state, actorId) || fail('Ваша компания не участвует в этой сделке.');
  const w = clone(state);
  w.deal = fn(w.deal, role);
  return w;
}
function approveContract(state, actorId, now) {
  let w = dealCmd(state, actorId, (d, role) => MD.approveContract(d, role, now));
  const d = w.deal;
  if (d.contract.status === 'AGREED' && d.origin && d.origin.pending_spec && !d.specs.length) {
    let nd = MD.createSpec(d, 'supplier', d.origin.pending_spec, now);
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
  const m = r.matches.find(x => x.supplier_id === o.supplier_id) || { score: 0 };
  const products = o.product_ids.map(id => w.catalog.find(p => p.id === id));
  const cur = r.currency;
  const sup = company(w, o.supplier_id), buy = company(w, r.buyer_id);
  return [
    ['Поставщик', `${sup.name}, оценка подбора ${m.score}/100`, 'Подбор поставщиков → ' + o.ref],
    ['Товары и коды ТН ВЭД', products.map(p => `${p.name} (${p.hs})`).join('; '), 'Каталог поставщика → ' + o.ref],
    ['Количество', r.lines.map(l => `${fmt(l.qty)} ${l.unit}`).join('; '), r.ref],
    ['Происхождение', [...new Set(products.map(p => p.origin))].join(', '), 'Профиль поставщика'],
    ['Цены', r.lines.map((l, k) => `${fmt2(o.prices[k])} ${cur}/${l.unit}`).join('; '), o.ref],
    ['Сумма договора', `${fmt2(o.total)} ${cur}`, o.ref],
    ['Срок отгрузки', `${o.lead_time_days} дн., до ${o.ship_by}`, o.ref],
    ['Incoterms и место поставки', `${r.incoterms}, ${r.delivery_place}`, r.ref],
    ['Направление, право и арбитраж', `${r.destination_country}: правила маршрута`, r.ref + ' → правила TWH'],
    ['Валюта и условия оплаты', `${cur}, ${(MR.payment_presets.find(p => p.id === r.payment_preset) || {}).label}`, r.ref],
    ['Документы к отгрузке', r.documents.join('; '), r.ref + ' → правила TWH'],
    ['Требования к качеству', r.compliance.map(compRu).join('; ') || '—', r.ref],
    ['Срок годности', `${w.deal.contract.terms.shelf_life_value} мес. (минимальный по товарам), остаток не менее 75%`, 'Каталог поставщика'],
    ['Реквизиты сторон', `${sup.name}, IBAN ${sup.iban}; ${buy.name}`, 'Регистрация компаний']
  ];
}

/* ---------- «Ваш ход» и хронология ---------- */
function nextActions(w, actorId) {
  const me = company(w, actorId);
  if (!me) return [{ kind: 'register', text: 'Зарегистрируйте компанию или выберите существующую в шапке' }];
  if (w.deal) {
    const role = dealRole(w, actorId);
    if (!role) return [{ kind: 'wait', text: 'Сделка уже заключена с другим поставщиком. Ваша компания в ней не участвует.' }];
    return MD.nextActions(w.deal, role);
  }
  const out = [];
  if (me.role === 'buyer') {
    const r = w.rfqs.find(x => x.buyer_id === me.id && ['DRAFT', 'SENT'].includes(x.status));
    if (!r) out.push({ kind: 'goto_catalog', text: 'Добавьте нужные товары из каталога в запрос и отправьте RFQ' });
    else if (r.status === 'DRAFT') out.push({ kind: 'goto_rfq', id: r.id, text: `Выберите поставщиков для ${r.ref}: подобрано ${r.matches.length}` });
    else {
      const subs = w.offers.filter(o => o.rfq_id === r.id && o.status === 'SUBMITTED');
      const waiting = r.recipients.filter(x => x.status === 'SENT').length;
      if (subs.length) out.push({ kind: 'goto_rfq', id: r.id, text: `Сравните предложения по ${r.ref}: получено ${subs.length}${waiting ? `, ещё ждём ${waiting}` : ''}` });
      else out.push({ kind: 'wait', text: `Ждём предложений по ${r.ref} от ${waiting} поставщиков (до ${r.offer_deadline})` });
    }
  } else {
    const inbox = w.rfqs.filter(r => r.status === 'SENT' && r.recipients.some(x => x.supplier_id === me.id && x.status === 'SENT'));
    inbox.forEach(r => out.push({ kind: 'goto_rfq', id: r.id, text: `Ответьте на ${r.ref} от «${company(w, r.buyer_id).name}»: ${r.lines.length} поз., поставка до ${r.delivery_date}` }));
    if (!inbox.length) {
      const pending = w.rfqs.some(r => r.status === 'SENT' && r.recipients.some(x => x.supplier_id === me.id && x.status === 'OFFERED'));
      out.push({ kind: 'wait', text: pending ? 'Ваше предложение у покупателя. Ждём решения.' : 'Новых запросов нет. Ваши товары видны покупателям в каталоге.' });
    }
  }
  return out;
}

function timeline(w) {
  return [...w.events, ...((w.deal && w.deal.events) || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
function actorName(w, actor) {
  if (actor === 'system') return 'Система';
  if (actor === 'supplier' || actor === 'buyer') {
    const id = w.deal && w.deal.parties && w.deal.parties[actor + '_id'];
    return id ? company(w, id).name : ROLE_RU[actor];
  }
  return (company(w, actor) || { name: '—' }).name;
}

const MARKET = {
  ROLE_RU, RFQ_STATUS_RU, RECIPIENT_STATUS_RU, OFFER_STATUS_RU, COMPLIANCE, WEIGHTS,
  createWorkspace, registerCompany, validateCompany, addProduct,
  createRFQ, sendRFQ, closeRFQ, declineRFQ, matchSuppliers, scoreSupplier, defaultDocuments,
  submitOffer, rejectOffer, compareOffers, acceptOffer,
  dealRole, dealCmd, approveContract, contractSources, nextActions, timeline, actorName, company
};
if (typeof module !== 'undefined' && module.exports) module.exports = MARKET;
if (typeof globalThis !== 'undefined') globalThis.MARKET = MARKET;
})();
