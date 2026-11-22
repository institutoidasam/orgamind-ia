import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';
import { levelRefSchema } from './level.schema';
import { shiftRefSchema } from './shift.schema';
import { daySituationSchema } from './staff-schedule.schema';

/**
 * Contratos de resposta do WhatsApp da equipe (`/internal/team-whatsapp/*`).
 * Datas serializadas como string ISO, como em `user.schema.ts`.
 */

export const teamProviderSchema = z.enum(['GOZAP', 'EVOLUTION']);
// INACTIVE = usuário inativo ou apagado na hora do disparo agendado.
export const teamSkipReasonSchema = z.enum([
  'NO_PHONE',
  'SUPPRESSED',
  'INACTIVE',
]);
export const teamTargetTypeSchema = z.enum(['user', 'sector']);
// Último estado de conexão do canal; null = sem evento ou fora destes valores.
export const teamConnectionStateSchema = z.enum([
  'open',
  'connecting',
  'close',
]);
// Ordem do ciclo (C4): QUEUED < SENT < DELIVERED < READ < REPLIED; UNCERTAIN =
// o WhatsApp não confirmou (pode ter saído); SCHEDULED = aguardando o disparo
// agendado; CANCELLED = envio cancelado antes.
export const teamRecipientStatusSchema = z.enum([
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'REPLIED',
  'FAILED',
  'UNCERTAIN',
  'SKIPPED',
  'SCHEDULED',
  'CANCELLED',
]);
// DISPATCHED = imediato ou agendado já disparado; SCHEDULED = aguardando o início
// do turno; CANCELLED = cancelado antes do disparo.
export const teamDispatchStateSchema = z.enum([
  'DISPATCHED',
  'SCHEDULED',
  'CANCELLED',
]);

/** Turno gravado no envio (cópia de nome e horários no momento do POST). */
export const teamShiftSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: z.string(),
  endTime: z.string(),
});

/**
 * Pessoa da foto da escala gravada no envio (C8/C10), sem telefone (GC10).
 * userId null = sem usuário; shiftName = turno do dia (null = de folga);
 * reason = motivo de estar de folga (null = escalado).
 */
export const rosterPersonSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  shiftName: z.string().nullable(),
  reason: z.enum(['DAY_OFF', 'VACATION']).nullable(),
  // C6: setor e nível da pessoa na foto (gravados a partir da T8b); foto antiga
  // não tem as chaves e a lista devolve null.
  sectorName: z.string().nullable().optional(),
  levelName: z.string().nullable().optional(),
});
/** Pessoa da foto no detalhe do envio: setor/nível sempre presentes (null = foto antiga). */
const listedRosterPersonSchema = rosterPersonSchema.extend({
  sectorName: z.string().nullable(),
  levelName: z.string().nullable(),
});
/** working = escalados no filtro (marcados ou não); off = de folga/férias do setor. */
export const rosterSnapshotSchema = z.object({
  working: rosterPersonSchema.array(),
  off: rosterPersonSchema.array(),
});

// e-mail NULL = pessoa sem acesso (C2).
const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

/**
 * C6: alvos do envio. `today` e `inProgress` em Manaus (GC5): `inProgress` = turno
 * que começou na véspera e ainda não acabou (atalho "Ver esse turno"); `shifts` =
 * turnos ativos por sortOrder; `levels` = níveis ativos por sortOrder (C4). Os
 * membros vêm de `roster`, por data.
 */
export const teamTargetsResponseSchema = z.object({
  today: civilDateSchema,
  inProgress: z
    .object({ date: civilDateSchema, shift: shiftRefSchema })
    .nullable(),
  shifts: shiftRefSchema.array(),
  channels: z
    .object({
      id: z.string(),
      name: z.string(),
      phoneE164: z.string().nullable(),
      provider: teamProviderSchema,
      connectionState: teamConnectionStateSchema.nullable(),
    })
    .array(),
  sectors: z
    .object({ id: z.string(), name: z.string(), code: z.string() })
    .array(),
  levels: levelRefSchema.array(),
});

const MAX_ROSTER_SECTORS = 100;

/** `a,b,a` → `['a', 'b']`: vazios fora, repetidos contam uma vez; 1..100 setores. */
const sectorIdListSchema = z
  .string()
  .transform((raw) => [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ])
  .pipe(z.string().array().min(1).max(MAX_ROSTER_SECTORS));

/** D7: `sectorId` sozinho (aba aberta no deploy) vira `sectorIds` antes da validação. */
function sectorIdAlias(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const query = raw as Record<string, unknown>;
  if (query.sectorIds !== undefined || query.sectorId === undefined) return raw;
  return { ...query, sectorIds: query.sectorId };
}

/** Query do GET /internal/team-whatsapp/roster (C4): `sectorIds=a,b&date`. */
export const teamRosterQuerySchema = z.preprocess(
  sectorIdAlias,
  z.object({ sectorIds: sectorIdListSchema, date: civilDateSchema }),
);

/**
 * C6: escala de um setor na data. Ativos do setor principal, menos quem
 * trabalha em outro setor no dia, mais ativos de fora com WORK aqui
 * (`fromOtherSector`). `phoneE164` = o que o envio usaria (contato ligado, senão
 * o do usuário), para o grupo "Sem telefone". `level` = nível do cadastro (C4).
 */
const teamRosterMemberSchema = personSchema.extend({
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  jobTitle: z.string().nullable(),
  fromOtherSector: z.boolean(),
  situation: daySituationSchema,
  level: levelRefSchema.nullable(),
});

/**
 * C2: número efetivo da área (D2) com o estado ao vivo (D7). `phoneE164` é da
 * empresa (GC8). `live.state` só `open` libera o envio; `unknown` = não deu para
 * observar. `checkedAt` = hora da consulta ao provedor (ISO).
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

/**
 * C4/C2: escala dos setores pedidos na data, setores por nome (pt-BR); cada
 * pessoa aparece em um setor só. `startsAt` = início do turno na data (ISO).
 * `channel` = número da área (null = área sem número).
 */
export const teamRosterResponseSchema = z.object({
  date: civilDateSchema,
  shiftStarts: z.object({ shiftId: z.string(), startsAt: z.string() }).array(),
  sectors: z
    .object({
      sectorId: z.string(),
      name: z.string(),
      channel: teamSectorChannelSchema.nullable(),
      members: teamRosterMemberSchema.array(),
    })
    .array(),
});

/**
 * C2: por qual número a pessoa recebe hoje. `sector` = onde ela atua hoje
 * (exceção "Outro setor" da escala, senão o setor do cadastro); null = sem
 * área, e então `channel` também é null.
 */
export const teamPersonRouteResponseSchema = z.object({
  userId: z.string(),
  sector: z.object({ id: z.string(), name: z.string() }).nullable(),
  channel: teamSectorChannelSchema.nullable(),
});

/**
 * C7: envio imediato → `queued` > 0, `scheduled` 0, `scheduledFor` null;
 * agendado → `queued` 0, `scheduled` > 0, `scheduledFor` = início do turno (ISO).
 */
export const createTeamDispatchResponseSchema = z.object({
  dispatchId: z.string(),
  queued: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
  scheduledFor: z.string().nullable(),
  skipped: z
    .object({
      userId: z.string(),
      name: z.string(),
      reason: teamSkipReasonSchema,
    })
    .array(),
});

const countSchema = z.number().int().nonnegative();

/** C5: quantos destinatários há em cada situação (uma chave por status). */
export const teamDispatchCountsSchema = z.object({
  queued: countSchema,
  sent: countSchema,
  delivered: countSchema,
  read: countSchema,
  replied: countSchema,
  failed: countSchema,
  uncertain: countSchema,
  skipped: countSchema,
  scheduled: countSchema,
  cancelled: countSchema,
});

/**
 * C5: números usados, pelo snapshot dos destinatários. name/phoneE164 null =
 * número removido depois do envio. O telefone é do número (empresa), nunca de pessoa.
 */
export const teamDispatchChannelsSchema = z
  .object({
    name: z.string().nullable(),
    phoneE164: z.string().nullable(),
    count: countSchema,
  })
  .array();

/** C5: totais da página das listas paginadas (`page`/`pageSize` ecoam a consulta). */
const pageMetaShape = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
};

export const teamDispatchListResponseSchema = z.object({
  items: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      // null quando o autor foi apagado depois do envio.
      author: personSchema.nullable(),
      target: z.object({
        type: teamTargetTypeSchema,
        id: z.string(),
        label: z.string(),
        // Snapshot do filtro de turno; null = todos os turnos ou alvo pessoa.
        shift: teamShiftSnapshotSchema.nullable(),
      }),
      // C6: setores do envio por nome (snapshot); [] no alvo pessoa.
      sectors: z.object({ id: z.string(), name: z.string() }).array(),
      // D13: o histórico não traz destinatários (vão para o detalhe paginado).
      channels: teamDispatchChannelsSchema,
      counts: teamDispatchCountsSchema,
      // Data da escala do envio; null = envio anterior à foto da escala.
      rosterDate: civilDateSchema.nullable(),
      state: teamDispatchStateSchema,
      // Início do turno do agendado (ISO); null = envio imediato.
      scheduledFor: z.string().nullable(),
      // Hora real do disparo do agendado (ISO); null = imediato ou não disparado.
      firedAt: z.string().nullable(),
    })
    .array(),
  ...pageMetaShape,
});

/**
 * C5: `GET dispatches/:id`, o topo da tela de resultado. `leftOut` vem da foto
 * da escala: escalados no filtro e de folga que não são destinatários; sem foto
 * (ou foto antiga) → [] nos dois.
 */
export const teamDispatchDetailResponseSchema = z.object({
  id: z.string(),
  targetLabel: z.string(),
  text: z.string(),
  state: teamDispatchStateSchema,
  createdAt: z.string(),
  scheduledFor: z.string().nullable(),
  firedAt: z.string().nullable(),
  // null quando o autor foi apagado depois do envio.
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  sectors: z.object({ id: z.string(), name: z.string() }).array(),
  counts: teamDispatchCountsSchema,
  channels: teamDispatchChannelsSchema,
  leftOut: z.object({
    unselected: listedRosterPersonSchema.array(),
    off: listedRosterPersonSchema.array(),
  }),
});

/**
 * C5: `GET dispatches/:id/recipients`, uma página por nome. `reason` = skipReason
 * ?? errorCode; `channel` = número do snapshot (null = sem número); `repeatable`
 * é decisão do servidor (`isRepeatable`). Sem telefone de pessoa (GC8).
 */
export const teamDispatchRecipientPageSchema = z.object({
  items: z
    .object({
      id: z.string(),
      userName: z.string(),
      sectorName: z.string().nullable(),
      levelName: z.string().nullable(),
      shiftName: z.string().nullable(),
      status: teamRecipientStatusSchema,
      reason: z.string().nullable(),
      attempts: countSchema,
      channel: z
        .object({
          name: z.string().nullable(),
          phoneE164: z.string().nullable(),
        })
        .nullable(),
      acceptedAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      readAt: z.string().nullable(),
      repliedAt: z.string().nullable(),
      repeatable: z.boolean(),
    })
    .array(),
  ...pageMetaShape,
});

/**
 * C9: agendados ainda não disparados (`state = SCHEDULED`), por `scheduledFor`
 * asc. `shift` = snapshot gravado no agendamento; `recipientCount` = quantos
 * estão SCHEDULED; channel/author null = removidos depois do agendamento.
 */
export const teamScheduledListResponseSchema = z.object({
  items: z
    .object({
      id: z.string(),
      scheduledFor: z.string(),
      rosterDate: civilDateSchema,
      shift: teamShiftSnapshotSchema,
      label: z.string(),
      recipientCount: z.number().int().nonnegative(),
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      author: personSchema.nullable(),
    })
    .array(),
  ...pageMetaShape,
});

/** C9: resposta do POST /internal/team-whatsapp/dispatches/:id/cancel. */
export const cancelTeamDispatchResponseSchema = z.object({
  id: z.string(),
  state: z.literal('CANCELLED'),
});

/** C6: resposta do POST /internal/team-whatsapp/dispatches/:id/retry. */
export const retryTeamDispatchResponseSchema = z.object({
  requeued: z.number().int().nonnegative(),
});

export type TeamShiftSnapshot = z.infer<typeof teamShiftSnapshotSchema>;
export type TeamRosterPerson = z.infer<typeof rosterPersonSchema>;
export type TeamTargetsResponse = z.infer<typeof teamTargetsResponseSchema>;
export type TeamRosterQuery = z.infer<typeof teamRosterQuerySchema>;
export type TeamRosterResponse = z.infer<typeof teamRosterResponseSchema>;
export type TeamRosterMember = z.infer<typeof teamRosterMemberSchema>;
export type TeamSectorChannel = z.infer<typeof teamSectorChannelSchema>;
export type TeamPersonRoute = z.infer<typeof teamPersonRouteResponseSchema>;
export type CreateTeamDispatchResponse = z.infer<
  typeof createTeamDispatchResponseSchema
>;
export type TeamDispatchCounts = z.infer<typeof teamDispatchCountsSchema>;
export type TeamDispatchListResponse = z.infer<
  typeof teamDispatchListResponseSchema
>;
export type TeamDispatchChannels = z.infer<typeof teamDispatchChannelsSchema>;
export type TeamDispatchDetail = z.infer<
  typeof teamDispatchDetailResponseSchema
>;
export type TeamDispatchRecipientPage = z.infer<
  typeof teamDispatchRecipientPageSchema
>;
export type TeamScheduledListResponse = z.infer<
  typeof teamScheduledListResponseSchema
>;
export type CancelTeamDispatchResponse = z.infer<
  typeof cancelTeamDispatchResponseSchema
>;
export type RetryTeamDispatchResponse = z.infer<
  typeof retryTeamDispatchResponseSchema
>;
