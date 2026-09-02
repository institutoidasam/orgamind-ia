import * as path from 'node:path';
import JSZip from 'jszip';

// Parts exceljs 4.4 can't reconcile (threaded comments, legacy comment shapes,
// person cards). The importer reads only cell values, so they are dropped
// entirely rather than repaired.
const DROP_PART =
  /(?:^|\/)(?:comments\d+\.xml|threadedComments\/[^/]+\.xml|persons\/person\.xml|drawings\/vmldrawing[^/]*\.vml)$/i;

// Relationships pointing at those dropped parts, so the worksheet .rels no
// longer references a part that isn't in the package.
const DROP_REL =
  /<Relationship\b[^>]*\bType="[^"]*\/(?:comments|vmlDrawing|threadedComment|person)"[^>]*\/>/gi;

/**
 * Rewrite an .xlsx so exceljs 4.4 can read it.
 *
 * Some generators (notably .NET/OpenXML tooling) emit OOXML that is perfectly
 * valid — Excel, Google Sheets and openpyxl all read it — but that exceljs
 * cannot parse:
 *   1. namespace-PREFIXED elements: `<x:workbook>`, `<x:sheets>`,
 *      `<x:worksheet>`… exceljs matches tag names literally, so it never sees
 *      `workbook`/`sheets` and its model comes out undefined ("Cannot read
 *      properties of undefined (reading 'sheets')");
 *   2. ABSOLUTE Targets in the .rels parts
 *      (`Target="/xl/worksheets/sheet1.xml"`) — exceljs resolves targets
 *      relative to the part's base dir only.
 *
 * This normalizer rewrites every `*.xml` / `*.rels` entry in the zip:
 *   - strips the namespace prefix from ELEMENT names only (`<x:sheet>` →
 *     `<sheet>`); prefixed ATTRIBUTES like `r:id="…"` are left intact —
 *     exceljs needs them verbatim to resolve sheets;
 *   - in `*.rels` only, converts absolute Targets to paths relative to the
 *     part's base dir (base of `<dir>/_rels/<f>.rels` is `<dir>`;
 *     `_rels/.rels` → package root).
 *
 * Pure function — no Nest DI. Returns a rebuilt zip buffer.
 */
export async function normalizeXlsxForExceljs(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);

  // Removal pass: drop comment/vmlDrawing/person parts entirely (see DROP_PART).
  for (const name of Object.keys(zip.files)) {
    if (DROP_PART.test(name)) zip.remove(name);
  }

  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;

    let xml = await entry.async('string');

    // Strip the namespace prefix from ELEMENT names only (open + close tags).
    // Attributes (e.g. r:id="…") never follow `<` or `</`, so they survive.
    xml = xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

    if (name.endsWith('.rels')) {
      // Drop the relationships that pointed at the removed parts, so no
      // surviving .rels references a part that is no longer in the package.
      xml = xml.replace(DROP_REL, '');

      // Base dir of '<dir>/_rels/<f>.rels' is '<dir>'
      // ('xl/_rels/workbook.xml.rels' → 'xl'; '_rels/.rels' → package root).
      const baseDir = path.posix.dirname(path.posix.dirname(name));
      xml = xml.replace(/Target="(\/[^"]+)"/g, (_, abs: string) => {
        const rel = path.posix.relative(
          baseDir === '.' ? '' : baseDir,
          abs.slice(1),
        );
        return `Target="${rel}"`;
      });
    }

    zip.file(name, xml);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}
