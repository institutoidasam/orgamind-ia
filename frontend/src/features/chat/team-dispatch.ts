import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { PURPOSE_LABEL } from '@/features/team-whatsapp/labels';
import { teamPurposeSchema } from '@/features/team-whatsapp/schemas';
import type { TeamPurpose } from '@/features/team-whatsapp/schemas';
import { SITUATION_LABEL as PENDENCY_SITUATION_LABEL } from '@/features/team-pendencies/labels';
import { pendencySituationSchema } from '@/features/team-pendencies/schemas';
import { historyTime } from './history-text';
import type { ChatMessageTeamTag } from './schemas';

/** Último envio à equipe da conversa (K3-6, CT2). Tolerante: campo opcional ausente lê como `null`. */
export const conversationLastDispatchSchema = z.object({
  last: z
    .object({
      purpose: teamPurposeSchema.nullable(),
      sentAt: z.string(),
      isReminder: z.boolean().default(false),
      /** Só com `canViewDispatch` (DT7): sem ele, a tela não mostra "Ver resultado". */
      dispatchId: z.string().nullish(),
      /** Só com a pendência no alcance de quem olha (K2-4). */
      pendency: z.object({ situation: pendencySituationSchema }).nullish(),
    })
    .nullable(),
});
export type ConversationLastDispatch = z.infer<typeof conversationLastDispatchSchema>;

const NO_DISPATCH: ConversationLastDispatch = { last: null };

/** Resposta fora do contrato vira "sem envio": o topo some em vez de quebrar a conversa. */
function parseConversationLastDispatch(data: unknown): ConversationLastDispatch {
  const result = conversationLastDispatchSchema.safeParse(data);
  if (result.success) return result.data;
  console.warn('[chat] response did not match ConversationLastDispatch schema (drift?):', result.error.issues);
  return NO_DISPATCH;
}

/** Último envio à equipe nesta conversa. A chave está sob `chat`: `invalidateChat` e o stream a recarregam. */
export function useConversationLastDispatch(conversationId: string) {
  return useQuery({
    queryKey: ['chat', 'last-dispatch', conversationId] as const,
    queryFn: () =>
      api
        .get(`internal/team-whatsapp/conversations/${conversationId}/last-dispatch`)
        .json<unknown>()
        .then(parseConversationLastDispatch),
  });
}

const DISPATCH_TEXT = 'Envio à equipe';
const REMINDER_TEXT = 'Lembrete do alerta';
const LAST_DISPATCH_TEXT = 'Último envio à equipe nesta conversa';

/** Finalidade como o operador a vê; sem finalidade (envio antigo) ou desconhecida, `null`. */
function purposeLabel(purpose: TeamPurpose | null): string | null {
  return purpose !== null && Object.hasOwn(PURPOSE_LABEL, purpose) ? PURPOSE_LABEL[purpose] : null;
}

/** Texto da etiqueta de uma mensagem (DT6), na hora de Manaus. */
export function teamTagText(tag: ChatMessageTeamTag): string {
  switch (tag.kind) {
    case 'reminder':
      return REMINDER_TEXT;
    case 'alert_reply':
      return `Resposta ao alerta de ${historyTime(tag.alertSentAt).slice(-5)}`;
    case 'dispatch': {
      const label = purposeLabel(tag.purpose);
      const time = historyTime(tag.sentAt);
      return label ? `${DISPATCH_TEXT}: ${label} · ${time}` : `${DISPATCH_TEXT} · ${time}`;
    }
  }
}

/**
 * Texto da faixa do topo da conversa (DT7): "último envio", nunca "origem da resposta"; o link "Ver resultado"
 * é da tela (só com `dispatchId`).
 */
export function lastDispatchText(last: NonNullable<ConversationLastDispatch['last']>): string {
  const what = last.isReminder ? REMINDER_TEXT : (purposeLabel(last.purpose) ?? DISPATCH_TEXT);
  const pendency = last.pendency ? ` · Pendência: ${PENDENCY_SITUATION_LABEL[last.pendency.situation]}` : '';
  return `${LAST_DISPATCH_TEXT}: ${what} · ${historyTime(last.sentAt)}${pendency}`;
}
