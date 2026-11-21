import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "@/lib/api-client";
import { dispatchKey } from "./api";
import { apiErrorText, teamErrorMessage } from "./error-messages";

/** Espelha `teamReminderResponseSchema` (CI7): o envio do lembrete e quantas pessoas entraram na fila. */
const reminderResponseSchema = z.object({
  reminderId: z.string(),
  queued: z.number().int().nonnegative(),
});

const alertUrl = (alertId: string) =>
  `internal/team-whatsapp/dispatches/${alertId}`;
const ackUrl = (alertId: string, recipientId: string) =>
  `${alertUrl(alertId)}/recipients/${recipientId}/ack`;

/**
 * Relê o que uma ação do alerta muda: o envio (a chave do painel e a dos destinatários nascem sob `dispatchKey`, uma
 * invalidação só relê os três) e o histórico (o lembrete é um envio novo). Também no erro: num 409/422 a tela já
 * estava velha.
 */
function useRefreshAlert(alertId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dispatchKey(alertId) }),
      qc.invalidateQueries({ queryKey: ["team-whatsapp", "dispatches"] }),
    ]);
}

/** Lembrete aos pendentes (CI7, DI10): `{ recipientIds }` → `{ reminderId, queued }`. */
export function useSendReminder(alertId: string) {
  const refresh = useRefreshAlert(alertId);
  return useMutation({
    mutationFn: async (recipientIds: string[]) =>
      reminderResponseSchema.parse(
        await api
          .post(`${alertUrl(alertId)}/reminders`, { json: { recipientIds } })
          .json(),
      ),
    onSettled: refresh,
  });
}

/** Ciência manual (CI6, DI7): `{ note }`, 204. */
export function useManualAck(alertId: string) {
  const refresh = useRefreshAlert(alertId);
  return useMutation({
    mutationFn: async (input: { recipientId: string; note: string }) => {
      await api.post(ackUrl(alertId, input.recipientId), {
        json: { note: input.note },
      });
    },
    onSettled: refresh,
  });
}

/** Desfaz a ciência manual (CI6): a pessoa volta a ser pendente, ou ciente pela palavra se já tinha respondido OK. */
export function useUndoManualAck(alertId: string) {
  const refresh = useRefreshAlert(alertId);
  return useMutation({
    mutationFn: async (recipientId: string) => {
      await api.delete(ackUrl(alertId, recipientId));
    },
    onSettled: refresh,
  });
}

/** Textos do envio que falam da prévia não servem às ações do alerta (o lembrete não tem prévia). */
const ALERT_ACTION_MESSAGES: Record<string, string> = {
  'team_whatsapp.channel_disconnected':
    'Um número desta área está desconectado. Reconecte-o em Conexões e tente de novo.',
};

/**
 * Texto do erro de uma ação do alerta: o do servidor ou o de `teamErrorMessage` para o código; o código que a tabela
 * não conhece cai no texto da própria ação, não no "enviar a mensagem" do envio.
 */
export function alertActionErrorText(
  err: unknown,
  fallback: string,
): Promise<string> {
  return apiErrorText(err, (code) => {
    if (code && ALERT_ACTION_MESSAGES[code]) return ALERT_ACTION_MESSAGES[code];
    const text = teamErrorMessage(code);
    return text === teamErrorMessage() ? fallback : text;
  });
}
