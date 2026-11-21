import { z } from "zod";
import { recipientStatusSchema } from "./schemas";

/**
 * Espelha `teamAlertPanelSchema` de `backend/src/schemas/contracts/team-whatsapp.schema.ts` (CI5): o painel de
 * pendências do alerta urgente. Tolerante nos campos que podem faltar: ausente = sem ciência e sem texto, nunca
 * "Ciente" (o painel erra para o lado seguro).
 */
const count = z.number().int().nonnegative();

/** Na ordem do painel (I6): quem ainda não recebeu, não respondeu, respondeu sem ciência e confirmou. */
export const ALERT_GROUPS = [
  "no_delivery",
  "no_reply",
  "replied",
  "acked",
] as const;

const alertGroupSchema = z.enum(ALERT_GROUPS);

const alertMessageSchema = z.object({
  text: z.string().nullable(),
  // `MessageKind` do servidor (TEXT, IMAGE, AUDIO...). Texto livre de propósito: tipo novo cai em "(Mensagem sem
  // texto)" em vez de derrubar o painel.
  kind: z.string(),
  at: z.string(),
});

const alertAckSchema = z.object({
  at: z.string(),
  kind: z.enum(["keyword", "manual"]),
  // Confirmou depois do prazo de ciência.
  late: z.boolean(),
  // Autor e observação da ciência manual; nulos na automática.
  byName: z.string().nullish(),
  note: z.string().nullish(),
});

const alertClosureSchema = z.object({
  at: z.string(),
  // Nulo quando o usuário que encerrou foi removido.
  byName: z.string().nullable(),
  reason: z.string(),
});

const alertPersonSchema = z.object({
  // Destinatário do alerta original: é o `id` da linha na tabela de destinatários.
  recipientId: z.string(),
  userName: z.string(),
  group: alertGroupSchema,
  status: recipientStatusSchema,
  ack: alertAckSchema.nullish(),
  // Mensagem que deu a ciência e a última resposta da pessoa.
  ackReply: alertMessageSchema.nullish(),
  lastReply: alertMessageSchema.nullish(),
  eligible: z.boolean(),
  mayHaveReceived: z.boolean(),
  // Tratativa encerrada sem ciência (K2-2); o back antigo não manda o campo.
  closure: alertClosureSchema.nullish(),
});

const alertReminderSchema = z.object({
  dispatchId: z.string(),
  createdAt: z.string(),
  authorName: z.string().nullish(),
  recipients: count,
});

export const teamAlertPanelSchema = z.object({
  dispatchId: z.string(),
  createdAt: z.string(),
  ackDeadlineMinutes: z.number().int(),
  ackDeadlineAt: z.string(),
  counts: z.object({
    noDelivery: count,
    noReply: count,
    replied: count,
    acked: count,
  }),
  people: alertPersonSchema.array(),
  reminders: z.object({
    count,
    max: z.number().int(),
    nextAllowedAt: z.string().nullish(),
    items: alertReminderSchema.array(),
  }),
});

export type TeamAlertPanel = z.infer<typeof teamAlertPanelSchema>;
export type AlertPerson = TeamAlertPanel["people"][number];
export type AlertMessage = NonNullable<AlertPerson["lastReply"]>;
export type AlertAck = NonNullable<AlertPerson["ack"]>;
export type AlertClosure = NonNullable<AlertPerson["closure"]>;
export type AlertReminder = TeamAlertPanel["reminders"]["items"][number];
export type AlertGroup = (typeof ALERT_GROUPS)[number];
