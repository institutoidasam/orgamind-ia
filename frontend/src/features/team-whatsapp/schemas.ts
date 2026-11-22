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
  // CB5/DB8: `phoneE164` só vem com `telefone.ver_completo`; `hasPhone` e `phoneMasked` ("•••• 1234") vêm sempre.
  // Quem decide se a pessoa tem telefone é `hasPhone`, nunca `phoneE164`.
  phoneE164: z.string().nullable(),
  hasPhone: z.boolean(),
  phoneMasked: z.string().nullable(),
  isActive: z.boolean(),
  jobTitle: z.string().nullable(),
  fromOtherSector: z.boolean(),
  situation: daySituationSchema,
  level: levelRefSchema.nullable(),
  // C8: opcionais enquanto o back antigo não os envia; ausente = autorizado e verificado (nada muda na tela).
  contactAuthorization: z.enum(['AUTORIZADO', 'NAO_AUTORIZADO']).optional(),
  // Origem `CADASTRO_ANTERIOR`: recebe, mas a origem da autorização não foi verificada.
  authorizationUnverified: z.boolean().optional(),
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

/** Finalidade do envio à equipe (CF2/CF3): o servidor recusa envio a setor sem ela. */
export const teamPurposeSchema = z.enum(['shift_notice', 'meeting', 'alignment', 'lecture', 'overtime', 'urgency']);

/** Base do público: quem a escala põe para trabalhar, ou quem tem o setor e o turno no vínculo da data. */
export const teamAudienceBaseSchema = z.enum(['on_duty', 'assigned']);

/** Por que alguém ficou de fora da prévia (GF6). */
export const teamExclusionReasonSchema = z.enum([
  'not_selected', 'day_off', 'vacation', 'other_sector', 'other_shift', 'no_phone', 'not_authorized', 'suppressed',
]);

/**
 * Situação gravada do envio: DISPATCHED = imediato ou agendado já disparado; SCHEDULED = aguardando;
 * CANCELLED = cancelado; EXPIRED = agendado que passou da hora (mais de 2 h) e nunca saiu (G5).
 */
export const teamDispatchStateSchema = z.enum(['DISPATCHED', 'SCHEDULED', 'CANCELLED', 'EXPIRED']);

/** Política do agendado; nula no F (agendado sem política = regra antiga), o G a preenche. */
export const teamSchedulePolicySchema = z.enum(['immediate', 'frozen_recheck']);

/** Atividade que a mensagem anuncia (reunião, palestra, hora extra); tudo nulo = sem atividade. */
export const teamActivitySchema = z.object({
  date: civilDateSchema.nullable(),
  time: z.string().nullable(),
  place: z.string().nullable(),
});

const namedRefSchema = z.object({ id: z.string(), name: z.string() });

/** A regra do público como o servidor a aplicou (painel da regra). `shifts` null = todos os turnos. */
export const teamAudienceRuleViewSchema = z.object({
  purpose: teamPurposeSchema,
  base: teamAudienceBaseSchema,
  includeOff: z.boolean(),
  rosterDate: civilDateSchema,
  sectors: namedRefSchema.array(),
  shifts: namedRefSchema.array().nullable(),
  levels: namedRefSchema.array(),
  withoutLevel: z.boolean(),
  // null = sem seleção nominal (todos da lista).
  selectedCount: z.number().int().nullable(),
  activity: teamActivitySchema.nullable(),
  urgencyReason: z.string().nullable(),
  // 'at' = data e hora livres (G1). Envio anterior ao G não grava o momento: o servidor o infere.
  when: z.enum(['now', 'shift_start', 'at']),
  scheduledFor: z.string().nullable(),
  schedulePolicy: teamSchedulePolicySchema.nullable(),
});

/** Pessoa da prévia; `sectorId` = área por onde o servidor manda (é com ele que o front agrupa e conta). */
export const teamAudiencePersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  sectorId: z.string(),
  sectorName: z.string(),
  shiftName: z.string().nullable(),
  levelName: z.string().nullable(),
});

export const teamExcludedPersonSchema = teamAudiencePersonSchema.extend({ reason: teamExclusionReasonSchema });

/** `POST /internal/team-whatsapp/dispatches/preview` (CF3): o público que o envio teria. */
export const teamAudiencePreviewSchema = z.object({
  // Impressão do público; vai de volta no envio (`audienceKey`) e o servidor confere (409 se mudou).
  audienceKey: z.string(),
  rule: teamAudienceRuleViewSchema,
  included: teamAudiencePersonSchema.extend({ phone: z.string().nullable() }).array(),
  excluded: teamExcludedPersonSchema.array(),
  // Travas na ordem do servidor; vazia = pode enviar.
  blocks: z.object({ code: z.string(), message: z.string() }).array(),
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
      reason: z.enum(['NO_PHONE', 'SUPPRESSED', 'INACTIVE', 'NOT_AUTHORIZED']),
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
      state: teamDispatchStateSchema,
      // Início do turno do agendado (ISO); null = envio imediato.
      scheduledFor: z.string().nullable(),
      // Hora real do disparo do agendado (ISO); null = imediato ou não disparado.
      firedAt: z.string().nullable(),
      // Finalidade, base e atividade do envio; null = envio anterior à finalidade. A chave é obrigatória: um
      // envio novo sem ela estoura no parse em vez de aparecer como "regra anterior".
      purpose: teamPurposeSchema.nullable(),
      base: teamAudienceBaseSchema.nullable(),
      activity: teamActivitySchema.nullable(),
      urgencyReason: z.string().nullable(),
    })
    .array(),
  ...pageMetaShape,
});

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
  state: teamDispatchStateSchema,
  createdAt: z.string(),
  scheduledFor: z.string().nullable(),
  firedAt: z.string().nullable(),
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  sectors: z.object({ id: z.string(), name: z.string() }).array(),
  channels: z.object({ ...channelRefShape, count }).array(),
  counts: dispatchCountsSchema,
  leftOut: z.object({ unselected: leftOutPersonSchema.array(), off: leftOutPersonSchema.array() }),
  // Envio com finalidade: base, regra aplicada e excluídos com motivo (sem telefone). Envio antigo: nulos e
  // `excluded` vazio, e só `leftOut` vale. As chaves nulas são obrigatórias, como na lista.
  purpose: teamPurposeSchema.nullable(),
  base: teamAudienceBaseSchema.nullable(),
  rule: teamAudienceRuleViewSchema.nullable(),
  excluded: teamExcludedPersonSchema.array().default([]),
  // Reconferência do disparo (G3): `at` = hora (ISO), `skipped` = pulados na reconferência, `lateJoined` = quem entrou
  // no público depois do agendamento e não recebeu (sem telefone). Nulo/ausente = envio não reconferido (imediato,
  // antigo, cancelado, vencido ou ainda agendado): o servidor antigo não manda a chave.
  recheck: z
    .object({ at: z.string(), skipped: z.number().int(), lateJoined: teamAudiencePersonSchema.array() })
    .nullish(),
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
      // `skipReason ?? errorCode`: 'NO_PHONE' | 'SUPPRESSED' | 'INACTIVE' | 'NOT_AUTHORIZED' | 'VACATION' | 'DAY_OFF' |
      // 'LEFT_SECTOR' | 'PHONE_CHANGED' | 'EXPIRED' ou o código da falha.
      reason: z.string().nullable(),
      // Telefone gravado na criação, conforme `telefone.ver_completo`; nulo/ausente = não gravado (envio antigo).
      phone: z.string().nullish(),
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
      // null = agendado em data e hora com vários ou todos os turnos (G1): só `scheduledFor` diz quando sai.
      shift: shiftSnapshotSchema.nullable(),
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
export type TeamDispatchState = z.infer<typeof teamDispatchStateSchema>;
export type TeamPurpose = z.infer<typeof teamPurposeSchema>;
export type TeamAudienceBase = z.infer<typeof teamAudienceBaseSchema>;
export type TeamExclusionReason = z.infer<typeof teamExclusionReasonSchema>;
export type TeamSchedulePolicy = z.infer<typeof teamSchedulePolicySchema>;
export type TeamActivity = z.infer<typeof teamActivitySchema>;
export type TeamAudienceRuleView = z.infer<typeof teamAudienceRuleViewSchema>;
export type TeamAudiencePerson = z.infer<typeof teamAudiencePersonSchema>;
export type TeamExcludedPerson = z.infer<typeof teamExcludedPersonSchema>;
export type TeamAudiencePreview = z.infer<typeof teamAudiencePreviewSchema>;
export type DispatchRecipientPage = z.infer<typeof dispatchRecipientPageSchema>;
export type DispatchRecipient = DispatchRecipientPage['items'][number];
export type LeftOutRosterPerson = z.infer<typeof leftOutPersonSchema>;
/** Filtros do histórico (G5); campo ausente ou vazio não vai na consulta. */
export type DispatchListFilters = {
  from?: string;
  to?: string;
  purpose?: TeamPurpose;
  state?: TeamDispatchState;
};
/** Corpo do POST retry: algumas pessoas (1..100) ou todas as falhas certas. */
export type RetryInput = { recipientIds: string[] } | { all: true };

/** Props de `Pagination` (as listas paginadas do histórico e dos agendados). */
export type Paging = { page: number; pageSize: number; total: number; onPageChange: (page: number) => void };

export type RecipientPreview = { id: string; name: string };

/** Quem fica de fora da prévia: sem telefone, ou com telefone mas não marcado na seleção. */
export type LeftOutPerson = { name: string; reason: 'unselected' | 'no_phone' | 'not_authorized' };

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

/** Atividade que o operador informa (CF2): `time` em HH:mm; `place` o servidor apara e limita a 120. */
export type TeamActivityInput = { date?: string; time?: string; place?: string };

/** Alvo setor do corpo da prévia e do envio (CF2). */
export type SectorTargetInput = {
  type: 'sector';
  sectorIds: string[];
  date: string;
  shiftIds?: string[]; // 1..20; ausente = todos os turnos
  userIds?: string[]; // 0..500 na prévia; 1..500 no envio, quando presente
  includeOff?: boolean; // só folga; na base em serviço o servidor recusa (422 invalid_off_option)
  levelIds?: string[];
  withoutLevel?: boolean;
};

/** Campos da finalidade, comuns à prévia e ao envio a setor (CF2). */
type AudienceFields = {
  text: string;
  /**
   * Padrão 'now'; 'shift_start' só no Aviso de turno com exatamente um turno (D9); 'at' = data e hora livres
   * (todas as finalidades menos Urgência, só alvo setor), com `at`.
   */
  when?: 'now' | 'shift_start' | 'at';
  /** Obrigatório com `when: 'at'` e proibido sem ele (400): `time` em HH:mm, no fuso de Manaus. */
  at?: { date: string; time: string };
  /** Obrigatória com alvo setor; proibida com alvo pessoa (400). */
  purpose?: TeamPurpose;
  /** Ausente = a fixa ou padrão da finalidade. */
  base?: TeamAudienceBase;
  activity?: TeamActivityInput;
  urgencyReason?: string;
  /** Impressão da prévia conferida; obrigatória no envio a setor, ignorada na prévia. */
  audienceKey?: string;
};

/**
 * Corpo de `POST /internal/team-whatsapp/dispatches/preview` (CF2): só alvo setor; `text` pode ir vazio (DF11).
 * Sem `audienceKey` (é a impressão que a prévia devolve): a chave da consulta não muda com ela.
 */
export type TeamAudienceRequest = Omit<AudienceFields, 'audienceKey'> & { target: SectorTargetInput };

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = AudienceFields & {
  target: { type: 'user'; userId: string } | SectorTargetInput;
};
