import type { DomainError } from '../../shared/errors/domain.error';
import type {
  SheetReadError,
  SheetReadProblem,
} from '../../shared/spreadsheet/sheet-data';
import {
  importDuplicateHeader,
  importEmpty,
  importNoData,
  importTooManyRows,
  importUnreadable,
} from './people-import.errors';

/** Assinatura do ZIP (local file header): todo `.xlsx` começa por ela. */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** `PeopleImportBatch.fileName` é `VarChar(255)`. */
const FILE_NAME_MAX = 255;
const REPLACEMENT_CHAR = '�';
/**
 * Caracteres de controle (NUL derruba o Postgres; quebra de linha vaza para a
 * Trilha) e de formatação invisíveis (U+202E e outros disfarçam o nome).
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;
const EXPANDS_TOO_MUCH =
  'A planilha fica grande demais ao abrir. Divida a planilha e envie em partes.';

/**
 * EX4: tipo pela extensão (sem diferenciar maiúsculas) e pelo conteúdo; o MIME
 * do navegador não é usado (varia para CSV). `.xlsx` precisa da assinatura do
 * ZIP e `.csv` não pode tê-la.
 */
export function formatOf(name: string, buffer: Buffer): 'csv' | 'xlsx' | null {
  const lower = name.toLowerCase();
  const zipped = buffer.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE);
  if (lower.endsWith('.xlsx')) return zipped ? 'xlsx' : null;
  if (lower.endsWith('.csv')) return zipped ? null : 'csv';
  return null;
}

/**
 * EX4 (M6): o multer entrega `originalname` em latin1. Volta a UTF-8 (se não for
 * UTF-8 válido, fica como veio), tira o caminho e os caracteres de controle
 * (T16 M1) e corta em 255 caracteres.
 */
export function uploadedFileName(originalName: string): string {
  const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
  const name = decoded.includes(REPLACEMENT_CHAR) ? originalName : decoded;
  const base = (name.split(/[/\\]/).at(-1) ?? '').replace(CONTROL_CHARS, '');
  return Array.from(base).slice(0, FILE_NAME_MAX).join('');
}

/** O leitor do CSV manda `linha N` no detalhe; sem o número, o texto genérico. */
function unclosedQuote(detail: string | null): DomainError {
  const line = /\d+/.exec(detail ?? '')?.[0];
  return line === undefined
    ? importUnreadable()
    : importUnreadable(
        `O CSV tem aspas sem fechamento a partir da linha ${line}.`,
      );
}

/**
 * `unreadable` sai sempre com o texto genérico: o detalhe (ex.:
 * `too_many_columns`) é interno. O detalhe de `duplicate_header` vem do arquivo
 * e só vai para a resposta, nunca para log (GX17).
 */
const FROM_PROBLEM: Readonly<
  Record<SheetReadProblem, (detail: string | null) => DomainError>
> = {
  empty: () => importEmpty(),
  no_data: () => importNoData(),
  too_many_rows: () => importTooManyRows(),
  duplicate_header: (detail) => importDuplicateHeader(detail ?? ''),
  unreadable: () => importUnreadable(),
  unclosed_quote: unclosedQuote,
  expands_too_much: () => importUnreadable(EXPANDS_TOO_MUCH),
};

/** CX3: problema da leitura → erro 422 com o texto da tela. */
export function fromSheetReadError(error: SheetReadError): DomainError {
  return FROM_PROBLEM[error.problem](error.detail);
}
