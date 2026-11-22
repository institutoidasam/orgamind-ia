import { z } from 'zod';

/**
 * Contrato das pendências da equipe (Lote K2, CK2): consulta, ações e resposta
 * de `/internal/team-whatsapp/pendencies*`. Datas serializadas como string ISO,
 * como em `team-whatsapp.schema.ts`. O front espelha estes tipos.
 */

export const PENDENCY_SITUATIONS = [
  'UNASSIGNED',
  'IN_PROGRESS',
  'OVERDUE',
  'ACKED',
  'CLOSED',
] as const;
export type PendencySituation = (typeof PENDENCY_SITUATIONS)[number];

/** Padrão da lista quando `situations` não vem (K2-5): as três abertas. */
export const OPEN_PENDENCY_SITUATIONS: readonly PendencySituation[] = [
  'UNASSIGNED',
  'IN_PROGRESS',
  'OVERDUE',
];

/** Estado do responsável (K2-2, DK4): ativo, inativo/sem acesso ou fora do alcance. */
export type HandlerState = 'active' | 'inactive' | 'out_of_scope';

const situationSchema = z.enum(PENDENCY_SITUATIONS);

/** `situations=A,B`: lista por vírgula, sem repetição; valor desconhecido é 400. */
const situationsQuerySchema = z
  .string()
  .transform((raw) => raw.split(',').map((item) => item.trim()))
  .pipe(
    z
      .array(situationSchema)
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Há situações repetidas.',
      }),
  )
  .default([...OPEN_PENDENCY_SITUATIONS]);

export const pendencyListQuerySchema = z.object({
  situations: situationsQuerySchema,
  sectorId: z.string().min(1).optional(),
  /** 'true' = "Minhas" (as pendências em que quem olha é o responsável). */
  mine: z.enum(['true', 'false']).optional(),
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(7), z.literal(30)]))
    .default(7),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** Aparada; vazia depois do trim = sem anotação (o serviço ignora). */
const optionalNote = z.string().trim().max(200).optional();
const requiredText = z.string().trim().min(1).max(200);

// `expectedHandlerId` sem `.optional()`: ausente é 400 (a tela diz quem via).
export const assumePendencySchema = z.object({
  expectedHandlerId: z.string().nullable(),
  note: optionalNote,
});
export const transferPendencySchema = z.object({
  toUserId: z.string().min(1),
  expectedHandlerId: z.string().nullable(),
});
export const pendencyNoteSchema = z.object({
  expectedHandlerId: z.string().nullable(),
  text: requiredText,
});
export const closePendencySchema = z.object({
  expectedHandlerId: z.string().nullable(),
  reason: requiredText,
});
export const reopenPendencySchema = z.object({
  expectedHandlerId: z.string().nullable(),
});

export type PendencyListQuery = z.infer<typeof pendencyListQuerySchema>;
export type AssumePendencyInput = z.infer<typeof assumePendencySchema>;
export type TransferPendencyInput = z.infer<typeof transferPendencySchema>;
export type PendencyNoteInput = z.infer<typeof pendencyNoteSchema>;
export type ClosePendencyInput = z.infer<typeof closePendencySchema>;
export type ReopenPendencyInput = z.infer<typeof reopenPendencySchema>;

export type PendencyNoteKind = 'CONTACT' | 'ASSUME' | 'CLOSE' | 'HANDOVER';

/** Mesmos valores de `alertGroupOf` (`team-alert.rules.ts`). */
export type PendencyAlertGroup =
  'no_delivery' | 'no_reply' | 'replied' | 'acked';

export type TeamPendencyItem = {
  /** = id do destinatário. */
  id: string;
  dispatchId: string;
  person: {
    name: string;
    sectorId: string | null;
    sectorName: string | null;
    shiftName: string | null;
    phoneE164: string | null;
    hasPhone: boolean;
    phoneMasked: string | null;
  };
  alert: {
    text: string;
    authorName: string | null;
    sentAt: string;
    ackDeadlineAt: string;
  };
  group: PendencyAlertGroup;
  situation: PendencySituation;
  handler: { id: string; name: string | null; state: HandlerState } | null;
  assignedAt: string | null;
  dueAt: string | null;
  closure: {
    byId: string | null;
    byName: string | null;
    at: string;
    reason: string;
  } | null;
  ack: { kind: 'KEYWORD' | 'MANUAL'; at: string } | null;
  /** Só no grupo 'replied' (K2-5); mídia vira `media`, sem legenda. */
  lastReply: {
    text: string | null;
    media: 'audio' | 'image' | 'file' | null;
    at: string;
  } | null;
  notes: {
    id: string;
    kind: PendencyNoteKind;
    authorName: string | null;
    at: string;
    text: string;
  }[];
  /** Só ADMIN/OPERATOR e com mensagem do envio. */
  conversationId: string | null;
  canViewDispatch: boolean;
};

export type TeamPendencyList = {
  items: TeamPendencyItem[];
  total: number;
  page: number;
  pageSize: number;
  sectors: { id: string; name: string }[];
  truncated: boolean;
};

export type TeamPendencyCount = { unassignedOverdue: number };

export type PendencyHandlersResponse = {
  items: { id: string; name: string }[];
};
