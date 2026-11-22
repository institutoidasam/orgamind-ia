import { reasonRequired } from './users.errors';

const MIN_LENGTH = 3;
const MAX_LENGTH = 200;

function checked(reason: string): string {
  if (reason.length < MIN_LENGTH || reason.length > MAX_LENGTH)
    throw reasonRequired();
  return reason;
}

/** Motivo da alteração (A4): aparado, de 3 a 200 caracteres; ausente ou fora da faixa → 422. */
export function requireReason(raw: string | undefined): string {
  return checked(raw?.trim() ?? '');
}

/** Motivo opcional (mover e tirar do setor): ausente ou vazio → null; de 1 a 2 caracteres → 422. */
export function optionalReason(raw: string | undefined): string | null {
  const reason = raw?.trim();
  return reason ? checked(reason) : null;
}
