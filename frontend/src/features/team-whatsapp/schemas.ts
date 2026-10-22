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

export const teamConnectionStateSchema = z.enum(['open', 'connecting', 'close']);

export const teamChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  provider: z.enum(['GOZAP', 'EVOLUTION']),
  // null = sem evento recente (eventos expiram em 7 dias); não significa desconectado.
  connectionState: teamConnectionStateSchema.nullable(),
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
  channels: teamChannelSchema.array(),
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

/** Escala dos setores pedidos na data; setores por nome, cada pessoa em um só. */
export const teamRosterSchema = z.object({
  date: civilDateSchema,
  shiftStarts: z.object({ shiftId: z.string(), startsAt: z.string() }).array(),
  sectors: z.object({ sectorId: z.string(), name: z.string(), members: rosterMemberSchema.array() }).array(),
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

export const dispatchCountsSchema = z.object({
  queued: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  scheduled: z.number().int(),
  cancelled: z.number().int(),
});

/** Pessoa da foto da escala gravada no envio (sem telefone). */
export const rosterPersonSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  shiftName: z.string().nullable(),
  reason: z.enum(['DAY_OFF', 'VACATION']).nullable(),
  // Setor e nível da pessoa na hora do envio (D4); null = foto antiga, sem as chaves.
  sectorName: z.string().nullable(),
  levelName: z.string().nullable(),
});

export const dispatchRecipientSchema = z.object({
  // null = usuário apagado depois do envio.
  userId: z.string().nullable(),
  name: z.string(),
  // Turno da pessoa no dia; null = entrou pela folga ou sem turno.
  shiftName: z.string().nullable(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'SCHEDULED', 'CANCELLED']),
  // errorCode quando FAILED; 'NO_PHONE' | 'SUPPRESSED' | 'INACTIVE' quando SKIPPED; senão null.
  reason: z.string().nullable(),
  // Setor em que entrou e nível da época (não muda ao renomear); null = alvo pessoa ou envio antigo.
  sectorName: z.string().nullable(),
  levelName: z.string().nullable(),
});

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
      // Setores do envio por nome (snapshot); [] no alvo pessoa. Mais de um = histórico agrupa por setor.
      sectors: z.object({ id: z.string(), name: z.string() }).array(),
      // null = canal removido depois do envio.
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: dispatchCountsSchema,
      // Todos os destinatários, por nome, sem telefone.
      recipients: dispatchRecipientSchema.array(),
      // Data da escala; null = envio anterior à foto da escala.
      rosterDate: civilDateSchema.nullable(),
      // DISPATCHED = imediato ou agendado já disparado; SCHEDULED = aguardando; CANCELLED = cancelado.
      state: z.enum(['DISPATCHED', 'SCHEDULED', 'CANCELLED']),
      // Início do turno do agendado (ISO); null = envio imediato.
      scheduledFor: z.string().nullable(),
      // Hora real do disparo do agendado (ISO); null = imediato ou não disparado.
      firedAt: z.string().nullable(),
      // Da foto: escalados no filtro que não receberam / de folga (sem foto = []).
      unselected: rosterPersonSchema.array(),
      off: rosterPersonSchema.array(),
    })
    .array(),
});

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
});

export const cancelDispatchResponseSchema = z.object({ id: z.string(), state: z.literal('CANCELLED') });

export type ScheduledList = z.infer<typeof scheduledListSchema>;
export type ScheduledDispatch = ScheduledList['items'][number];
export type TeamTargets = z.infer<typeof teamTargetsSchema>;
export type TeamSector = z.infer<typeof teamSectorSchema>;
export type TeamRoster = z.infer<typeof teamRosterSchema>;
export type RosterMember = z.infer<typeof rosterMemberSchema>;
export type RosterPerson = z.infer<typeof rosterPersonSchema>;
export type TeamLevel = z.infer<typeof levelRefSchema>;
export type RosterSector = TeamRoster['sectors'][number];
export type TeamChannel = z.infer<typeof teamChannelSchema>;
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type DispatchList = z.infer<typeof dispatchListSchema>;
export type DispatchRecipient = z.infer<typeof dispatchRecipientSchema>;

export type RecipientPreview = { id: string; name: string };

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
      shiftId: string | null; // null = todos os turnos (não envia `shiftId`)
      includeOff: boolean; // só em "todos os turnos"
      userIds: string[] | null; // null = todos da lista (não envia `userIds`)
      /** Início do turno escolhido (ISO do servidor + HH:mm gravado); ausente = não dá para agendar. */
      shiftStart?: { startsAt: string; startTime: string };
      recipients: RecipientPreview[]; // vão receber (têm telefone)
      leftOut: RecipientPreview[]; // ficam de fora (sem telefone)
    };

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = {
  channelId: string;
  text: string;
  /** Padrão 'now'; 'shift_start' só com alvo setor + shiftId. */
  when?: 'now' | 'shift_start';
  target:
    | { type: 'user'; userId: string }
    | {
        type: 'sector';
        sectorIds: string[];
        date: string;
        shiftId?: string;
        userIds?: string[];
        includeOff?: boolean;
        levelIds?: string[];
        withoutLevel?: boolean;
      };
};
