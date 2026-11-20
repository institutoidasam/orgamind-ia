import { inflateRawSync } from 'node:zlib';

const END_SIGNATURE = 0x06054b50;
const ENTRY_SIGNATURE = 0x02014b50;
const END_RECORD_SIZE = 22;
/** O comentário do zip tem até 65.535 bytes, e o registro de fim vem antes dele. */
const END_SEARCH_WINDOW = 0xffff + END_RECORD_SIZE;
const ENTRY_HEADER_SIZE = 46;
const ZIP64_MARK = 0xffffffff;
const ZIP64_MARK_16 = 0xffff;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/**
 * Teto de entradas do diretório central. Um XLSX real tem dezenas (partes do
 * pacote, abas, imagens); sem teto, um arquivo de poucos MB declararia centenas
 * de milhares de entradas de 46 bytes e travaria o laço de descompactação.
 */
export const XLSX_MAX_ENTRIES = 1000;

/** Posição do último registro de fim do diretório central (a mesma busca de trás para a frente do jszip). */
function findEndRecord(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - END_SEARCH_WINDOW);
  for (let at = buffer.length - END_RECORD_SIZE; at >= lowest; at--) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) return at;
  }
  return -1;
}

type DirectoryEntry = {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  next: number;
};

/** Lê a entrada do diretório central em `at`; `null` se for ilegível, passar de `limit` ou usar ZIP64. */
function readEntry(
  buffer: Buffer,
  at: number,
  limit: number,
): DirectoryEntry | null {
  if (at + ENTRY_HEADER_SIZE > limit) return null;
  if (buffer.readUInt32LE(at) !== ENTRY_SIGNATURE) return null;
  const compressedSize = buffer.readUInt32LE(at + 20);
  const uncompressedSize = buffer.readUInt32LE(at + 24);
  const localOffset = buffer.readUInt32LE(at + 42);
  if ([compressedSize, uncompressedSize, localOffset].includes(ZIP64_MARK)) {
    return null;
  }
  const next =
    at +
    ENTRY_HEADER_SIZE +
    buffer.readUInt16LE(at + 28) +
    buffer.readUInt16LE(at + 30) +
    buffer.readUInt16LE(at + 32);
  if (next > limit) return null;
  const method = buffer.readUInt16LE(at + 10);
  return { method, compressedSize, uncompressedSize, localOffset, next };
}

/**
 * Campo do registro de fim no valor máximo: o jszip passa a procurar o registro
 * ZIP64, que pode apontar para outro diretório central (não o que é conferido aqui).
 */
function marksZip64(buffer: Buffer, end: number): boolean {
  const counts = [4, 6, 8, 10].map((field) => buffer.readUInt16LE(end + field));
  const directory = [12, 16].map((field) => buffer.readUInt32LE(end + field));
  return counts.includes(ZIP64_MARK_16) || directory.includes(ZIP64_MARK);
}

/**
 * Entradas do diretório central, as mesmas que o jszip (quem o `xlsx.load` usa)
 * lê. `null` = diretório ilegível, que não termina exatamente no registro de fim
 * (conteúdo extra que o jszip interpretaria de outro jeito), ZIP64, com mais de
 * `XLSX_MAX_ENTRIES` entradas ou com duas entradas no mesmo cabeçalho local (o
 * deslocamento é único por entrada; repetido serve só para multiplicar a
 * descompactação do mesmo dado). Percorre as entradas até o registro de fim, sem
 * confiar na contagem dele: o jszip também a ignora. O teto vale durante a
 * leitura, então o arquivo que o estoura não vira uma lista enorme.
 */
function readDirectory(buffer: Buffer): DirectoryEntry[] | null {
  const end = findEndRecord(buffer);
  if (end < 0 || marksZip64(buffer, end)) return null;
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (directoryOffset + buffer.readUInt32LE(end + 12) !== end) return null;
  const entries: DirectoryEntry[] = [];
  const offsets = new Set<number>();
  for (let at = directoryOffset; at < end;) {
    const entry = readEntry(buffer, at, end);
    if (entry === null || offsets.has(entry.localOffset)) return null;
    offsets.add(entry.localOffset);
    entries.push(entry);
    if (entries.length > XLSX_MAX_ENTRIES) return null;
    at = entry.next;
  }
  return entries;
}

/** Soma dos tamanhos descompactados DECLARADOS no diretório central, sem descompactar nada (EX3 (1)). */
export function zipUncompressedTotal(buffer: Buffer): number | null {
  const entries = readDirectory(buffer);
  if (entries === null) return null;
  return entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
}

/**
 * Dados comprimidos da entrada, achados como o jszip acha: cabeçalho local no
 * deslocamento dado pelo diretório central, dados depois do nome e do extra DO
 * CABEÇALHO LOCAL, com o tamanho comprimido do diretório central.
 */
function entryData(buffer: Buffer, entry: DirectoryEntry): Buffer | null {
  const at = entry.localOffset;
  if (at + LOCAL_HEADER_SIZE > buffer.length) return null;
  if (buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) return null;
  const start =
    at +
    LOCAL_HEADER_SIZE +
    buffer.readUInt16LE(at + 26) +
    buffer.readUInt16LE(at + 28);
  const stop = start + entry.compressedSize;
  return stop > buffer.length ? null : buffer.subarray(start, stop);
}

/**
 * Bytes que os dados produzem ao descompactar, sem guardar mais que `remaining + 1`
 * (passou disso, devolve `remaining + 1`). `null` = método que o jszip não lê ou
 * deflate corrompido.
 */
function inflatedSize(
  data: Buffer,
  method: number,
  remaining: number,
): number | null {
  if (method === METHOD_STORED) return data.length;
  if (method !== METHOD_DEFLATED) return null;
  try {
    return inflateRawSync(data, { maxOutputLength: remaining + 1 }).length;
  } catch (error) {
    // Passar de `maxOutputLength` lança RangeError (ERR_BUFFER_TOO_LARGE).
    return error instanceof RangeError ? remaining + 1 : null;
  }
}

/**
 * Soma dos tamanhos descompactados REAIS, entrada por entrada, parando assim que
 * passa de `limit` (devolve então um valor acima de `limit`); a memória usada não
 * passa de `limit`. O tamanho declarado pode mentir, e o jszip só confere o real
 * depois de descompactar a entrada inteira na memória. `null` = zip ilegível
 * (inclui cabeçalho local quebrado, dados fora do arquivo e método desconhecido).
 */
export function zipInflatedTotal(buffer: Buffer, limit: number): number | null {
  const entries = readDirectory(buffer);
  if (entries === null) return null;
  let total = 0;
  for (const entry of entries) {
    const data = entryData(buffer, entry);
    if (data === null) return null;
    const size = inflatedSize(data, entry.method, limit - total);
    if (size === null) return null;
    total += size;
    if (total > limit) return total;
  }
  return total;
}
