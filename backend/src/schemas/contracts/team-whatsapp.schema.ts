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
// SCHEDULED = aguardando o disparo agendado; CANCELLED = envio cancelado antes.
export const teamRecipientStatusSchema = z.enum([
  'QUEUED',
  'SENT',
  'FAILED',
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
/** Pessoa da foto na lista de envios: setor/nível sempre presentes (null = foto antiga). */
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
 * C4: escala dos setores pedidos na data, setores por nome (pt-BR); cada pessoa
 * aparece em um setor só. `startsAt` = início do turno na data (ISO).
 */
export const teamRosterResponseSchema = z.object({
  date: civilDateSchema,
  shiftStarts: z.object({ shiftId: z.string(), startsAt: z.string() }).array(),
  sectors: z
    .object({
      sectorId: z.string(),
      name: z.string(),
      members: teamRosterMemberSchema.array(),
    })
    .array(),
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

export const teamDispatchCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

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
      // null = canal removido depois do envio (o front mostra "canal removido").
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: teamDispatchCountsSchema,
      // Todos os destinatários, por nome, sem telefone. reason = errorCode (FAILED)
      // ou skipReason (SKIPPED); null nos demais. userId null = usuário apagado.
      recipients: z
        .object({
          userId: z.string().nullable(),
          name: z.string(),
          // Nome do turno do destinatário no envio; null = sem turno.
          shiftName: z.string().nullable(),
          status: teamRecipientStatusSchema,
          reason: z.string().nullable(),
          // C6: setor em que entrou e nível na hora; null = alvo pessoa ou
          // envio anterior (o backfill preenche só o setor).
          sectorName: z.string().nullable(),
          levelName: z.string().nullable(),
        })
        .array(),
      // Data da escala do envio; null = envio anterior à foto da escala.
      rosterDate: civilDateSchema.nullable(),
      state: teamDispatchStateSchema,
      // Início do turno do agendado (ISO); null = envio imediato.
      scheduledFor: z.string().nullable(),
      // Hora real do disparo do agendado (ISO); null = imediato ou não disparado.
      firedAt: z.string().nullable(),
      // Da foto: escalados no filtro que não são destinatários.
      unselected: listedRosterPersonSchema.array(),
      // Da foto: de folga que não são destinatários. Sem foto → [] nos dois.
      off: listedRosterPersonSchema.array(),
    })
    .array(),
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
});

/** C9: resposta do POST /internal/team-whatsapp/dispatches/:id/cancel. */
export const cancelTeamDispatchResponseSchema = z.object({
  id: z.string(),
  state: z.literal('CANCELLED'),
});

export type TeamShiftSnapshot = z.infer<typeof teamShiftSnapshotSchema>;
export type TeamRosterPerson = z.infer<typeof rosterPersonSchema>;
export type TeamTargetsResponse = z.infer<typeof teamTargetsResponseSchema>;
export type TeamRosterQuery = z.infer<typeof teamRosterQuerySchema>;
export type TeamRosterResponse = z.infer<typeof teamRosterResponseSchema>;
export type TeamRosterMember = z.infer<typeof teamRosterMemberSchema>;
export type CreateTeamDispatchResponse = z.infer<
  typeof createTeamDispatchResponseSchema
>;
export type TeamDispatchCounts = z.infer<typeof teamDispatchCountsSchema>;
export type TeamDispatchListResponse = z.infer<
  typeof teamDispatchListResponseSchema
>;
export type TeamScheduledListResponse = z.infer<
  typeof teamScheduledListResponseSchema
>;
export type CancelTeamDispatchResponse = z.infer<
  typeof cancelTeamDispatchResponseSchema
>;
