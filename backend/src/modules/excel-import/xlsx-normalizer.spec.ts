import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normalizeXlsxForExceljs } from './xlsx-normalizer';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MS_REL_NS = 'http://schemas.microsoft.com/office/2017/10/relationships';

/**
 * Build a minimal .xlsx that reproduces BOTH quirks of the client file
 * (.NET/OpenXML output) that exceljs 4.4 cannot read:
 *   1. namespace-PREFIXED elements (<x:workbook>, <x:sheets>, <x:worksheet>…)
 *   2. ABSOLUTE Targets in the .rels parts (Target="/xl/workbook.xml")
 *
 * Data: 1 header row (nome / telefone) + 1 data row, as inlineStr cells.
 */
async function makePrefixedXlsx(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
  );

  // Package rels with an ABSOLUTE target (quirk 2).
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="/xl/workbook.xml"/>` +
      `</Relationships>`,
  );

  // Workbook with PREFIXED elements (quirk 1) and a prefixed r:id ATTRIBUTE
  // that must survive normalization untouched.
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:workbook xmlns:x="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      `<x:sheets>` +
      `<x:sheet name="Contatos" sheetId="1" r:id="Rabc"/>` +
      `</x:sheets>` +
      `</x:workbook>`,
  );

  // Workbook rels with an ABSOLUTE target (quirk 2, nested _rels dir).
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="Rabc" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml"/>` +
      `</Relationships>`,
  );

  // Worksheet with PREFIXED elements (quirk 1), inlineStr cells.
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:worksheet xmlns:x="${MAIN_NS}">` +
      `<x:sheetData>` +
      `<x:row r="1">` +
      `<x:c r="A1" t="inlineStr"><x:is><x:t>nome</x:t></x:is></x:c>` +
      `<x:c r="B1" t="inlineStr"><x:is><x:t>telefone</x:t></x:is></x:c>` +
      `</x:row>` +
      `<x:row r="2">` +
      `<x:c r="A2" t="inlineStr"><x:is><x:t>Maria Silva</x:t></x:is></x:c>` +
      `<x:c r="B2" t="inlineStr"><x:is><x:t>(92) 99876-1234</x:t></x:is></x:c>` +
      `</x:row>` +
      `</x:sheetData>` +
      `</x:worksheet>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Build a minimal .xlsx that ALSO carries Excel threaded-comment baggage — the
 * exact parts the real client file (contatos_apoiadores_formatado*.xlsx) ships:
 *   - `xl/comments1.xml` (legacy comment part, prefixed elements)
 *   - `xl/drawings/vmldrawing.vml` (legacy comment shapes)
 *   - `xl/persons/person.xml` (comment author cards)
 *   - worksheet `_rels` with `comments` + `vmlDrawing` relationships
 *   - workbook `_rels` with a `person` relationship
 * all with the same two quirks as makePrefixedXlsx (prefixed elements +
 * absolute .rels Targets).
 *
 * exceljs 4.4 cannot reconcile these: after the prefix/Target repair it still
 * throws "Cannot read properties of undefined (reading 'comments')" in
 * worksheet-xform reconcile(). The importer reads only cell values, so the
 * normalizer must DROP these parts + their relationships.
 */
async function makeCommentedXlsx(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>` +
      `<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>` +
      `</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="/xl/workbook.xml"/>` +
      `</Relationships>`,
  );

  // Workbook rels carry a `person` relationship (absolute Target) that must be
  // stripped — its Type ends in `/person`.
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:workbook xmlns:x="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      `<x:sheets>` +
      `<x:sheet name="contatos" sheetId="1" r:id="Rabc"/>` +
      `</x:sheets>` +
      `</x:workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="Rabc" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml"/>` +
      `<Relationship Id="Rperson" Type="${MS_REL_NS}/person" Target="/xl/persons/person.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:worksheet xmlns:x="${MAIN_NS}">` +
      `<x:sheetData>` +
      `<x:row r="1">` +
      `<x:c r="A1" t="inlineStr"><x:is><x:t>nome</x:t></x:is></x:c>` +
      `<x:c r="B1" t="inlineStr"><x:is><x:t>telefone</x:t></x:is></x:c>` +
      `</x:row>` +
      `<x:row r="2">` +
      `<x:c r="A2" t="inlineStr"><x:is><x:t>Maria Silva</x:t></x:is></x:c>` +
      `<x:c r="B2" t="inlineStr"><x:is><x:t>(92) 99876-1234</x:t></x:is></x:c>` +
      `</x:row>` +
      `</x:sheetData>` +
      `</x:worksheet>`,
  );

  // Worksheet rels carry `comments` + `vmlDrawing` relationships (absolute
  // Targets) — these must be stripped so exceljs never reconciles comments.
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="Rc1" Type="${REL_NS}/comments" Target="/xl/comments1.xml"/>` +
      `<Relationship Id="Rv1" Type="${REL_NS}/vmlDrawing" Target="/xl/drawings/vmldrawing.vml"/>` +
      `</Relationships>`,
  );

  // The comment baggage parts themselves.
  zip.file(
    'xl/comments1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:comments xmlns:x="${MAIN_NS}">` +
      `<x:authors><x:author>Author</x:author></x:authors>` +
      `<x:commentList>` +
      `<x:comment ref="A1" authorId="0"><x:text><x:r><x:t>Nome completo</x:t></x:r></x:text></x:comment>` +
      `</x:commentList>` +
      `</x:comments>`,
  );
  zip.file(
    'xl/drawings/vmldrawing.vml',
    `<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape></v:shape></xml>`,
  );
  zip.file(
    'xl/persons/person.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<personList xmlns="${MAIN_NS}"><person displayName="Author" id="{00000000-0000-0000-0000-000000000000}"/></personList>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('normalizeXlsxForExceljs', () => {
  it('sanity: exceljs FAILS to load the raw prefixed/absolute-target buffer', async () => {
    const raw = await makePrefixedXlsx();
    const wb = new ExcelJS.Workbook();
    await expect(
      wb.xlsx.load(raw as unknown as ExcelJS.Buffer),
    ).rejects.toThrow();
  });

  it('after normalization, exceljs reads the worksheet and cell values', async () => {
    const raw = await makePrefixedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fixed as unknown as ExcelJS.Buffer);

    const sheet = wb.worksheets[0];
    expect(sheet).toBeDefined();
    expect(sheet.name).toBe('Contatos');
    expect(sheet.getCell('A1').value).toBe('nome');
    expect(sheet.getCell('B1').value).toBe('telefone');
    expect(sheet.getCell('A2').value).toBe('Maria Silva');
    expect(sheet.getCell('B2').value).toBe('(92) 99876-1234');
  });

  it('strips element prefixes but PRESERVES prefixed attributes (r:id)', async () => {
    const raw = await makePrefixedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const zip = await JSZip.loadAsync(fixed);
    const workbookXml = await zip.files['xl/workbook.xml'].async('string');
    // Element prefixes gone…
    expect(workbookXml).toContain('<workbook');
    expect(workbookXml).toContain('<sheets>');
    expect(workbookXml).not.toContain('<x:');
    expect(workbookXml).not.toContain('</x:');
    // …but the r:id ATTRIBUTE must survive (exceljs resolves sheets by it).
    expect(workbookXml).toContain('r:id="Rabc"');
  });

  it('rewrites absolute .rels Targets relative to the part base dir', async () => {
    const raw = await makePrefixedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const zip = await JSZip.loadAsync(fixed);
    const rootRels = await zip.files['_rels/.rels'].async('string');
    // Base of '_rels/.rels' is the package root.
    expect(rootRels).toContain('Target="xl/workbook.xml"');
    expect(rootRels).not.toContain('Target="/');

    const wbRels =
      await zip.files['xl/_rels/workbook.xml.rels'].async('string');
    // Base of 'xl/_rels/workbook.xml.rels' is 'xl'.
    expect(wbRels).toContain('Target="worksheets/sheet1.xml"');
    expect(wbRels).not.toContain('Target="/');
  });

  it('sanity: exceljs FAILS to load the raw commented buffer', async () => {
    const raw = await makeCommentedXlsx();
    const wb = new ExcelJS.Workbook();
    await expect(
      wb.xlsx.load(raw as unknown as ExcelJS.Buffer),
    ).rejects.toThrow();
  });

  it('after normalization, exceljs reads a comment-laden worksheet', async () => {
    // Even after the prefix/Target repair, the retained comment parts make
    // exceljs throw "…reading 'comments'"; stripping them lets it read cells.
    const raw = await makeCommentedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fixed as unknown as ExcelJS.Buffer);

    const sheet = wb.worksheets[0];
    expect(sheet).toBeDefined();
    expect(sheet.name).toBe('contatos');
    expect(sheet.getCell('A1').value).toBe('nome');
    expect(sheet.getCell('B1').value).toBe('telefone');
    expect(sheet.getCell('A2').value).toBe('Maria Silva');
    expect(sheet.getCell('B2').value).toBe('(92) 99876-1234');
  });

  it('drops the comment/vmlDrawing/person parts and their relationships', async () => {
    const raw = await makeCommentedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const zip = await JSZip.loadAsync(fixed);
    const names = Object.keys(zip.files);

    // Comment baggage parts are gone…
    expect(names).not.toContain('xl/comments1.xml');
    expect(names).not.toContain('xl/drawings/vmldrawing.vml');
    expect(names).not.toContain('xl/persons/person.xml');

    // …and the relationships pointing at them are gone…
    const sheetRels =
      await zip.files['xl/worksheets/_rels/sheet1.xml.rels'].async('string');
    expect(sheetRels).not.toContain('/comments"');
    expect(sheetRels).not.toContain('/vmlDrawing"');

    const wbRels =
      await zip.files['xl/_rels/workbook.xml.rels'].async('string');
    expect(wbRels).not.toContain('/person"');

    // …while the legitimate worksheet relationship survives.
    expect(wbRels).toContain(`Type="${REL_NS}/worksheet"`);
  });

  it('DROP passes preserve every part of a comment-free workbook', async () => {
    // Regression: the removal passes must not touch legitimate parts.
    const raw = await makePrefixedXlsx();
    const fixed = await normalizeXlsxForExceljs(raw);

    const zip = await JSZip.loadAsync(fixed);
    const names = Object.keys(zip.files);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/_rels/workbook.xml.rels');
    expect(names).toContain('xl/worksheets/sheet1.xml');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fixed as unknown as ExcelJS.Buffer);
    expect(wb.worksheets[0].name).toBe('Contatos');
  });
});
