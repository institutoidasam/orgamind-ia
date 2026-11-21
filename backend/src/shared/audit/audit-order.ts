import type { Prisma } from '@prisma/client';
import type { FieldChange } from './audit-change';

/** Campo único da trilha de reordenação (turno e nível). */
export const ORDER_FIELD = 'order';

const ORDER_SEPARATOR = ' > ';

/** Trilha de uma reordenação, dentro da transação que grava a ordem nova. */
export type OrderTrail = (
  tx: Prisma.TransactionClient,
  before: string[],
  after: string[],
) => Promise<void>;

/**
 * Mudança de ordem como um campo só: os nomes na ordem de antes e de depois,
 * unidos por " > ". Ordem igual não é mudança (`[]`, nenhum evento).
 */
export function orderChange(
  before: readonly string[],
  after: readonly string[],
): FieldChange[] {
  const same =
    before.length === after.length &&
    before.every((name, index) => name === after[index]);
  if (same) return [];
  return [
    {
      field: ORDER_FIELD,
      before: before.join(ORDER_SEPARATOR),
      after: after.join(ORDER_SEPARATOR),
    },
  ];
}
