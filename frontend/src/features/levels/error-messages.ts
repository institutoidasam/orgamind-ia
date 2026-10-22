import { readApiErrorBody } from '@/lib/api-error';

const FALLBACK_MESSAGE = 'Não foi possível salvar o nível.';

export const LEVEL_NAME_TAKEN_CODE = 'levels.name_taken';

const LEVEL_ERROR_MESSAGES: Record<string, string> = {
  [LEVEL_NAME_TAKEN_CODE]: 'Já existe um nível com esse nome.',
  'levels.invalid_order': 'A lista de níveis mudou. Atualize a página e tente de novo.',
  'levels.not_found': 'Nível não encontrado. Atualize a página.',
};

/** Mensagem PT-BR para o código de erro da API de níveis. */
export function levelErrorMessage(code?: string): string {
  return (code && LEVEL_ERROR_MESSAGES[code]) || FALLBACK_MESSAGE;
}

/** Código e mensagem PT-BR de um erro lançado por uma chamada de níveis. */
export async function describeLevelError(error: unknown): Promise<{ code?: string; message: string }> {
  const code = (await readApiErrorBody(error))?.code;
  return { code, message: levelErrorMessage(code) };
}
