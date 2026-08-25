/* TWH Contract Generator — слой правил (knowledge layer).
 *
 * Единственный источник правды по бизнес-логике договора.
 * UI (index.html) и тесты (verify.mjs) читают этот файл и ничего не решают сами.
 * Источник правил: TWH_Supply_Contract_v1.1_with_field_guide.docx, Часть I.
 *
 * Правило работы: любое изменение юридической логики делается здесь,
 * в index.html правится только отображение.
 */

const RULES = {
  meta: {
    template_version: '1.1',
    generator_version: '0.1.0',
    source: 'TWH_Supply_Contract_v1.1_with_field_guide.docx',
    contract_number_format: 'TWH-{year}-{seq5}'
  },

  /* I.2 — Incoterms 2020. road_ok = применим для автотранспорта по СНГ. */
  incoterms: {
    EXW: {
      name_ru: 'Ex Works (Франко завод)',
      name_en: 'Ex Works',
      road_ok: true,
      carrier_ru: 'Покупатель вывозит с завода Поставщика',
      carrier_en: 'Buyer collects from the Supplier’s works',
      risk_ru: 'при предоставлении Товара в распоряжение Покупателя на территории Поставщика',
      risk_en: 'when the Goods are placed at the Buyer’s disposal at the Supplier’s premises',
      place_label_ru: 'Адрес завода / склада отгрузки Поставщика',
      place_label_en: 'Supplier’s works / warehouse address',
      insurance: 'optional',
      export_customs: 'buyer',
      import_customs: 'buyer'
    },
    FCA: {
      name_ru: 'Free Carrier (Франко перевозчик)',
      name_en: 'Free Carrier',
      road_ok: true,
      carrier_ru: 'Поставщик передаёт Товар перевозчику Покупателя',
      carrier_en: 'Supplier hands the Goods over to the Buyer’s carrier',
      risk_ru: 'в момент передачи Товара перевозчику, указанному Покупателем',
      risk_en: 'when the Goods are handed over to the carrier nominated by the Buyer',
      place_label_ru: 'Место передачи перевозчику',
      place_label_en: 'Place of handover to the carrier',
      insurance: 'optional',
      export_customs: 'supplier',
      import_customs: 'buyer'
    },
    DAP: {
      name_ru: 'Delivered at Place (Поставка в месте назначения)',
      name_en: 'Delivered at Place',
      road_ok: true,
      default_for_food_cis: true,
      carrier_ru: 'Поставщик везёт до склада Покупателя, растаможку импорта делает Покупатель',
      carrier_en: 'Supplier delivers to the Buyer’s warehouse; the Buyer clears the Goods for import',
      risk_ru: 'в момент предоставления Товара в распоряжение Покупателя в согласованном пункте назначения',
      risk_en: 'when the Goods are placed at the Buyer’s disposal at the agreed destination',
      place_label_ru: 'Адрес склада Покупателя (пункт назначения)',
      place_label_en: 'Buyer’s warehouse address (destination)',
      insurance: 'optional',
      export_customs: 'supplier',
      import_customs: 'buyer'
    },
    DDP: {
      name_ru: 'Delivered Duty Paid (Поставка с оплатой пошлин)',
      name_en: 'Delivered Duty Paid',
      road_ok: true,
      carrier_ru: 'Поставщик везёт до склада Покупателя и сам растаможивает импорт',
      carrier_en: 'Supplier delivers to the Buyer’s warehouse and clears the Goods for import',
      risk_ru: 'в момент предоставления растаможенного Товара в распоряжение Покупателя в пункте назначения',
      risk_en: 'when the Goods, cleared for import, are placed at the Buyer’s disposal at the destination',
      place_label_ru: 'Адрес склада Покупателя (пункт назначения)',
      place_label_en: 'Buyer’s warehouse address (destination)',
      insurance: 'optional',
      export_customs: 'supplier',
      import_customs: 'supplier'
    },
    CIF: {
      name_ru: 'Cost, Insurance and Freight (морской)',
      name_en: 'Cost, Insurance and Freight',
      road_ok: false,
      carrier_ru: 'Поставщик оплачивает фрахт и страховку до порта назначения',
      carrier_en: 'Supplier pays freight and insurance to the port of destination',
      risk_ru: 'в момент погрузки Товара на борт судна в порту отгрузки',
      risk_en: 'when the Goods are placed on board the vessel at the port of shipment',
      place_label_ru: 'Порт назначения',
      place_label_en: 'Port of destination',
      insurance: 'required',
      export_customs: 'supplier',
      import_customs: 'buyer'
    },
    CIP: {
      name_ru: 'Carriage and Insurance Paid To',
      name_en: 'Carriage and Insurance Paid To',
      road_ok: true,
      carrier_ru: 'Поставщик оплачивает перевозку и страховку до пункта назначения',
      carrier_en: 'Supplier pays carriage and insurance to the named place',
      risk_ru: 'в момент передачи Товара первому перевозчику',
      risk_en: 'when the Goods are handed over to the first carrier',
      place_label_ru: 'Пункт назначения',
      place_label_en: 'Named place of destination',
      insurance: 'required',
      export_customs: 'supplier',
      import_customs: 'buyer'
    }
  },

  /* I.6 — направления поставки из Казахстана. */
  routes: {
    RU: {
      name_ru: 'Россия', name_en: 'Russia', eaeu: true, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК (альтернатива по соглашению сторон: МКАС при ТПП РФ)',
      arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan (alternative: ICAC at the RF CCI)',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    KG: {
      name_ru: 'Кыргызстан', name_en: 'Kyrgyzstan', eaeu: true, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК (альтернатива: КТМС, Бишкек)',
      arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan (alternative: KTMS, Bishkek)',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    BY: {
      name_ru: 'Беларусь', name_en: 'Belarus', eaeu: true, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК', arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    AM: {
      name_ru: 'Армения', name_en: 'Armenia', eaeu: true, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК', arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    UZ: {
      name_ru: 'Узбекистан', name_en: 'Uzbekistan', eaeu: false, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК (альтернатива: Ташкентский международный арбитраж)',
      arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan (alternative: Tashkent International Arbitration Centre)',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    TJ: {
      name_ru: 'Таджикистан', name_en: 'Tajikistan', eaeu: false, cis_fta: true,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'МЦАРС при ТПП РК', arbitration_en: 'IAC at the Chamber of Commerce of Kazakhstan',
      seat_ru: 'Алматы, Казахстан', seat_en: 'Almaty, Kazakhstan',
      cert_origin: 'ST1'
    },
    OTHER: {
      name_ru: 'Дальнее зарубежье', name_en: 'Other country', eaeu: false, cis_fta: false,
      law_ru: 'Право Республики Казахстан', law_en: 'Law of the Republic of Kazakhstan',
      arbitration_ru: 'ICC International Court of Arbitration',
      arbitration_en: 'ICC International Court of Arbitration',
      seat_ru: 'Вена, Австрия', seat_en: 'Vienna, Austria',
      cert_origin: 'FORM_A'
    }
  },

  /* I.5 — товаросопроводительные документы. */
  documents: [
    { id: '5.1.1', ru: 'Коммерческий инвойс (3 оригинала)', en: 'Commercial Invoice (3 originals)', when: 'always' },
    { id: '5.1.2', ru: 'Упаковочный лист', en: 'Packing List', when: 'always' },
    { id: '5.1.3', ru: 'CMR накладная (оригинал)', en: 'CMR Waybill (original)', when: 'road' },
    { id: '5.1.3b', ru: 'Коносамент / Авианакладная (оригинал)', en: 'Bill of Lading / Airway Bill (original)', when: 'sea_air' },
    { id: '5.1.4', ru: 'Сертификат происхождения', en: 'Certificate of Origin', when: 'origin_cert' },
    { id: '5.1.5', ru: 'Декларация о соответствии ЕАЭС (ТР ТС)', en: 'EAEU Declaration of Conformity (TR CU)', when: 'food' },
    { id: '5.1.6', ru: 'Фитосанитарный сертификат', en: 'Phytosanitary Certificate', when: 'phyto' },
    { id: '5.1.7', ru: 'Страховой полис', en: 'Insurance Policy', when: 'insurance' },
    { id: '5.1.8', ru: 'Удостоверение качества и безопасности (ТР ТС 021/2011)', en: 'Certificate of Quality and Safety (TR CU 021/2011)', when: 'food' },
    { id: '5.1.9', ru: 'Ветеринарный сертификат', en: 'Veterinary Certificate', when: 'animal_origin' }
  ],

  /* I.7 + категории товара. */
  categories: {
    bakery: {
      name_ru: 'Кондитерские и мучные изделия (вафли, печенье)',
      name_en: 'Confectionery and bakery products',
      food: true,
      shelf_life: true,
      phyto_required: false,
      hs_codes: [
        { code: '1905.31', ru: 'Сладкое печенье', en: 'Sweet biscuits' },
        { code: '1905.32', ru: 'Вафли и вафельные листы', en: 'Waffles and wafers' },
        { code: '1905.90.20', ru: 'Пряники и аналогичные изделия', en: 'Gingerbread and similar' },
        { code: '1905.90.60', ru: 'Прочие хлебобулочные изделия', en: 'Other bread and pastry' },
        { code: '1905.90.90', ru: 'Прочие мучные кондитерские изделия', en: 'Other pastry goods' }
      ]
    },
    grain: {
      name_ru: 'Зерно, мука, сухофрукты (растительное сырьё)',
      name_en: 'Grain, flour, dried fruit',
      food: true,
      shelf_life: true,
      phyto_required: true,
      hs_codes: [
        { code: '1001.99', ru: 'Пшеница прочая', en: 'Wheat, other' },
        { code: '1101.00', ru: 'Мука пшеничная', en: 'Wheat flour' },
        { code: '0813.40', ru: 'Сухофрукты прочие', en: 'Other dried fruit' }
      ]
    },
    other: {
      name_ru: 'Промышленные товары (не пищевые)',
      name_en: 'Industrial (non-food) goods',
      food: false,
      shelf_life: false,
      phyto_required: false,
      hs_codes: []
    }
  },

  /* I.3 — пресеты оплаты. */
  payment_presets: [
    {
      id: '30_70', default: true, label: '30% аванс + 70% после отгрузки',
      ru: '30% (тридцать процентов) от суммы Договора — в течение 3 (трёх) банковских дней с даты подписания Договора; 70% (семьдесят процентов) — в течение 5 (пяти) банковских дней с даты предоставления CMR и коммерческого инвойса.',
      en: '30% (thirty per cent) of the Contract value within 3 (three) banking days from the date of signing; 70% (seventy per cent) within 5 (five) banking days from the date of submission of the CMR and the commercial invoice.',
      note: 'Норма рынка для СНГ, средний чек до $50k, первые сделки.'
    },
    {
      id: '50_50', label: '50% аванс + 50% по CMR/BL',
      ru: '50% (пятьдесят процентов) от суммы Договора — предоплата в течение 3 (трёх) банковских дней с даты подписания Договора; 50% (пятьдесят процентов) — в течение 5 (пяти) банковских дней с даты предоставления CMR / коносамента.',
      en: '50% (fifty per cent) prepayment within 3 (three) banking days from signing; 50% (fifty per cent) within 5 (five) banking days from submission of the CMR / Bill of Lading.',
      note: 'Новый контрагент без истории, повышенный риск.'
    },
    {
      id: 'prepay_100', label: '100% предоплата',
      ru: '100% (сто процентов) от суммы Договора — предоплата в течение 5 (пяти) банковских дней с даты подписания Договора, до отгрузки Товара.',
      en: '100% (one hundred per cent) of the Contract value prepaid within 5 (five) banking days from signing, prior to shipment.',
      note: 'Небольшие объёмы, разовые поставки.'
    },
    {
      id: 'lc', label: 'Аккредитив (L/C, UCP 600)',
      ru: 'Оплата производится безотзывным документарным аккредитивом, открываемым Покупателем в пользу Поставщика в течение 10 (десяти) банковских дней с даты подписания Договора, в соответствии с UCP 600 ICC. Раскрытие аккредитива — против предоставления комплекта документов по ст. 5.1 настоящего Договора.',
      en: 'Payment shall be made by an irrevocable documentary letter of credit opened by the Buyer in favour of the Supplier within 10 (ten) banking days from signing, subject to UCP 600 ICC. The credit shall be available against the set of documents listed in Article 5.1.',
      note: 'От $50k, новые нерезиденты, дальнее зарубежье.'
    },
    {
      id: 'net_30', label: 'Постоплата 30 дней',
      ru: '100% (сто процентов) от суммы Договора — в течение 30 (тридцати) календарных дней с даты приёмки Товара Покупателем.',
      en: '100% (one hundred per cent) of the Contract value within 30 (thirty) calendar days from acceptance of the Goods by the Buyer.',
      note: 'Только для долгосрочных проверенных партнёров.'
    },
    {
      id: 'escrow', label: 'Эскроу TWH',
      ru: 'Оплата производится через эскроу-сервис платформы TradingWays Hub. Покупатель депонирует 100% суммы Договора до отгрузки. Раскрытие эскроу в пользу Поставщика — в течение 3 (трёх) банковских дней с даты подтверждения Покупателем приёмки Товара на платформе.',
      en: 'Payment shall be made through the TradingWays Hub escrow service. The Buyer deposits 100% of the Contract value prior to shipment. The escrow is released to the Supplier within 3 (three) banking days from the Buyer’s confirmation of acceptance on the platform.',
      note: 'Пункт 3.5 договора. В прототипе только текст, без реального счёта.'
    }
  ],

  payment_methods: [
    { id: 'wire', ru: 'Банковский перевод', en: 'Wire transfer' },
    { id: 'lc', ru: 'Аккредитив (L/C)', en: 'Letter of Credit' },
    { id: 'escrow', ru: 'Эскроу TradingWays Hub', en: 'TradingWays Hub escrow' }
  ],

  currencies: [
    { code: 'USD', ru_one: 'доллар США', ru_few: 'доллара США', ru_many: 'долларов США', gender: 'm', minor_ru: ['цент', 'цента', 'центов'], en: 'US Dollars', en_minor: 'cents' },
    { code: 'EUR', ru_one: 'евро', ru_few: 'евро', ru_many: 'евро', gender: 'm', minor_ru: ['цент', 'цента', 'центов'], en: 'Euro', en_minor: 'cents' },
    { code: 'KZT', ru_one: 'тенге', ru_few: 'тенге', ru_many: 'тенге', gender: 'm', minor_ru: ['тиын', 'тиына', 'тиынов'], en: 'Kazakhstani Tenge', en_minor: 'tiyn' },
    { code: 'RUB', ru_one: 'рубль', ru_few: 'рубля', ru_many: 'рублей', gender: 'm', minor_ru: ['копейка', 'копейки', 'копеек'], en: 'Russian Roubles', en_minor: 'kopecks' }
  ],

  vat_modes: [
    { id: 'export_0', default: true, ru: 'Экспорт, ставка НДС 0% с подтверждением экспорта', en: 'Export, 0% VAT subject to confirmation of export' },
    { id: 'domestic', ru: 'НДС по ставке страны Поставщика (РК — 16%)', en: 'VAT at the rate of the Supplier’s country (Kazakhstan — 16%)' },
    { id: 'none', ru: 'Без НДС (Поставщик не является плательщиком)', en: 'Without VAT (the Supplier is not a VAT payer)' }
  ],

  shelf_life_defaults: { value: 12, unit: 'months', min_remaining_pct: 75 },

  transport_modes: [
    { id: 'road', ru: 'Автотранспорт', en: 'Road' },
    { id: 'rail', ru: 'Железная дорога', en: 'Rail' },
    { id: 'sea_air', ru: 'Море / авиа', en: 'Sea / air' }
  ],

  /* Открытые вопросы к Бекмырзе. Показываются в UI над договором,
   * чтобы прототип не выдавал спорную норму за факт. */
  open_questions: [
    {
      id: 'eaeu_customs',
      when: 'route_eaeu',
      text: 'Маршрут внутри ЕАЭС: таможенного оформления импорта между странами ЕАЭС нет. В гайде для DAP указано «покупатель растаможивает» — уточнить у Бекмырзы, как формулировать для ЕАЭС.'
    },
    {
      id: 'st1_eaeu',
      when: 'route_eaeu',
      text: 'СТ-1 внутри ЕАЭС обычно не требуют (товар в свободном обращении). Сертификат нужен для преференций по зоне свободной торговли СНГ, то есть для Узбекистана и Таджикистана. Оставлен по гайду, требует подтверждения.'
    },
    {
      id: 'vat_export',
      when: 'vat_export',
      text: 'Ставка 16% в гайде — внутренняя ставка РК. При экспорте применяется 0% с подтверждением. Проверить формулировку ст. 2.2 с бухгалтером завода.'
    },
    {
      id: 'en_text',
      when: 'always',
      text: 'Английский текст статей 6.2, 5.1.8, 5.1.9 и 12.6 в шаблон v1.1 не входил, переведён здесь и требует вычитки юристом.'
    },
    {
      id: 'insurance_dap',
      when: 'incoterms_dap',
      text: 'В переписке было «при DAP страховка на продавце». По Incoterms 2020 обязательная страховка только у CIF и CIP. Реализовано по документу: при DAP полис необязателен.'
    }
  ]
};

if (typeof module !== 'undefined' && module.exports) module.exports = { RULES };
if (typeof globalThis !== 'undefined') globalThis.RULES = RULES;
