import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { readApiErrorBody } from '@/lib/api-error';
import { invalidateChat } from './api';
import { boundaryParse, parseConversationsPage } from './schemas';

/** Teto de conversas por passagem (CT1); acima dele a lista avisa e o resto fica para outra passagem. */
export const HANDOVER_MAX_CONVERSATIONS = 100;

export const HANDOVER_SKIP_REASONS = ['resolved', 'other_assignee', 'unassigned', 'already_with_target', 'not_found'] as const;
export type HandoverSkipReason = (typeof HANDOVER_SKIP_REASONS)[number];

/** Corpo de `POST chat/handover`; sem `fromUserId`, passa quem pede (K3-1). */
export type ShiftHandoverInput = {
  toUserId: string;
  fromUserId?: string;
  note: string;
  conversationIds: string[];
};

const shiftHandoverResultSchema = z.object({
  transferred: z.array(z.object({ id: z.string() })),
  skipped: z.array(z.object({ id: z.string(), reason: z.enum(HANDOVER_SKIP_REASONS) })),
});
export type ShiftHandoverResult = z.infer<typeof shiftHandoverResultSchema>;

/**
 * Conversas em atendimento de quem sai (K3-1): a rota atual da lista, `status=open` e `assignee={fromId}`, até o
 * teto. Sempre recarrega ao abrir (a lista decide o que o diálogo marca). Chave sob `chat`: `invalidateChat` a recarrega.
 */
export function useHandoverConversations(fromId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'handover-list', fromId] as const,
    queryFn: () => {
      const params = new URLSearchParams({ status: 'open', assignee: fromId, pageSize: String(HANDOVER_MAX_CONVERSATIONS) });
      return api.get(`chat/conversations?${params.toString()}`).json<unknown>().then(parseConversationsPage);
    },
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

const SKIP_TEXT: Record<HandoverSkipReason, (targetName: string) => string> = {
  resolved: () => 'já resolvida',
  other_assignee: () => 'já com outro atendente',
  unassigned: () => 'já sem atendente',
  already_with_target: (targetName) => `já estava com ${targetName}`,
  not_found: () => 'não encontrada',
};

const UNKNOWN_SKIP_TEXT = 'não foi passada';

/** Motivo de uma conversa pulada (DT9). Motivo novo do servidor, ainda sem texto: neutro. */
export function handoverSkipText(reason: HandoverSkipReason, targetName: string): string {
  return Object.hasOwn(SKIP_TEXT, reason) ? SKIP_TEXT[reason](targetName) : UNKNOWN_SKIP_TEXT;
}

const HANDOVER_ERROR_TEXT: Record<string, string> = {
  'user.not_found': 'Esta pessoa não pode receber as conversas. Escolha outra.',
  'chat.not_assignee': 'Só um administrador pode passar as conversas de outra pessoa.',
};
const GENERIC_HANDOVER_ERROR = 'Não foi possível passar o turno. Tente de novo.';

/** Texto do toast de erro pelo `code` do corpo (DT9). */
export function handoverErrorText(code: string | undefined): string {
  return code && Object.hasOwn(HANDOVER_ERROR_TEXT, code) ? HANDOVER_ERROR_TEXT[code] : GENERIC_HANDOVER_ERROR;
}

/** `targetName` só serve ao toast; não vai no corpo. */
export type ShiftHandoverVars = { input: ShiftHandoverInput; targetName: string };

/**
 * Passagem de turno (K3-1/K3-2). Sucesso: toast com as passadas (nenhum toast se todas foram puladas: o diálogo
 * lista os motivos a partir do resultado) e recarrega a caixa. Erro: toast pelo `code` (ky 2: `readApiErrorBody`);
 * destino recusado recarrega a lista de destinos.
 */
export function useShiftHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input }: ShiftHandoverVars) =>
      api
        .post('chat/handover', { json: input })
        .json<unknown>()
        .then((data) => boundaryParse(shiftHandoverResultSchema, data, 'ShiftHandoverResult')),
    onSuccess: (result, { targetName }) => {
      const count = result.transferred.length;
      if (count > 0) toast.success(`${count} ${count === 1 ? 'conversa passada' : 'conversas passadas'} para ${targetName}.`);
      invalidateChat(qc);
    },
    onError: async (err) => {
      const code = (await readApiErrorBody(err))?.code;
      toast.error(handoverErrorText(code));
      if (code === 'user.not_found') void qc.invalidateQueries({ queryKey: ['chat-assignees'] });
    },
  });
}
