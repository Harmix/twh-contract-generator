/* Проверка логики генератора. Запуск: node verify.mjs
 * Тесты детерминированные, без сети и без браузера.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { RULES } = require('./rules.js');
globalThis.RULES = RULES;
const E = require('./engine.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const group = n => console.log('\n' + n);

const base = {
  contract_year: 2026, contract_seq: 7, category: 'bakery', route: 'UZ', transport: 'road',
  incoterms: 'DAP', currency: 'USD', vat_mode: 'export_0', payment_preset: '30_70',
  payment_method: 'wire', quantity: 18000, unit_price: 2.35, unit: 'кг',
  shelf_life_value: 9, shelf_life_unit: 'months', min_remaining_pct: 75
};
const s = over => ({ ...base, ...over });
const ids = d => d.documents.map(x => x.id);

group('Номер договора');
ok('формат TWH-{год}-{5 цифр}', E.contractNumber(s()) === 'TWH-2026-00007', E.contractNumber(s()));

group('Страховка зависит только от Incoterms');
for (const t of ['EXW', 'FCA', 'DAP', 'DDP']) {
  ok(`${t}: полис не обязателен`, E.derive(s({ incoterms: t })).insuranceRequired === false);
  ok(`${t}: 5.1.7 не в списке`, !ids(E.derive(s({ incoterms: t }))).includes('5.1.7'));
}
for (const t of ['CIF', 'CIP']) {
  ok(`${t}: полис обязателен`, E.derive(s({ incoterms: t })).insuranceRequired === true);
  ok(`${t}: 5.1.7 в списке`, ids(E.derive(s({ incoterms: t, transport: 'sea_air' }))).includes('5.1.7'));
}

group('Растаможка ввоза');
ok('ЕАЭС (Россия): не требуется', E.derive(s({ route: 'RU' })).importCustoms === 'none');
ok('ЕАЭС (Кыргызстан): не требуется', E.derive(s({ route: 'KG' })).importCustoms === 'none');
ok('Узбекистан, DAP: Покупатель', E.derive(s({ route: 'UZ', incoterms: 'DAP' })).importCustoms === 'buyer');
ok('Узбекистан, DDP: Поставщик', E.derive(s({ route: 'UZ', incoterms: 'DDP' })).importCustoms === 'supplier');
ok('вывоз при EXW на Покупателе', E.derive(s({ incoterms: 'EXW' })).exportCustoms === 'buyer');

group('Документы для вафель');
const bake = E.derive(s());
ok('инвойс, упаковочный, CMR на месте', ['5.1.1', '5.1.2', '5.1.3'].every(i => ids(bake).includes(i)));
ok('фитосанитарный исключён', !ids(bake).includes('5.1.6'));
ok('ветеринарный исключён', !ids(bake).includes('5.1.9'));
ok('декларация ЕАЭС и удостоверение качества есть', ids(bake).includes('5.1.5') && ids(bake).includes('5.1.8'));
ok('исключения показаны юристу', bake.excluded.length === 3, JSON.stringify(bake.excluded.map(e => e.id)));

const withMeat = E.derive(s({ contains_animal_products: true }));
ok('состав с молоком → ветеринарный появляется', ids(withMeat).includes('5.1.9'));

const grain = E.derive(s({ category: 'grain' }));
ok('зерно → фитосанитарный обязателен', ids(grain).includes('5.1.6'));

group('Сертификат происхождения по маршруту');
ok('СНГ → СТ-1', E.derive(s({ route: 'RU' })).documents.find(d => d.id === '5.1.4').ru.includes('СТ-1'));
ok('дальнее зарубежье → Form A', E.derive(s({ route: 'OTHER' })).documents.find(d => d.id === '5.1.4').ru.includes('Form A'));

group('Транспорт');
ok('авто → CMR, без коносамента', ids(E.derive(s({ transport: 'road' }))).includes('5.1.3') && !ids(E.derive(s({ transport: 'road' }))).includes('5.1.3b'));
ok('море → коносамент, без CMR', ids(E.derive(s({ transport: 'sea_air' }))).includes('5.1.3b') && !ids(E.derive(s({ transport: 'sea_air' }))).includes('5.1.3'));
ok('CIF на фурах ловится предупреждением', E.derive(s({ incoterms: 'CIF', transport: 'road' })).warnings.some(w => w.includes('морской')));

group('Право и арбитраж');
for (const r of Object.keys(RULES.routes)) {
  const d = E.derive(s({ route: r }));
  ok(`${r}: право и место заполнены`, !!d.law.ru && !!d.seat.ru && !!d.arbitration.ru);
}
ok('дальнее зарубежье → ICC', E.derive(s({ route: 'OTHER' })).arbitration.ru.includes('ICC'));
ok('СНГ → МЦАРС', E.derive(s({ route: 'RU' })).arbitration.ru.includes('МЦАРС'));

group('Сумма и пропись');
const d1 = E.derive(s());
ok('18000 × 2.35 = 42300', d1.total === 42300, String(d1.total));
ok('пропись RU', d1.totalWords.ru === 'Сорок две тысячи триста долларов США 00 центов', d1.totalWords.ru);
ok('пропись EN', d1.totalWords.en === 'Forty-two thousand three hundred US Dollars 00 cents', d1.totalWords.en);
const w = (n, c) => E.amountInWords(n, c);
ok('1 → один доллар', w(1, 'USD').ru.startsWith('Один доллар США'), w(1, 'USD').ru);
ok('2 → два доллара', w(2, 'USD').ru.startsWith('Два доллара США'), w(2, 'USD').ru);
ok('5 → пять долларов', w(5, 'USD').ru.startsWith('Пять долларов США'), w(5, 'USD').ru);
ok('11 → одиннадцать долларов', w(11, 'USD').ru.startsWith('Одиннадцать долларов США'), w(11, 'USD').ru);
ok('21 → двадцать один доллар', w(21, 'USD').ru.startsWith('Двадцать один доллар США'), w(21, 'USD').ru);
ok('1000 → одна тысяча', w(1000, 'KZT').ru.startsWith('Одна тысяча тенге'), w(1000, 'KZT').ru);
ok('2000 → две тысячи', w(2000, 'KZT').ru.startsWith('Две тысячи тенге'), w(2000, 'KZT').ru);
ok('5000 → пять тысяч', w(5000, 'KZT').ru.startsWith('Пять тысяч тенге'), w(5000, 'KZT').ru);
ok('копейки считаются', w(1234.56, 'RUB').ru.endsWith('56 копеек'), w(1234.56, 'RUB').ru);
ok('одна копейка', w(0.01, 'RUB').ru.endsWith('01 копейка'), w(0.01, 'RUB').ru);
ok('1 234 567 EN', w(1234567, 'USD').en.startsWith('One million two hundred and thirty-four thousand five hundred and sixty-seven'), w(1234567, 'USD').en);

group('Предупреждения');
ok('сумма > 50k → совет про аккредитив', E.derive(s({ quantity: 30000 })).warnings.some(x => x.includes('аккредитив')));
ok('пищёвка без срока годности → предупреждение', E.derive(s({ shelf_life_value: '' })).warnings.some(x => x.includes('срок годности')));
ok('DAP внутри ЕАЭС → пояснение', E.derive(s({ route: 'RU' })).warnings.some(x => x.includes('ЕАЭС')));

group('Открытые вопросы к Бекмырзе');
ok('ЕАЭС поднимает вопрос по СТ-1', E.derive(s({ route: 'RU' })).questions.some(q => q.id === 'st1_eaeu'));
ok('не-ЕАЭС не поднимает', !E.derive(s({ route: 'UZ' })).questions.some(q => q.id === 'st1_eaeu'));
ok('вопрос про EN текст всегда виден', E.derive(s()).questions.some(q => q.id === 'en_text'));
ok('DAP поднимает вопрос про страховку', E.derive(s({ incoterms: 'DAP' })).questions.some(q => q.id === 'insurance_dap'));

group('Даты');
ok('RU: 01 сентября 2026 г.', E.formatDate('2026-09-01', 'ru') === '01 сентября 2026 г.', E.formatDate('2026-09-01', 'ru'));
ok('EN: 01 September 2026', E.formatDate('2026-09-01', 'en') === '01 September 2026', E.formatDate('2026-09-01', 'en'));
ok('пустая дата → прочерк', E.formatDate('', 'ru').includes('___'));
ok('мусор в дате не ломает', E.formatDate('завтра', 'ru').includes('завтра') || E.formatDate('завтра', 'ru').includes('___'));

group('Сборка договора');
const built = E.buildContract(s());
const text = built.blocks.map(b => (b.ru || '') + ' ' + (b.en || '') +
  (b.rows ? b.rows.flat().join(' ') : '')).join('\n');
ok('срок годности вместо гарантии для пищёвки', text.includes('Срок годности Товара') && !text.includes('Гарантийный срок'));
ok('гарантия вместо срока годности для промтоваров',
  E.buildContract(s({ category: 'other', warranty_months: 12 })).blocks
    .map(b => b.ru || '').join(' ').includes('Гарантийный срок'));
ok('ЕАЭС: в ст. 4.2 нет растаможки ввоза',
  E.buildContract(s({ route: 'RU' })).blocks.map(b => b.ru || '').join(' ')
    .includes('таможенное оформление ввоза не производится'));
ok('условия оплаты 30/70 попали в текст', text.includes('30% (тридцать процентов)'));
ok('приложения 1 и 2 есть', text.includes('Приложение №1') && text.includes('Приложение №2'));
ok('приложение 3 по умолчанию отсутствует', !text.includes('Приложение №3 —'));
ok('приложение 3 включается флагом',
  E.buildContract(s({ local_content: true })).blocks.map(b => b.ru || '').join(' ').includes('Приложение №3'));
ok('английский текст есть в каждом абзаце',
  built.blocks.filter(b => b.type === 'p').every(b => b.en && b.en.length > 10));
ok('нет незакрытых плейсхолдеров вида [заполняется', !text.includes('[ заполняется'));

group('Полный перебор комбинаций (не падает и даёт полный документ)');
let combos = 0, broken = 0;
for (const route of Object.keys(RULES.routes))
  for (const inc of Object.keys(RULES.incoterms))
    for (const cat of Object.keys(RULES.categories))
      for (const tr of ['road', 'rail', 'sea_air']) {
        combos++;
        try {
          const r = E.buildContract(s({ route, incoterms: inc, category: cat, transport: tr, warranty_months: 12 }));
          if (!r.blocks.length || !r.derived.documents.length) broken++;
        } catch (e) { broken++; }
      }
ok(`${combos} комбинаций собираются без ошибок`, broken === 0, broken + ' сломанных');

console.log(`\n${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
