/* TWH Contract Generator — движок.
 *
 * Три функции наружу:
 *   derive(state)        — что следует из введённых данных (документы, право, страховка, предупреждения)
 *   amountInWords(...)   — сумма прописью на русском и английском
 *   buildContract(state) — структура готового договора: массив блоков {type, ru, en, rows}
 *
 * Никаких DOM и никаких window. Файл грузится и в браузере, и в Node (verify.mjs).
 */

/* eslint-disable no-undef */
const R = (typeof RULES !== 'undefined') ? RULES : require('./rules.js').RULES;

/* ---------- сумма прописью ---------- */

const RU_ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const RU_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const RU_HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function ruPlural(n, forms) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

function ruTriad(num, feminine) {
  const ones = feminine ? RU_ONES_F : RU_ONES_M;
  const parts = [];
  const h = Math.floor(num / 100), t = Math.floor((num % 100) / 10), o = num % 10;
  if (h) parts.push(RU_HUNDREDS[h]);
  if (t === 1) { parts.push(RU_TEENS[o]); }
  else {
    if (t) parts.push(RU_TENS[t]);
    if (o) parts.push(ones[o]);
  }
  return parts.join(' ');
}

function ruNumber(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'ноль';
  const scales = [
    { div: 1e9, forms: ['миллиард', 'миллиарда', 'миллиардов'], fem: false },
    { div: 1e6, forms: ['миллион', 'миллиона', 'миллионов'], fem: false },
    { div: 1e3, forms: ['тысяча', 'тысячи', 'тысяч'], fem: true }
  ];
  const out = [];
  let rest = n;
  for (const s of scales) {
    const cnt = Math.floor(rest / s.div);
    if (cnt) {
      out.push(ruTriad(cnt, s.fem), ruPlural(cnt, s.forms));
      rest -= cnt * s.div;
    }
  }
  if (rest) out.push(ruTriad(rest, false));
  return out.filter(Boolean).join(' ');
}

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enTriad(num) {
  const parts = [];
  const h = Math.floor(num / 100), r = num % 100;
  if (h) parts.push(EN_ONES[h] + ' hundred');
  if (r) {
    if (parts.length) parts.push('and');
    if (r < 20) parts.push(EN_ONES[r]);
    else {
      const t = Math.floor(r / 10), o = r % 10;
      parts.push(o ? EN_TENS[t] + '-' + EN_ONES[o] : EN_TENS[t]);
    }
  }
  return parts.join(' ');
}

function enNumber(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const out = [];
  let rest = n;
  for (const [div, word] of scales) {
    const cnt = Math.floor(rest / div);
    if (cnt) { out.push(enTriad(cnt), word); rest -= cnt * div; }
  }
  if (rest) out.push(enTriad(rest));
  return out.filter(Boolean).join(' ');
}

function amountInWords(amount, currencyCode) {
  const cur = R.currencies.find(c => c.code === currencyCode) || R.currencies[0];
  const whole = Math.floor(Math.abs(amount));
  const minor = Math.round((Math.abs(amount) - whole) * 100);
  const ruMain = ruNumber(whole);
  const ruCur = ruPlural(whole, [cur.ru_one, cur.ru_few, cur.ru_many]);
  const ruMinorWord = ruPlural(minor, cur.minor_ru);
  const ru = `${ruMain.charAt(0).toUpperCase()}${ruMain.slice(1)} ${ruCur} ${String(minor).padStart(2, '0')} ${ruMinorWord}`;
  const enMain = enNumber(whole);
  const en = `${enMain.charAt(0).toUpperCase()}${enMain.slice(1)} ${cur.en} ${String(minor).padStart(2, '0')} ${cur.en_minor}`;
  return { ru, en };
}

/* ---------- вывод следствий ---------- */

function derive(state) {
  const inc = R.incoterms[state.incoterms] || R.incoterms.DAP;
  const route = R.routes[state.route] || R.routes.RU;
  const cat = R.categories[state.category] || R.categories.bakery;
  const transport = state.transport || 'road';

  const insuranceRequired = inc.insurance === 'required';
  const phytoRequired = cat.phyto_required;
  const animalOrigin = !!state.contains_animal_products;

  const flags = {
    always: true,
    road: transport === 'road',
    sea_air: transport === 'sea_air',
    origin_cert: route.cis_fta || route.cert_origin === 'FORM_A',
    food: cat.food,
    phyto: phytoRequired,
    insurance: insuranceRequired,
    animal_origin: cat.food && animalOrigin
  };

  const documents = R.documents
    .filter(d => flags[d.when])
    .map(d => {
      const doc = { ...d };
      if (d.id === '5.1.4') {
        const form = route.cert_origin === 'FORM_A' ? 'Form A' : 'СТ-1';
        /* Внутри ЕАЭС сертификат происхождения предоставляется по запросу Покупателя,
           за пределами ЕАЭС обязателен. Решение от 06.09.2026. */
        doc.optional = route.eaeu;
        doc.ru = `Сертификат происхождения (${form})` +
          (doc.optional ? ' — по запросу Покупателя' : '');
        doc.en = `Certificate of Origin (${form === 'СТ-1' ? 'CT-1' : 'Form A'})` +
          (doc.optional ? ' — at the Buyer’s request' : '');
      }
      return doc;
    });

  /* документы, которые сознательно исключены — показываем, чтобы юрист видел решение */
  const excluded = [];
  if (cat.food && !phytoRequired) {
    excluded.push({ id: '5.1.6', ru: 'Фитосанитарный сертификат', reason: 'готовая выпечка, не сырьё' });
  }
  if (cat.food && !animalOrigin) {
    excluded.push({ id: '5.1.9', ru: 'Ветеринарный сертификат', reason: 'нет мяса, молока и яиц в составе' });
  }
  if (!insuranceRequired) {
    excluded.push({ id: '5.1.7', ru: 'Страховой полис', reason: `${state.incoterms}: страхование не обязательно по Incoterms 2020` });
  }

  const qty = Number(state.quantity) || 0;
  const price = Number(state.unit_price) || 0;
  const total = Math.round(qty * price * 100) / 100;

  const questionFlags = {
    always: true,
    route_eaeu: route.eaeu,
    vat_export: state.vat_mode === 'export_0',
    incoterms_dap: state.incoterms === 'DAP'
  };
  const questions = R.open_questions.filter(q => questionFlags[q.when]);

  const warnings = [];
  if (!inc.road_ok && transport === 'road') {
    warnings.push(`${state.incoterms} — морской термин, для автотранспорта не применяется. Для фур используйте EXW, FCA, DAP или DDP.`);
  }
  if (route.eaeu && (state.incoterms === 'DAP' || state.incoterms === 'DDP')) {
    warnings.push('Внутри ЕАЭС импортной растаможки нет, разница между DAP и DDP на этом маршруте почти исчезает.');
  }
  if (cat.food && !state.shelf_life_value) {
    warnings.push('Для пищевой продукции срок годности обязателен (ТР ТС 022/2011).');
  }
  if (total > 50000 && state.payment_preset !== 'lc' && state.payment_preset !== 'escrow') {
    warnings.push('Сумма выше $50k. По гайду на таких суммах рекомендуется аккредитив или эскроу.');
  }

  return {
    incoterms: inc,
    route,
    category: cat,
    documents,
    excluded,
    insuranceRequired,
    importCustoms: route.eaeu ? 'none' : inc.import_customs,
    exportCustoms: inc.export_customs,
    deliveryPlaceLabel: { ru: inc.place_label_ru, en: inc.place_label_en },
    law: { ru: route.law_ru, en: route.law_en },
    arbitration: { ru: route.arbitration_ru, en: route.arbitration_en },
    seat: { ru: route.seat_ru, en: route.seat_en },
    total,
    totalWords: amountInWords(total, state.currency || 'USD'),
    questions,
    warnings
  };
}

/* ---------- сборка текста договора ---------- */

const pad5 = n => String(n).padStart(5, '0');
const contractNumber = state =>
  `TWH-${state.contract_year || new Date().getFullYear()}-${pad5(state.contract_seq || 1)}`;

const dash = v => (v && String(v).trim()) ? String(v).trim() : '______________';

const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ISO 2026-09-01 → «01 сентября 2026 г.» / «01 September 2026» */
function formatDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return dash(iso);
  const [, y, mo, dd] = m;
  const idx = Number(mo) - 1;
  return lang === 'en'
    ? `${dd} ${EN_MONTHS[idx]} ${y}`
    : `${dd} ${RU_MONTHS[idx]} ${y} г.`;
}
const money = (v, cur) => (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (cur || '');

function buildContract(state) {
  const d = derive(state);
  const cur = state.currency || 'USD';
  const preset = R.payment_presets.find(p => p.id === state.payment_preset) || R.payment_presets[0];
  const method = R.payment_methods.find(m => m.id === state.payment_method) || R.payment_methods[0];
  const vat = R.vat_modes.find(v => v.id === state.vat_mode) || R.vat_modes[0];
  const b = [];

  const P = (ru, en) => b.push({ type: 'p', ru, en });
  const H = (ru, en) => b.push({ type: 'h', ru, en });
  const T = (rows) => b.push({ type: 'table', rows });

  b.push({ type: 'title', ru: `ДОГОВОР ПОСТАВКИ № ${contractNumber(state)}`, en: `SUPPLY CONTRACT No. ${contractNumber(state)}` });
  P(`г. ${dash(state.place)}, ${formatDate(state.date, 'ru')}`,
    `${dash(state.place)}, ${formatDate(state.date, 'en')}`);

  P(`${dash(state.buyer_name)} (${dash(state.buyer_country)}, рег. № ${dash(state.buyer_reg)}), именуемое в дальнейшем «Покупатель», в лице ${dash(state.buyer_rep)}, действующего на основании ${dash(state.buyer_basis)}, с одной стороны, и ${dash(state.supplier_name)} (${dash(state.supplier_country)}, рег. № ${dash(state.supplier_reg)}), именуемое в дальнейшем «Поставщик», в лице ${dash(state.supplier_rep)}, действующего на основании ${dash(state.supplier_basis)}, с другой стороны, совместно именуемые «Стороны», руководствуясь Конвенцией ООН о договорах международной купли-продажи товаров (КМКПТ/CISG, Вена, 1980) и Принципами УНИДРУА 2016, заключили настоящий Договор о нижеследующем:`,
    `${dash(state.buyer_name)} (${dash(state.buyer_country)}, reg. No. ${dash(state.buyer_reg)}), hereinafter the "Buyer", represented by ${dash(state.buyer_rep)}, acting on the basis of ${dash(state.buyer_basis)}, of the one part, and ${dash(state.supplier_name)} (${dash(state.supplier_country)}, reg. No. ${dash(state.supplier_reg)}), hereinafter the "Supplier", represented by ${dash(state.supplier_rep)}, acting on the basis of ${dash(state.supplier_basis)}, of the other part, collectively the "Parties", governed by the United Nations Convention on Contracts for the International Sale of Goods (CISG, Vienna 1980) and the UNIDROIT Principles 2016, have agreed as follows:`);

  H('Статья 1. Предмет договора', 'Article 1. Subject Matter');
  P('1.1. Поставщик обязуется передать в собственность Покупателя товар (далее «Товар»), а Покупатель обязуется принять и оплатить Товар в соответствии с условиями настоящего Договора.',
    '1.1. The Supplier undertakes to transfer the title to the goods (the "Goods") to the Buyer, and the Buyer undertakes to accept and pay for the Goods in accordance with this Contract.');
  T([
    ['Наименование Товара / Goods', dash(state.goods_name)],
    ['Код ТН ВЭД / HS Code', dash(state.hs_code)],
    ['Страна происхождения / Country of Origin', dash(state.origin_country)],
    ['Количество / Quantity', `${dash(state.quantity)} ${state.unit || ''}`]
  ]);
  P('1.2. Количество, ассортимент и технические характеристики Товара определяются в Приложении №1 (Спецификация), являющемся неотъемлемой частью настоящего Договора.',
    '1.2. The quantity, assortment and technical specifications of the Goods are set out in Annex No. 1 (Specification), which forms an integral part of this Contract.');

  H('Статья 2. Цена и сумма договора', 'Article 2. Price and Contract Value');
  T([
    ['Цена за единицу / Unit Price', money(state.unit_price, cur)],
    ['Общая сумма / Total Value', money(d.total, cur)],
    ['Сумма прописью / In words', d.totalWords.ru],
    ['Amount in words (EN)', d.totalWords.en]
  ]);
  P('2.1. Цена является фиксированной на весь срок действия Договора, если иное не согласовано Сторонами в письменной форме.',
    '2.1. The price is fixed for the term of this Contract unless otherwise agreed by the Parties in writing.');
  P(`2.2. ${vat.ru}.`, `2.2. ${vat.en}.`);

  H('Статья 3. Порядок оплаты', 'Article 3. Payment Terms');
  P(`3.1. Способ оплаты: ${method.ru}.`, `3.1. Method of payment: ${method.en}.`);
  P(`3.2. Условия оплаты: ${preset.ru}`, `3.2. Payment terms: ${preset.en}`);
  P(`3.3. Банковские реквизиты Поставщика: IBAN ${dash(state.supplier_iban)}, SWIFT ${dash(state.supplier_swift)}, банк ${dash(state.supplier_bank)}.`,
    `3.3. Supplier’s banking details: IBAN ${dash(state.supplier_iban)}, SWIFT ${dash(state.supplier_swift)}, bank ${dash(state.supplier_bank)}.`);
  P('3.4. Датой исполнения обязательства по оплате является дата списания денежных средств с корреспондентского счёта банка Покупателя.',
    '3.4. The payment obligation is deemed performed on the date the funds are debited from the correspondent account of the Buyer’s bank.');
  P('3.5. При просрочке оплаты Покупатель уплачивает проценты в соответствии со ст. 78 КМКПТ по ставке SOFR + 2% годовых за каждый день просрочки.',
    '3.5. In case of late payment the Buyer shall pay interest pursuant to Art. 78 CISG at SOFR + 2% per annum for each day of delay.');

  H('Статья 4. Поставка', 'Article 4. Delivery');
  T([
    ['Условия поставки / Incoterms® 2020', `${state.incoterms} — ${d.incoterms.name_ru}`],
    [d.deliveryPlaceLabel.ru + ' / ' + d.deliveryPlaceLabel.en, dash(state.delivery_place)],
    ['Срок поставки / Delivery Date', formatDate(state.delivery_date, 'ru')],
    ['Вид транспорта / Transport', (R.transport_modes.find(t => t.id === (state.transport || 'road')) || {}).ru || '']
  ]);
  P(`4.1. Поставка осуществляется на условиях ${state.incoterms} (Incoterms® 2020). ${d.incoterms.carrier_ru}.`,
    `4.1. Delivery is made on ${state.incoterms} terms (Incoterms® 2020). ${d.incoterms.carrier_en}.`);
  P(`4.2. Таможенное оформление вывоза обеспечивает ${d.exportCustoms === 'supplier' ? 'Поставщик' : 'Покупатель'}. ${d.importCustoms === 'none'
      ? 'Таможенное оформление ввоза не требуется: поставка осуществляется в пределах единой таможенной территории Евразийского экономического союза.'
      : 'Таможенное оформление ввоза обеспечивает ' + (d.importCustoms === 'supplier' ? 'Поставщик.' : 'Покупатель.')}`,
    `4.2. Export clearance is arranged by the ${d.exportCustoms === 'supplier' ? 'Supplier' : 'Buyer'}. ${d.importCustoms === 'none'
      ? 'No import clearance is required: delivery takes place within the single customs territory of the Eurasian Economic Union.'
      : 'Import clearance is arranged by the ' + (d.importCustoms === 'supplier' ? 'Supplier.' : 'Buyer.')}`);
  P('4.3. Поставка партиями допускается только с письменного согласия Покупателя.',
    '4.3. Partial shipments are permitted only with the Buyer’s written consent.');

  H('Статья 5. Товаросопроводительные документы', 'Article 5. Shipping Documents');
  P('5.1. Поставщик предоставляет следующие документы в течение 5 (пяти) рабочих дней с даты отгрузки:',
    '5.1. The Supplier shall provide the following documents within 5 (five) business days from the date of shipment:');
  T(d.documents.map((doc, i) => [`5.1.${i + 1}`, `${doc.ru} / ${doc.en}`]));
  P('5.2. Документы передаются в цифровом виде через платформу TradingWays Hub. Электронные копии, подписанные квалифицированной ЭЦП, имеют равную юридическую силу с оригиналами.',
    '5.2. Documents are transmitted electronically via the TradingWays Hub platform. Electronic copies signed with a qualified electronic signature have the same legal force as originals.');

  if (d.category.shelf_life) {
    H('Статья 6. Качество и срок годности', 'Article 6. Quality and Shelf Life');
    P('6.1. Товар должен соответствовать условиям настоящего Договора (ст. 35 КМКПТ), Спецификации (Приложение №1) и действующим техническим регламентам ЕАЭС.',
      '6.1. The Goods shall conform to this Contract (Art. 35 CISG), the Specification (Annex 1) and the applicable EAEU technical regulations.');
    P(`6.2. Срок годности Товара составляет ${dash(state.shelf_life_value)} ${state.shelf_life_unit === 'years' ? 'лет' : 'месяцев'} с даты производства. На момент отгрузки остаточный срок годности должен составлять не менее ${dash(state.min_remaining_pct)}% от полного срока годности. Поставщик обязан указывать дату производства и срок годности на каждой единице упаковки в соответствии с ТР ТС 022/2011.`,
      `6.2. The shelf life of the Goods is ${dash(state.shelf_life_value)} ${state.shelf_life_unit === 'years' ? 'years' : 'months'} from the date of manufacture. At the time of shipment the remaining shelf life shall be not less than ${dash(state.min_remaining_pct)}% of the full shelf life. The Supplier shall mark the date of manufacture and the shelf life on each packaging unit in accordance with TR CU 022/2011.`);
  } else {
    H('Статья 6. Качество и гарантии', 'Article 6. Quality and Warranties');
    P('6.1. Товар должен соответствовать условиям настоящего Договора (ст. 35 КМКПТ) и Спецификации (Приложение №1).',
      '6.1. The Goods shall conform to this Contract (Art. 35 CISG) and the Specification (Annex 1).');
    P(`6.2. Гарантийный срок на Товар составляет ${dash(state.warranty_months)} месяцев с даты поставки.`,
      `6.2. The warranty period for the Goods is ${dash(state.warranty_months)} months from the date of delivery.`);
  }
  P('6.3. Покупатель обязан осмотреть Товар в кратчайший практически возможный срок (ст. 38 КМКПТ). Претензии по явным дефектам заявляются в течение 14 (четырнадцати) календарных дней с даты получения, по скрытым — в пределах срока годности (гарантийного срока).',
    '6.3. The Buyer shall examine the Goods within the shortest practicable period (Art. 38 CISG). Claims for apparent defects shall be raised within 14 (fourteen) calendar days from receipt; claims for latent defects, within the shelf life (warranty period).');

  H('Статья 7. Переход права собственности и риска', 'Article 7. Transfer of Title and Risk');
  P(`7.1. Право собственности на Товар и риск случайной гибели или повреждения переходят от Поставщика к Покупателю ${d.incoterms.risk_ru}, в соответствии с условиями ${state.incoterms} (Incoterms® 2020) и ст. 66–70 КМКПТ.`,
    `7.1. Title to the Goods and the risk of accidental loss or damage pass from the Supplier to the Buyer ${d.incoterms.risk_en}, in accordance with ${state.incoterms} (Incoterms® 2020) and Arts. 66–70 CISG.`);

  H('Статья 8. Ответственность сторон', 'Article 8. Liability');
  P('8.1. За нарушение срока поставки Поставщик уплачивает пеню в размере 0,1% от стоимости не поставленного в срок Товара за каждый день просрочки, но не более 10% от суммы Договора.',
    '8.1. For late delivery the Supplier shall pay a penalty of 0.1% of the value of the overdue Goods per day of delay, capped at 10% of the Contract value.');
  P('8.2. За нарушение срока оплаты Покупатель уплачивает проценты согласно ст. 3.5 настоящего Договора.',
    '8.2. For late payment the Buyer shall pay interest under Article 3.5 of this Contract.');
  P('8.3. Стороны не несут ответственности за упущенную выгоду друг друга, за исключением случаев умысла или грубой небрежности. Совокупная ответственность каждой из Сторон ограничивается суммой настоящего Договора.',
    '8.3. Neither Party is liable for the other Party’s loss of profit, except in cases of wilful misconduct or gross negligence. The aggregate liability of each Party is limited to the Contract value.');

  H('Статья 9. Форс-мажор', 'Article 9. Force Majeure');
  P('9.1. Стороны освобождаются от ответственности за неисполнение обязательств вследствие обстоятельств непреодолимой силы (ст. 79 КМКПТ): стихийные бедствия, война, эпидемии, государственные ограничения.',
    '9.1. The Parties are released from liability for non-performance caused by force majeure (Art. 79 CISG): natural disasters, war, epidemics, governmental restrictions.');
  P('9.2. Сторона, ссылающаяся на форс-мажор, уведомляет другую Сторону в течение 5 (пяти) рабочих дней через платформу TradingWays Hub с подтверждением справкой торгово-промышленной палаты.',
    '9.2. The Party invoking force majeure shall notify the other Party within 5 (five) business days via the TradingWays Hub platform, supported by a certificate of the chamber of commerce.');
  P('9.3. Если обстоятельства непреодолимой силы продолжаются более 60 (шестидесяти) календарных дней, любая из Сторон вправе расторгнуть Договор без штрафных санкций, направив уведомление за 10 (десять) дней.',
    '9.3. If force majeure lasts more than 60 (sixty) calendar days, either Party may terminate the Contract without penalty upon 10 (ten) days’ notice.');

  H('Статья 10. Санкционное соответствие', 'Article 10. Sanctions Compliance');
  P('10.1. Каждая из Сторон заверяет, что не является лицом, находящимся под санкциями ООН, США (OFAC), ЕС или Великобритании, и не осуществляет деятельность на подсанкционных территориях.',
    '10.1. Each Party represents that it is not a person subject to UN, US (OFAC), EU or UK sanctions and does not operate in sanctioned territories.');

  H('Статья 11. Конфиденциальность', 'Article 11. Confidentiality');
  P('11.1. Стороны обязуются не раскрывать условия настоящего Договора и полученную в ходе его исполнения информацию третьим лицам без письменного согласия другой Стороны. Обязательство действует 3 (три) года после прекращения Договора.',
    '11.1. The Parties undertake not to disclose the terms of this Contract or information obtained during its performance to third parties without the other Party’s written consent. This obligation survives for 3 (three) years after termination.');

  H('Статья 12. Применимое право и разрешение споров', 'Article 12. Applicable Law and Dispute Resolution');
  P('12.1. Настоящий Договор регулируется КМКПТ (Вена, 1980). По вопросам, не урегулированным Конвенцией, применяются Принципы УНИДРУА 2016.',
    '12.1. This Contract is governed by the CISG (Vienna 1980). Matters not settled by the Convention are governed by the UNIDROIT Principles 2016.');
  T([
    ['Применимое национальное право (субсидиарно) / Subsidiary national law', d.law.ru],
    ['Арбитраж / Arbitration', d.arbitration.ru],
    ['Место арбитража / Seat', d.seat.ru]
  ]);
  P('12.2. Срок досудебных переговоров — 30 (тридцать) календарных дней с даты письменной претензии.',
    '12.2. The pre-arbitration negotiation period is 30 (thirty) calendar days from the date of a written claim.');
  P('12.3. Язык арбитражного разбирательства — английский, если Стороны не договорились об ином.',
    '12.3. The language of arbitration is English unless the Parties agree otherwise.');

  H('Статья 13. Срок действия и расторжение', 'Article 13. Term and Termination');
  P('13.1. Договор вступает в силу с даты подписания обеими Сторонами и действует до полного исполнения обязательств.',
    '13.1. The Contract enters into force on signature by both Parties and remains in effect until all obligations are performed.');
  P('13.2. Покупатель вправе расторгнуть Договор при существенном нарушении со стороны Поставщика (ст. 49 КМКПТ). Поставщик вправе расторгнуть Договор при просрочке оплаты свыше 30 дней или ином существенном нарушении (ст. 64 КМКПТ).',
    '13.2. The Buyer may terminate the Contract upon a fundamental breach by the Supplier (Art. 49 CISG). The Supplier may terminate upon payment delay exceeding 30 days or another fundamental breach (Art. 64 CISG).');

  H('Статья 14. Заключительные положения', 'Article 14. General Provisions');
  P('14.1. Изменения и дополнения действительны в письменной форме, подписанной уполномоченными представителями обеих Сторон, либо в форме электронного документа, подписанного квалифицированной ЭЦП на платформе TradingWays Hub.',
    '14.1. Amendments are valid in writing signed by authorised representatives of both Parties, or as an electronic document signed with a qualified electronic signature on the TradingWays Hub platform.');
  P('14.2. Договор составлен на русском и английском языках. При наличии противоречий приоритет имеет английская версия.',
    '14.2. The Contract is executed in Russian and English. In case of discrepancy, the English version prevails.');
  P('14.3. Договор составлен в двух экземплярах равной юридической силы. Электронная версия на платформе TradingWays Hub является официальной.',
    '14.3. The Contract is executed in two counterparts of equal legal force. The electronic version on the TradingWays Hub platform is the official one.');
  P(`14.4. Неотъемлемыми частями Договора являются: Приложение №1 (Спецификация), Приложение №2 (График поставок и платежей)${state.local_content ? ', Приложение №3 (Отчёт о местном содержании)' : ''}.`,
    `14.4. The following form integral parts of this Contract: Annex 1 (Specification), Annex 2 (Delivery and Payment Schedule)${state.local_content ? ', Annex 3 (Local Content Report)' : ''}.`);

  H('Реквизиты и подписи сторон', 'Details and Signatures of the Parties');
  T([
    ['ПОКУПАТЕЛЬ / BUYER', 'ПОСТАВЩИК / SUPPLIER'],
    [dash(state.buyer_name), dash(state.supplier_name)],
    [`Рег. №: ${dash(state.buyer_reg)}`, `Рег. №: ${dash(state.supplier_reg)}`],
    [`Адрес: ${dash(state.buyer_address)}`, `Адрес: ${dash(state.supplier_address)}`],
    [`Банк: ${dash(state.buyer_bank)}`, `Банк: ${dash(state.supplier_bank)}`],
    [`IBAN: ${dash(state.buyer_iban)}`, `IBAN: ${dash(state.supplier_iban)}`],
    [`SWIFT: ${dash(state.buyer_swift)}`, `SWIFT: ${dash(state.supplier_swift)}`],
    ['Подпись: ______________', 'Подпись: ______________']
  ]);

  b.push({ type: 'pagebreak' });
  H(`Приложение №1 — Спецификация (к Договору № ${contractNumber(state)})`, `Annex No. 1 — Specification (to Contract No. ${contractNumber(state)})`);
  T([
    ['№', 'Наименование / Description', 'Ед. / Unit', 'Кол-во / Qty', 'Цена / Price', 'Сумма / Amount'],
    ['1', dash(state.goods_name), state.unit || '', dash(state.quantity), money(state.unit_price, cur), money(d.total, cur)],
    ['', 'ИТОГО / TOTAL', '', '', '', money(d.total, cur)]
  ]);
  P(`Технические характеристики: ${dash(state.goods_specs)}`, `Technical specifications: ${dash(state.goods_specs)}`);

  b.push({ type: 'pagebreak' });
  H(`Приложение №2 — График поставок и платежей (к Договору № ${contractNumber(state)})`, `Annex No. 2 — Delivery and Payment Schedule (to Contract No. ${contractNumber(state)})`);
  T([
    ['Партия / Batch', 'Кол-во / Qty', 'Дата отгрузки / Ship date', 'Сумма / Amount', 'Дата оплаты / Pay date'],
    ['1', dash(state.quantity), formatDate(state.delivery_date, 'ru'), money(d.total, cur), preset.label]
  ]);

  if (state.local_content) {
    b.push({ type: 'pagebreak' });
    H(`Приложение №3 — Отчёт о местном содержании (к Договору № ${contractNumber(state)})`, `Annex No. 3 — Local Content Report (to Contract No. ${contractNumber(state)})`);
    P('Заполняется только при наличии в договоре требований о казахстанском содержании (Закон РК «О недрах и недропользовании», Постановление Правительства РК №133 от 14.02.2013). Для экспортных договоров между частными компаниями, не связанных с недропользованием, не является обязательным.',
      'To be completed only where the contract contains Kazakhstani local content requirements. Not mandatory for export contracts between private companies outside the subsoil use sector.');
    T([
      ['Показатель', 'Значение (%)', 'Подтверждающий документ'],
      ['Доля казахстанских кадров в ФОТ', '______', 'Сведения Поставщика'],
      ['Доля граждан РК в штате', '______', 'Сведения Поставщика'],
      ['Казахстанское содержание в Товаре', '______', 'Сертификат СТ-KZ (при наличии)']
    ]);
  }

  return { blocks: b, derived: d, number: contractNumber(state) };
}

const ENGINE = { derive, buildContract, amountInWords, ruNumber, enNumber, contractNumber, formatDate };
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof globalThis !== 'undefined') globalThis.ENGINE = ENGINE;
