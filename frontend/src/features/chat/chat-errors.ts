import { HTTPError } from 'ky';
import { readApiErrorBody } from '@/lib/api-error';

/** Mensagens por `code` das ações da caixa (DK16). */
export const CHAT_ACTION_ERROR_TEXT: Record<string, string> = {
  'chat.not_assignee': 'Só quem está atendendo a conversa ou um administrador pode fazer isso.',
  'chat.conversation_changed': 'A conversa mudou enquanto você olhava. Ela foi recarregada; confira e tente de novo.',
  'user.not_found': 'Esta pessoa não pode receber a conversa. Escolha outra.',
};

/** 409 da resposta em conversa que outro atendente assumiu (K1-6, DK17). */
export const CHAT_ASSIGNED_TO_OTHER = 'chat.assigned_to_other';

const GENERIC_ACTION_ERROR = 'Não foi possível concluir a ação. Tente de novo.';

export function chatActionErrorText(code: string | undefined): string {
  return code && Object.hasOwn(CHAT_ACTION_ERROR_TEXT, code) ? CHAT_ACTION_ERROR_TEXT[code] : GENERIC_ACTION_ERROR;
}

/**
 * `detail` dos 409 (DK14): JSON `{ assignee: { id, name, active } | null }`.
 * Tolerante: ausente, inválido ou sem atendente → null.
 */
export function parseAssigneeDetail(detail: string | undefined): { id: string; name: string; active: boolean } | null {
  if (!detail) return null;
  try {
    const assignee = (JSON.parse(detail) as { assignee?: Record<string, unknown> | null } | null)?.assignee;
    if (!assignee) return null;
    const { id, name, active } = assignee;
    return typeof id === 'string' && typeof name === 'string' && typeof active === 'boolean'
      ? { id, name, active }
      : null;
  } catch {
    return null;
  }
}

/**
 * Falha de uma ação da caixa (atribuir, resolver, reabrir): texto do toast
 * pelo `code` do corpo (ky 2: só por readApiErrorBody) e se a tela deve
 * recarregar a conversa (403 e 409: o estado que ela mostrava ficou velho).
 */
export async function chatActionFailure(err: unknown): Promise<{ text: string; reload: boolean }> {
  const body = await readApiErrorBody(err);
  const status = err instanceof HTTPError ? err.response.status : undefined;
  return { text: chatActionErrorText(body?.code), reload: status === 403 || status === 409 };
}
