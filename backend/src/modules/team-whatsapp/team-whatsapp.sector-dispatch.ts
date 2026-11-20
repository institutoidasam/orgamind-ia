import type {
  AudienceExcludedSnapshot,
  TeamAudienceBase,
  TeamExclusionReason,
  TeamPurpose,
  TeamSchedulePolicy,
  TeamShiftSnapshot,
  TeamWhen,
} from '../../schemas/contracts/team-whatsapp.schema';
import { ValidationError } from '../../shared/errors/domain.error';
import type { AudienceEntry } from './audience-classify';
import type {
  CreateTeamDispatchInput,
  SectorTargetInput,
} from './dto/create-team-dispatch.dto';
import { sendPhoneOf, type PhoneSkipReason } from './recipient-skip';
import type {
  AudienceRequest,
  ExcludedEntry,
  ResolvedAudience,
} from './team-audience.service';
import { recipientChannel } from './team-whatsapp.channels';
import { blocked, type AudienceBlock } from './team-whatsapp.errors';
import { PURPOSE_RULES, policyOf } from './team-whatsapp.purpose';
import {
  toDbBase,
  toDbPolicy,
  toDbPurpose,
} from './team-whatsapp.purpose-codes';
import type {
  DispatchActivity,
  NewTeamDispatch,
  NewTeamDispatchRecipient,
  TeamSectorChannelRow,
} from './team-whatsapp.repository';
import {
  NO_LEVEL_LABEL,
  sectorTargetLabel,
  shiftsLabel,
} from './team-whatsapp.roster';

/** Status de quem vai receber: QUEUED (agora) ou SCHEDULED (início do turno ou data e hora). */
export type PendingStatus = 'QUEUED' | 'SCHEDULED';

/**
 * O que a trilha do setor leva (GF12/DG6): setores, finalidade, base e política
 * (valores da API); o momento só no agendado (trilha `team_whatsapp.schedule`).
 */
export type SectorTrail = {
  sectorIds: string[];
  purpose: TeamPurpose;
  base: TeamAudienceBase;
  policy: TeamSchedulePolicy;
  when?: Exclude<TeamWhen, 'now'>;
};

/** Os três pulos de telefone (DF3): excluídos na prévia, `SKIPPED` no envio. */
const PHONE_SKIP: Partial<Record<TeamExclusionReason, PhoneSkipReason>> = {
  no_phone: 'NO_PHONE',
  suppressed: 'SUPPRESSED',
  not_authorized: 'NOT_AUTHORIZED',
};

const displayName = (u: { name: string | null; email: string | null }) =>
  u.name ?? u.email ?? '';

/**
 * Alvo setor exige a finalidade (DF13): o DTO já recusa sem ela (400) e o
 * serviço não cria caminho de compatibilidade.
 */
export function sectorRequestOf(
  input: CreateTeamDispatchInput,
  target: SectorTargetInput,
): AudienceRequest {
  const { purpose } = input;
  if (purpose === undefined)
    throw new ValidationError('Envio para setor exige a finalidade');
  return { ...input, purpose, target };
}

/** Envio: 422 com o código e o texto da primeira trava (CF4). */
export function requireNoBlock(blocks: readonly AudienceBlock[]): void {
  if (blocks.length > 0) throw blocked(blocks[0]);
}

/** Colunas de snapshot do turno do envio; null = todos os turnos, vários turnos ou alvo pessoa. */
export function shiftColumns(shift: TeamShiftSnapshot | null) {
  return {
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? null,
    shiftStartTime: shift?.startTime ?? null,
    shiftEndTime: shift?.endTime ?? null,
  };
}

/**
 * Destinatário pela entrada do público: turno, setor e nível dela; o número da
 * área dela (CF3, D3); o telefone que o envio usa, gravado na criação (DG7).
 */
function recipientOf(
  e: Omit<AudienceEntry, 'reason'>,
  numbers: ReadonlyMap<string, TeamSectorChannelRow>,
) {
  return {
    userId: e.member.id,
    userName: displayName(e.member),
    shiftId: e.shiftId,
    shiftName: e.shiftName,
    sectorId: e.sectorId,
    sectorName: e.sectorName,
    levelName: e.levelName,
    ...recipientChannel(numbers.get(e.sectorId)),
    phoneE164: sendPhoneOf(e.member),
  };
}

type RecipientRow = {
  entry: Omit<AudienceEntry, 'reason'>;
  status: PendingStatus | 'SKIPPED';
  skipReason: PhoneSkipReason | null;
};

const collator = new Intl.Collator('pt-BR');

/**
 * Ordem de hoje (`dayMembers`): setores na ordem do envio (por nome), em cada
 * um os do setor antes dos que vêm de fora, cada grupo pelo nome (pt-BR).
 */
function rosterOrder(sectors: readonly { id: string }[]) {
  const rank = new Map(sectors.map((s, i) => [s.id, i]));
  const sectorOf = (r: RecipientRow) => rank.get(r.entry.sectorId) ?? 0;
  const fromOutside = ({ entry }: RecipientRow) =>
    Number(entry.member.sectorId !== entry.sectorId);
  return (a: RecipientRow, b: RecipientRow) =>
    sectorOf(a) - sectorOf(b) ||
    fromOutside(a) - fromOutside(b) ||
    collator.compare(displayName(a.entry.member), displayName(b.entry.member));
}

/**
 * DF3: quem recebe fica `pending`; os pulados de telefone (sem telefone,
 * bloqueado, sem autorização) ficam `SKIPPED` com o motivo, na ordem de hoje.
 */
export function sectorRecipients(
  resolved: ResolvedAudience,
  pending: PendingStatus,
  numbers: ReadonlyMap<string, TeamSectorChannelRow>,
): NewTeamDispatchRecipient[] {
  const rows: RecipientRow[] = [
    ...resolved.receiving.map((entry) => ({
      entry,
      status: pending,
      skipReason: null,
    })),
    ...resolved.excluded.flatMap((entry) => {
      const skipReason = PHONE_SKIP[entry.reason];
      return skipReason
        ? [{ entry, status: 'SKIPPED' as const, skipReason }]
        : [];
    }),
  ];
  return rows
    .sort(rosterOrder(resolved.sectors))
    .map(({ entry, status, skipReason }) => ({
      ...recipientOf(entry, numbers),
      status,
      skipReason,
    }));
}

/** GC12: rótulo de hoje; `Sem nível` por último e "seleção de N" = ids marcados. */
function targetLabelOf(r: ResolvedAudience): string {
  const levelNames = r.levels.map((l) => l.name);
  if (r.ruleSnapshot.withoutLevel) levelNames.push(NO_LEVEL_LABEL);
  return sectorTargetLabel({
    sectorNames: r.sectors.map((s) => s.name),
    levelNames,
    shiftName: shiftsLabel(r.shifts.map((s) => s.name)),
    date: r.date,
    selected: r.ruleSnapshot.selectedUserIds?.length ?? null,
  });
}

/** Atividade gravada: só nas finalidades que a têm (T3) e só se algo foi informado. */
function activityOf(input: AudienceRequest): DispatchActivity | null {
  if (PURPOSE_RULES[input.purpose].activity === 'none') return null;
  const { date = null, time = null, place } = input.activity ?? {};
  const informed = { date, time, place: place || null };
  return date || time || informed.place ? informed : null;
}

/** Excluído gravado (F2): nome real, setor, turno e nível, sem telefone; o parse do repositório confere. */
function excludedOf(e: ExcludedEntry): AudienceExcludedSnapshot[number] {
  return {
    userId: e.member.id,
    name: displayName(e.member),
    sectorId: e.sectorId,
    sectorName: e.sectorName,
    shiftName: e.shiftName,
    levelName: e.levelName,
    reason: e.reason,
  };
}

/**
 * Campos do envio com finalidade (F2/CF8): alvo, rótulo e setores como hoje;
 * sem foto da escala (DF4: `roster` nulo); finalidade, base, atividade, motivo
 * da urgência, regra com o momento (DG8), todos os excluídos com o motivo
 * (DF3) e a política do momento (DG6: "agora" imediata; agendado reconfere).
 */
export function sectorDispatchFields(
  r: ResolvedAudience,
  input: AudienceRequest,
) {
  const urgent = PURPOSE_RULES[input.purpose].urgencyReason;
  return {
    targetType: 'SECTOR',
    targetId: r.sectors[0].id,
    targetLabel: targetLabelOf(r),
    ...shiftColumns(r.shifts.length === 1 ? r.shifts[0] : null),
    sectors: r.sectors.map((s) => ({ sectorId: s.id, sectorName: s.name })),
    rosterDate: r.date,
    includeOff: r.includeOff,
    roster: null,
    purpose: toDbPurpose(r.purpose),
    audienceBase: toDbBase(r.base),
    activity: activityOf(input),
    urgencyReason: (urgent && input.urgencyReason) || null,
    audienceRule: { ...r.ruleSnapshot, when: input.when ?? 'now' },
    audienceExcluded: r.excluded.map(excludedOf),
    schedulePolicy: toDbPolicy(policyOf(input.when)),
  } satisfies Partial<NewTeamDispatch>;
}

/**
 * Trilha do envio para setor (GF12/DG6): sem nome, telefone, texto, local nem
 * motivo; o momento só no agendado ("agora" leva só a política).
 */
export function sectorTrail(
  r: ResolvedAudience,
  when: TeamWhen = 'now',
): SectorTrail {
  return {
    sectorIds: r.sectors.map((s) => s.id),
    purpose: r.purpose,
    base: r.base,
    policy: policyOf(when),
    ...(when === 'now' ? {} : { when }),
  };
}
