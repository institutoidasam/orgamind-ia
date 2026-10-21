import { extractApiError } from '@/lib/api-error';

const FALLBACK_MESSAGE = 'Não foi possível salvar o turno.';

export const SHIFT_NAME_TAKEN_CODE = 'shifts.name_taken';

const SHIFT_ERROR_MESSAGES: Record<string, string> = {
  [SHIFT_NAME_TAKEN_CODE]: 'Já existe um turno com esse nome.',
  'shifts.in_use': 'Este turno está em uso e não pode ser desativado.',
  'shifts.invalid_order': 'A lista de turnos mudou. Atualize a página e tente de novo.',
  'shifts.not_found': 'Turno não encontrado. Atualize a página.',
};

/** Mensagem PT-BR para o código de erro da API de turnos. */
export function shiftErrorMessage(code?: string): string {
  return (code && SHIFT_ERROR_MESSAGES[code]) || FALLBACK_MESSAGE;
}

/** Código e mensagem PT-BR de um erro lançado por uma chamada de turnos. */
export async function describeShiftError(error: unknown): Promise<{ code?: string; message: string }> {
  const { code } = await extractApiError(error);
  return { code, message: shiftErrorMessage(code) };
}
