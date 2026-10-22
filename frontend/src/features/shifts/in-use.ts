import type { ShiftAdmin } from './schemas';

const REASON_TEXT: Record<ShiftAdmin['inUse'][number]['kind'], (count: number) => string> = {
  users: (n) => `${n} pessoa(s) com este turno no cadastro`,
  schedules: (n) => `${n} escala(s)`,
  exceptions: (n) => `${n} exceção(ões) de hoje em diante`,
  scheduled: (n) => `${n} envio(s) agendado(s)`,
};

/** "Em uso: ..." com os motivos do turno; null quando nada o usa. */
export function inUseText(inUse: ShiftAdmin['inUse']): string | null {
  if (inUse.length === 0) return null;
  return `Em uso: ${inUse.map(({ kind, count }) => REASON_TEXT[kind](count)).join(', ')}`;
}
