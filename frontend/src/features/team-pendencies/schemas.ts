import { z } from "zod";
import { ALERT_GROUPS } from "@/features/team-whatsapp/alert-schemas";

/**
 * Espelha `backend/src/schemas/contracts/team-pendency.schema.ts` (CK2). O back é a fonte; aqui o contrato é
 * tolerante (GK7): campo que pode faltar lê como `null`, lista ausente como vazia e flag ausente do lado seguro
 * (sem telefone, sem acesso ao resultado do alerta), para um campo novo do servidor não derrubar a tela.
 */
export const PENDENCY_SITUATIONS = [
  "UNASSIGNED",
  "IN_PROGRESS",
  "OVERDUE",
  "ACKED",
  "CLOSED",
] as const;

export const pendencySituationSchema = z.enum(PENDENCY_SITUATIONS);
export type PendencySituation = z.infer<typeof pendencySituationSchema>;

/** As situações em aberto: o padrão da lista e o que o contador do menu soma. */
export const OPEN_PENDENCY_SITUATIONS: readonly PendencySituation[] = [
  "UNASSIGNED",
  "IN_PROGRESS",
  "OVERDUE",
];

/** Ausente ou nulo lê como `null`. */
const orNull = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? null);
const listOf = <T extends z.ZodType>(schema: T) =>
  z
    .array(schema)
    .nullish()
    .transform((list) => list ?? []);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? false);

const personSchema = z.object({
  name: z.string(),
  sectorId: orNull(z.string()),
  sectorName: orNull(z.string()),
  shiftName: orNull(z.string()),
  phoneE164: orNull(z.string()),
  hasPhone: flag,
  phoneMasked: orNull(z.string()),
});

const alertSchema = z.object({
  text: z.string(),
  authorName: orNull(z.string()),
  sentAt: z.string(),
  ackDeadlineAt: z.string(),
});

const handlerSchema = z.object({
  id: z.string(),
  name: orNull(z.string()),
  state: z.enum(["active", "inactive", "out_of_scope"]),
});

const closureSchema = z.object({
  byId: orNull(z.string()),
  byName: orNull(z.string()),
  at: z.string(),
  reason: z.string(),
});

// `kind` e `media` ficam em texto livre de propósito: valor novo do servidor cai no caso neutro da tela
// (sem prefixo, "(Mensagem sem texto)", sem desfazer) em vez de derrubar a lista.
const ackSchema = z.object({ kind: z.string(), at: z.string() });

const lastReplySchema = z.object({
  text: orNull(z.string()),
  media: orNull(z.string()),
  at: z.string(),
});

const noteSchema = z.object({
  id: z.string(),
  kind: z.string(),
  authorName: orNull(z.string()),
  at: z.string(),
  text: z.string(),
});

export const teamPendencyItemSchema = z.object({
  // Id do destinatário do alerta (é o `:id` das rotas de ação).
  id: z.string(),
  dispatchId: z.string(),
  person: personSchema,
  alert: alertSchema,
  group: z.enum(ALERT_GROUPS),
  situation: pendencySituationSchema,
  handler: orNull(handlerSchema),
  assignedAt: orNull(z.string()),
  dueAt: orNull(z.string()),
  closure: orNull(closureSchema),
  ack: orNull(ackSchema),
  lastReply: orNull(lastReplySchema),
  notes: listOf(noteSchema),
  conversationId: orNull(z.string()),
  canViewDispatch: flag,
});

export const teamPendencyListSchema = z.object({
  items: listOf(teamPendencyItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  sectors: listOf(z.object({ id: z.string(), name: z.string() })),
  truncated: flag,
});

export const teamPendencyCountSchema = z.object({
  unassignedOverdue: z.number().int().nonnegative(),
});

/** Destinos de "Transferir": quem pode receber a pendência, sem o responsável atual (o servidor filtra o alcance). */
export const pendencyHandlersSchema = z.object({
  items: listOf(z.object({ id: z.string(), name: z.string() })),
});

export type TeamPendencyItem = z.infer<typeof teamPendencyItemSchema>;
export type TeamPendencyList = z.infer<typeof teamPendencyListSchema>;
export type TeamPendencyCount = z.infer<typeof teamPendencyCountSchema>;
export type PendencyHandlers = z.infer<typeof pendencyHandlersSchema>;
