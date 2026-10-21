import { extractApiError } from '@/lib/api-error';

const FALLBACK_MESSAGE = 'Não foi possível salvar a escala.';

export const SCHEDULE_FORBIDDEN_CODE = 'staff_schedule.forbidden';

const SCHEDULE_ERROR_MESSAGES: Record<string, string> = {
  [SCHEDULE_FORBIDDEN_CODE]: 'Você não pode editar a escala desta pessoa.',
  'staff_schedule.user_not_found': 'Pessoa não encontrada. Atualize a página.',
  'staff_schedule.exception_not_found': 'Exceção não encontrada. Atualize a página.',
  'staff_schedule.invalid_shift': 'Esse turno não está mais disponível. Atualize a página.',
  'staff_schedule.invalid_sector': 'Esse setor não está mais disponível. Atualize a página.',
};

/** Mensagem PT-BR para o código de erro da API da escala. */
export function scheduleErrorMessage(code?: string, fallback = FALLBACK_MESSAGE): string {
  return (code && SCHEDULE_ERROR_MESSAGES[code]) || fallback;
}

/** Código e mensagem PT-BR de um erro lançado por uma chamada da escala. */
export async function describeScheduleError(
  error: unknown,
  fallback?: string,
): Promise<{ code?: string; message: string }> {
  const { code } = await extractApiError(error);
  return { code, message: scheduleErrorMessage(code, fallback) };
}
