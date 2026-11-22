import { z } from 'zod';
import { levelRefSchema } from '@/features/levels/schemas';
import { shiftRefSchema } from '@/features/shifts/schemas';
import { civilDateSchema, daySituationSchema } from '@/features/staff-schedule/schemas';

/** Espelha `backend/src/schemas/contracts/team-whatsapp.schema.ts` (GC11). */

const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  // null = pessoa sem acesso ao sistema.
  email: z.string().nullable(),
});

/**
 * Número efetivo da área (D2) com o estado ao vivo (D7). `live.state` só `open` libera o envio;
 * `unknown` = não deu para conferir no provedor. `checkedAt` = hora da consulta (ISO).
 */
export const teamSectorChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  provider: z.enum(['GOZAP', 'EVOLUTION']),
  live: z.object({
    state: z.enum(['open', 'connecting', 'close', 'unknown']),
    checkedAt: z.string(),
  }),
});

export const teamSectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
});

/** `today` e `inProgress` vêm do servidor (fuso de Manaus); o front não faz conta de fuso (GC5). */
export const teamTargetsSchema = z.object({
  today: civilDateSchema,
  // Turno que começou na véspera e ainda não acabou.
  inProgress: z.object({ date: civilDateSchema, shift: shiftRefSchema }).nullable(),
  shifts: shiftRefSchema.array(),
  sectors: teamSectorSchema.array(),
  // Níveis ativos por sortOrder (filtro do envio).
  levels: levelRefSchema.array(),
});

export const rosterMemberSchema = personSchema.extend({
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  jobTitle: z.string().nullable(),
  fromOtherSector: z.boolean(),
  situation: daySituationSchema,
  level: levelRefSchema.nullable(),
});

/** Escala dos setores pedidos na data; setores por nome, cada pessoa em um só. `channel` null = área sem número. */
export const teamRosterSchema = z.object({
  date: civilDateSchema,
  shiftStarts: z.object({ shiftId: z.string(), startsAt: z.string() }).array(),
  sectors: z
    .object({
      sectorId: z.string(),
      name: z.string(),
      channel: teamSectorChannelSchema.nullable(),
      members: rosterMemberSchema.array(),
    })
    .array(),
});

/** Por qual número a pessoa recebe hoje; `sector` null = sem área (e então `channel` também é null). */
export const teamPersonRouteSchema = z.object({
  userId: z.string(),
  sector: z.object({ id: z.string(), name: z.string() }).nullable(),
  channel: teamSectorChannelSchema.nullable(),
});

/** Turno gravado no envio; tolerante como o `teamShiftSnapshotSchema` do back (sem regex HH:mm). */
export const shiftSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: z.string(),
  endTime: z.string(),
});

export const dispatchResultSchema = z.object({
  dispatchId: z.string(),
  queued: z.number().int(),
  // Agendado: `queued` 0 e `scheduled` > 0; `scheduledFor` = início do turno (ISO).
  scheduled: z.number().int(),
  scheduledFor: z.string().nullable(),
  skipped: z
    .object({
      userId: z.string(),
      name: z.string(),
      reason: z.enum(['NO_PHONE', 'SUPPRESSED', 'INACTIVE']),
    })
    .array(),
});

/** Situação de cada destinatário (GC11); a ordem é a do ciclo do envio. */
export const recipientStatusSchema = z.enum([
  'QUEUED', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'SCHEDULED', 'CANCELLED',
]);

const count = z.number().int().nonnegative();

/** Quantos destinatários há em cada situação (C5). */
export const dispatchCountsSchema = z.object({
  queued: count,
  sent: count,
  delivered: count,
  read: count,
  replied: count,
  failed: count,
  uncertain: count,
  skipped: count,
  scheduled: count,
  cancelled: count,
});

/** C5: totais da página das listas paginadas (`page`/`pageSize` ecoam a consulta). */
const pageMetaShape = {
  total: count,
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
};

export const dispatchListSchema = z.object({
  items: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      author: personSchema.nullable(),
      target: z.object({
        type: z.enum(['user', 'sector']),
        id: z.string(),
        label: z.string(),
        // Snapshot do filtro de turno; null = todos os turnos ou alvo pessoa.
        shift: shiftSnapshotSchema.nullable(),
      }),
      // Setores do envio por nome (snapshot); [] no alvo pessoa.
      sectors: z.object({ id: z.string(), name: z.string() }).array(),
      // Números usados, pelo snapshot dos destinatários (sem telefone de pessoa); name/phoneE164 null =
      // número removido depois do envio.
      channels: z
        .object({ name: z.string().nullable(), phoneE164: z.string().nullable(), count })
        .array(),
      counts: dispatchCountsSchema,
      // Data da escala; null = envio anterior à foto da escala.
      rosterDate: civilDateSchema.nullable(),
      // DISPATCHED = imediato ou agendado já disparado; SCHEDULED = aguardando; CANCELLED = cancelado.
      state: z.enum(['DISPATCHED', 'SCHEDULED', 'CANCELLED']),
      // Início do turno do agendado (ISO); null = envio imediato.
      scheduledFor: z.string().nullable(),
      // Hora real do disparo do agendado (ISO); null = imediato ou não disparado.
      firedAt: z.string().nullable(),
    })
    .array(),
  ...pageMetaShape,
});

const dispatchStateSchema = z.enum(['DISPATCHED', 'SCHEDULED', 'CANCELLED']);

const channelRefShape = { name: z.string().nullable(), phoneE164: z.string().nullable() };

/**
 * Pessoa que ficou de fora, como o back a lista no detalhe (`listedRosterPersonSchema`, sem telefone).
 * Exata de propósito: campo omitido pelo servidor tem de falhar alto, não sumir em silêncio.
 */
export const leftOutPersonSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  shiftName: z.string().nullable(),
  reason: z.enum(['DAY_OFF', 'VACATION']).nullable(),
  sectorName: z.string().nullable(),
  levelName: z.string().nullable(),
});

/** `GET /internal/team-whatsapp/dispatches/:id` (C5): topo da tela de resultado. */
export const dispatchDetailSchema = z.object({
  id: z.string(),
  targetLabel: z.string(),
  text: z.string(),
  state: dispatchStateSchema,
  createdAt: z.string(),
  scheduledFor: z.string().nullable(),
  firedAt: z.string().nullable(),
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  sectors: z.object({ id: z.string(), name: z.string() }).array(),
  channels: z.object({ ...channelRefShape, count }).array(),
  counts: dispatchCountsSchema,
  leftOut: z.object({ unselected: leftOutPersonSchema.array(), off: leftOutPersonSchema.array() }),
});

/** `GET /internal/team-whatsapp/dispatches/:id/recipients` (C5): uma página de destinatários. */
export const dispatchRecipientPageSchema = z.object({
  items: z
    .object({
      id: z.string(),
      userName: z.string(),
      sectorName: z.string().nullable(),
      levelName: z.string().nullable(),
      shiftName: z.string().nullable(),
      status: recipientStatusSchema,
      // `skipReason ?? errorCode`: 'NO_PHONE' | 'SUPPRESSED' | 'INACTIVE' ou o código da falha.
      reason: z.string().nullable(),
      attempts: z.number().int().nonnegative(),
      // null = sem número (pulado antes de escolher o canal).
      channel: z.object(channelRefShape).nullable(),
      acceptedAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      readAt: z.string().nullable(),
      repliedAt: z.string().nullable(),
      // Decisão do servidor (`isRepeatable`): só falha certa; o front não decide.
      repeatable: z.boolean(),
    })
    .array(),
  ...pageMetaShape,
});

/** `POST /internal/team-whatsapp/dispatches/:id/retry` (C6). */
export const retryResultSchema = z.object({ requeued: z.number().int().nonnegative() });

/** `GET /internal/team-whatsapp/scheduled`: envios aguardando o início do turno. */
export const scheduledListSchema = z.object({
  items: z
    .object({
      id: z.string(),
      scheduledFor: z.string(),
      rosterDate: civilDateSchema,
      shift: shiftSnapshotSchema,
      label: z.string(),
      recipientCount: z.number().int(),
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      author: personSchema.nullable(),
    })
    .array(),
  ...pageMetaShape,
});

export const cancelDispatchResponseSchema = z.object({ id: z.string(), state: z.literal('CANCELLED') });

export type ScheduledList = z.infer<typeof scheduledListSchema>;
export type ScheduledDispatch = ScheduledList['items'][number];
export type TeamTargets = z.infer<typeof teamTargetsSchema>;
export type TeamSector = z.infer<typeof teamSectorSchema>;
export type TeamRoster = z.infer<typeof teamRosterSchema>;
export type RosterMember = z.infer<typeof rosterMemberSchema>;
export type TeamLevel = z.infer<typeof levelRefSchema>;
export type RosterSector = TeamRoster['sectors'][number];
export type TeamSectorChannel = z.infer<typeof teamSectorChannelSchema>;
export type TeamPersonRoute = z.infer<typeof teamPersonRouteSchema>;
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type DispatchList = z.infer<typeof dispatchListSchema>;
export type RecipientStatus = z.infer<typeof recipientStatusSchema>;
export type DispatchCounts = z.infer<typeof dispatchCountsSchema>;
export type DispatchDetail = z.infer<typeof dispatchDetailSchema>;
export type DispatchRecipientPage = z.infer<typeof dispatchRecipientPageSchema>;
export type DispatchRecipient = DispatchRecipientPage['items'][number];
export type LeftOutRosterPerson = z.infer<typeof leftOutPersonSchema>;
/** Corpo do POST retry: algumas pessoas (1..100) ou todas as falhas certas. */
export type RetryInput = { recipientIds: string[] } | { all: true };

/** Props de `Pagination` (as listas paginadas do histórico e dos agendados). */
export type Paging = { page: number; pageSize: number; total: number; onPageChange: (page: number) => void };

export type RecipientPreview = { id: string; name: string };

/** Quem fica de fora da prévia: sem telefone, ou com telefone mas não marcado na seleção. */
export type LeftOutPerson = { name: string; reason: 'unselected' | 'no_phone' };

export type SendTarget =
  | { type: 'user'; userId: string; label: string }
  | {
      type: 'sector';
      sectorIds: string[];
      /** Filtro de nível; vazio + `withoutLevel` falso = todos (não envia nada). */
      levelIds: string[];
      withoutLevel: boolean;
      /** "Produção · Noite · 21/10" / "RH, TI +2 · Coordenador · todos os turnos · 21/10" / "… · seleção de 2" */
      label: string;
      date: string; // data da escala conferida na tela
      shiftIds: string[]; // vazio = todos os turnos (não envia `shiftIds`)
      includeOff: boolean; // só em "todos os turnos"
      userIds: string[] | null; // null = todos da lista (não envia `userIds`)
      /** Início do turno escolhido (ISO do servidor + HH:mm gravado); ausente = não dá para agendar. */
      shiftStart?: { startsAt: string; startTime: string };
      recipients: RecipientPreview[]; // vão receber (têm telefone)
      leftOut: LeftOutPerson[]; // ficam de fora, com o motivo
    };

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = {
  text: string;
  /** Padrão 'now'; 'shift_start' só com alvo setor + exatamente um turno (D9). */
  when?: 'now' | 'shift_start';
  target:
    | { type: 'user'; userId: string }
    | {
        type: 'sector';
        sectorIds: string[];
        date: string;
        shiftIds?: string[]; // 1..20; ausente = todos os turnos
        userIds?: string[];
        includeOff?: boolean; // só sem `shiftIds`
        levelIds?: string[];
        withoutLevel?: boolean;
      };
};
