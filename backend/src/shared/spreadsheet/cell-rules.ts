import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Caracteres que fazem a planilha tratar o texto como fórmula. */
export const FORMULA_TRIGGERS: readonly string[] = [
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
];

/**
 * Texto que a ida protege e a volta desfaz: gatilho no começo, ou um ou mais
 * apóstrofos seguidos de gatilho. O mesmo regex dos dois lados mantém
 * `unguardFormula(guardFormula(s)) === s` para qualquer `s`.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/;

/** Põe um apóstrofo na frente do texto que uma planilha leria como fórmula. */
export function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Tira UM apóstrofo da frente, só quando o resto ainda casa a regra da ida. */
export function unguardFormula(text: string): string {
  if (!text.startsWith("'")) return text;
  return FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
}

/** E.164 → `(92) 99111-2008` no Brasil, `+1 415 555 2671` fora; inválido fica como veio. */
export function formatPhoneCell(phoneE164: string): string {
  const parsed = parsePhoneNumberFromString(phoneE164);
  if (!parsed?.isValid()) return phoneE164;
  return parsed.country === 'BR'
    ? parsed.formatNational()
    : parsed.formatInternational();
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. */
export function formatDateCell(civilDate: string): string {
  const [year, month, day] = civilDate.split('-');
  return `${day}/${month}/${year}`;
}

export const YES_NO_CELL = { yes: 'Sim', no: 'Não' } as const;

export function yesNo(value: boolean): 'Sim' | 'Não' {
  return value ? YES_NO_CELL.yes : YES_NO_CELL.no;
}
