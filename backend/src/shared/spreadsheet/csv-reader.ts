import { unguardFormula } from './cell-rules';
import { SheetCollector, SheetReadError, type SheetData } from './sheet-data';

type Separator = ';' | ',';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Windows-1252 em 0x80–0x9F; as cinco posições sem letra ficam como o latin1 as dá. */
const WINDOWS_1252_C1: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
  0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e,
  0x178,
];

function decodeWindows1252(buffer: Buffer): string {
  return buffer
    .toString('latin1')
    .replace(/[\u0080-\u009f]/g, (char) =>
      String.fromCodePoint(WINDOWS_1252_C1[char.charCodeAt(0) - 0x80]),
    );
}

/** Tira o BOM; UTF-8 estrito e, se o arquivo não for UTF-8 válido, Windows-1252. */
export function decodeCsv(buffer: Buffer): string {
  const body = buffer.subarray(0, 3).equals(UTF8_BOM)
    ? buffer.subarray(3)
    : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return decodeWindows1252(body);
  }
}

/** Índice da aspa que fecha o campo aberto em `open` (aspas dobradas ficam dentro); -1 se não fecha. */
function closingQuote(text: string, open: number): number {
  let from = open + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1 || text[quote + 1] !== '"') return quote;
    from = quote + 2;
  }
}

/** Avança até um dos caracteres de `stops` (ou o fim do texto). */
function skipPlain(text: string, from: number, stops: string): number {
  let position = from;
  while (position < text.length && !stops.includes(text[position])) position++;
  return position;
}

/** Início da primeira linha com algo além de espaços e separadores (as anteriores não são o cabeçalho). */
function headerStart(text: string): number {
  let start = 0;
  while (start < text.length) {
    const end = skipPlain(text, start, '\r\n');
    if (/[^\s;,]/.test(text.slice(start, end))) return start;
    start = end + (text.startsWith('\r\n', end) ? 2 : 1);
  }
  return text.length;
}

/** Separador pela linha de cabeçalho: conta `;` e `,` fora de aspas; mais vírgulas que ponto e vírgulas → `,`. */
export function detectSeparator(text: string): Separator {
  const counts = { ';': 0, ',': 0 };
  let position = headerStart(text);
  while (position < text.length) {
    if (text[position] === '"') {
      const close = closingQuote(text, position);
      if (close === -1) break;
      position = close + 1;
    }
    position = skipPlain(text, position, ';,\r\n');
    const char = text[position];
    if (char !== ';' && char !== ',') break;
    counts[char]++;
    position++;
  }
  return counts[','] > counts[';'] ? ',' : ';';
}

/** Lê um registro por vez: campo entre aspas só abre com a aspa no início do campo. */
class RecordScanner {
  private position = 0;
  private readonly stops: string;

  constructor(
    private readonly text: string,
    private readonly separator: Separator,
  ) {
    this.stops = `${separator}\r\n`;
  }

  next(rowNumber: number): string[] | null {
    if (this.position >= this.text.length) return null;
    const cells: string[] = [];
    do {
      cells.push(this.readField(rowNumber));
    } while (this.consumeSeparator());
    this.skipLineEnd();
    return cells;
  }

  private readField(rowNumber: number): string {
    if (this.text[this.position] !== '"') return this.readPlain();
    const close = closingQuote(this.text, this.position);
    if (close === -1) {
      throw new SheetReadError('unclosed_quote', `linha ${rowNumber}`);
    }
    const quoted = this.text
      .slice(this.position + 1, close)
      .replaceAll('""', '"');
    this.position = close + 1;
    return quoted + this.readPlain();
  }

  private readPlain(): string {
    const end = skipPlain(this.text, this.position, this.stops);
    const plain = this.text.slice(this.position, end);
    this.position = end;
    return plain;
  }

  private consumeSeparator(): boolean {
    if (this.text[this.position] !== this.separator) return false;
    this.position++;
    return true;
  }

  private skipLineEnd(): void {
    if (this.text.startsWith('\r\n', this.position)) this.position += 2;
    else if (this.position < this.text.length) this.position++;
  }
}

/**
 * Entrega cada registro (linha 1 = cabeçalho; registro com quebra dentro de aspas
 * conta uma linha só). Erro de `onRecord` para a leitura na hora.
 */
export function parseCsvRecords(
  text: string,
  separator: Separator,
  onRecord: (rowNumber: number, cells: string[]) => void,
): void {
  const scanner = new RecordScanner(text, separator);
  let rowNumber = 1;
  for (
    let cells = scanner.next(rowNumber);
    cells !== null;
    cells = scanner.next(rowNumber)
  ) {
    onRecord(rowNumber, cells);
    rowNumber++;
  }
}

/** Decodifica, acha o separador e junta os registros; o apóstrofo de proteção sai só das células de dado. */
export function readCsvSheet(buffer: Buffer): SheetData {
  const text = decodeCsv(buffer);
  if (text.includes('\0')) throw new SheetReadError('unreadable');
  const collector = new SheetCollector();
  parseCsvRecords(text, detectSeparator(text), (rowNumber, cells) =>
    collector.add(
      rowNumber,
      collector.hasHeader ? cells.map((cell) => unguardFormula(cell)) : cells,
    ),
  );
  return collector.finish();
}
