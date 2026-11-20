import { canonicalBrPhoneForm } from '../contacts/phone.util';
import type { ParsedFields } from './cell-values';

/**
 * Chaves de repetição da linha: matrícula (chave em minúsculas) e telefone na
 * forma canônica do nono dígito. Telefone mascarado ou inválido não conta
 * (`phoneE164` nulo).
 */
function keysOf(fields: ParsedFields): string[] {
  const keys: string[] = [];
  if (fields.registration) keys.push(`registration:${fields.registration.key}`);
  if (fields.phoneE164) {
    keys.push(`phone:${canonicalBrPhoneForm(fields.phoneE164)}`);
  }
  return keys;
}

/**
 * Linhas repetidas do lote (EX31): número da linha → número da primeira linha
 * com a mesma matrícula ou o mesmo telefone. Linhas Ignoradas (em branco ou de
 * exemplo) não entram; a primeira ocorrência segue com a classificação que
 * tiver, mesmo inválida, e não aparece no mapa. `rows` na ordem do arquivo.
 */
export function duplicateOf(
  rows: readonly { rowNumber: number; fields: ParsedFields }[],
): ReadonlyMap<number, number> {
  const firstByKey = new Map<string, number>();
  const duplicates = new Map<number, number>();
  for (const { rowNumber, fields } of rows) {
    if (fields.isBlank || fields.isExample) continue;
    const keys = keysOf(fields);
    const earlier = keys
      .map((key) => firstByKey.get(key))
      .filter((first): first is number => first !== undefined);
    if (earlier.length > 0) duplicates.set(rowNumber, Math.min(...earlier));
    for (const key of keys) {
      if (!firstByKey.has(key)) firstByKey.set(key, rowNumber);
    }
  }
  return duplicates;
}
