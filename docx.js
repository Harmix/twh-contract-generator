/* TWH Contract Generator — сборка .docx (OOXML) без DOM.
 * Работает и в браузере (с JSZip), и в Node (для тестов).
 * DOCX.buildFiles(blocks, showEn) → { путь: содержимое } для упаковки в zip.
 */

const DOCX = (function () {
  const x = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function para(text, opts) {
    opts = opts || {};
    const size = opts.size || 22;
    const rPr = `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.italic ? '<w:i/>' : ''}` +
      `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
      `${opts.color ? `<w:color w:val="${opts.color}"/>` : ''}</w:rPr>`;
    const jc = opts.center ? '<w:jc w:val="center"/>' : (opts.justify ? '<w:jc w:val="both"/>' : '');
    const pPr = `<w:pPr>${jc}<w:spacing w:after="${opts.after == null ? 120 : opts.after}"/></w:pPr>`;
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p>`;
  }

  function table(rows) {
    const cols = rows[0] ? rows[0].length : 1;
    const cellW = Math.floor(9360 / cols);
    const body = rows.map(r => '<w:tr>' + r.map(c =>
      `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/></w:tcPr>` +
      para(c, { after: 0, size: 20 }) + '</w:tc>').join('') + '</w:tr>').join('');
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(s => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${borders}` +
      `</w:tblBorders></w:tblPr>${body}</w:tbl>` +
      `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>`;
  }

  function documentXml(blocks, showEn) {
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'title') {
        parts.push(para(b.ru, { bold: true, center: true, size: 28 }));
        if (showEn) parts.push(para(b.en, { center: true, italic: true, size: 20, color: '777777' }));
      } else if (b.type === 'h') {
        parts.push(para(showEn ? `${b.ru} / ${b.en}` : b.ru, { bold: true, size: 24 }));
      } else if (b.type === 'p') {
        parts.push(para(b.ru, { justify: true }));
        if (showEn) parts.push(para(b.en, { justify: true, italic: true, size: 20, color: '777777' }));
      } else if (b.type === 'table') {
        parts.push(table(b.rows));
      } else if (b.type === 'pagebreak') {
        parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      }
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      parts.join('') +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ru-RU"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

  function buildFiles(blocks, showEn) {
    return {
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      'word/document.xml': documentXml(blocks, showEn),
      'word/styles.xml': STYLES,
      'word/_rels/document.xml.rels': DOC_RELS
    };
  }

  const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  async function download(blocks, showEn, filename) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');
    const zip = new JSZip();
    for (const [path, content] of Object.entries(buildFiles(blocks, showEn))) zip.file(path, content);
    const blob = await zip.generateAsync({ type: 'blob', mimeType: MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { buildFiles, documentXml, download, MIME };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DOCX;
if (typeof globalThis !== 'undefined') globalThis.DOCX = DOCX;
