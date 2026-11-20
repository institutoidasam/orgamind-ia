import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import type {
  AudienceRuleSnapshot,
  TeamActivity,
  TeamAudienceBase,
  TeamAudiencePerson,
  TeamAudiencePreview,
  TeamAudienceRuleView,
  TeamExclusionReason,
  TeamPurpose,
  TeamShiftSnapshot,
} from '../../schemas/contracts/team-whatsapp.schema';
import { nameView, phoneView } from '../../shared/authz/phone-visibility';
import type { Env } from '../../shared/config/env.schema';
import { ConsentService } from '../consent/consent.service';
import { LevelsRepository } from '../levels/levels.repository';
import type { CivilDate } from '../staff-schedule/civil-date';
import type { AudienceEntry } from './audience-classify';
import { classifyPeople, shiftNamesOf } from './audience-people';
import {
  audienceKey,
  deriveAudienceSecret,
  type AudienceKeyInput,
} from './audience-key';
import {
  requireLevels,
  requireShifts,
  type PickedLevels,
} from './audience-scope';
import type {
  SectorTargetInput,
  TeamAudienceRequest,
} from './dto/create-team-dispatch.dto';
import {
  phoneSkipReason,
  sendPhoneOf,
  type PhoneSkipReason,
} from './recipient-skip';
import { buildAudience } from './team-whatsapp.audience';
import {
  broadSendDenied,
  invalidSelection,
  teamForbidden,
  type AudienceBlock,
} from './team-whatsapp.errors';
import { seesFullPhone, sortByViewedName } from './team-whatsapp.name-view';
import {
  canBroadSend,
  canSendToSector,
  isBroadSend,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import {
  PURPOSE_RULES,
  assertPurposeRules,
  blocksFor,
  policyOf,
  resolveBase,
  scheduledForOf,
} from './team-whatsapp.purpose';
import {
  TeamWhatsappRepository,
  type TeamMember,
  type TeamSector,
} from './team-whatsapp.repository';

/** Pedido do público: o da prévia; o envio (T8b) passa o seu com alvo setor. */
export type AudienceRequest = TeamAudienceRequest & {
  target: SectorTargetInput;
};

/** Pessoa fora do público com o motivo (regra, seleção ou pulo de telefone, DF3). */
export type ExcludedEntry = Omit<AudienceEntry, 'reason'> & {
  reason: TeamExclusionReason;
};

/**
 * Público resolvido (CF9), o mesmo para a prévia e o envio. `receiving` = quem
 * recebe (sem motivo e sem pulo de telefone); `unknownSelected` = ids marcados
 * sem relação com os setores e turnos (o chamador decide o 422, depois da
 * impressão no envio). `shifts` vazio = todos os turnos.
 */
export type ResolvedAudience = {
  purpose: TeamPurpose;
  base: TeamAudienceBase;
  includeOff: boolean;
  date: CivilDate;
  sectors: TeamSector[];
  shifts: ShiftRef[];
  levels: { id: string; name: string }[];
  receiving: AudienceEntry[];
  excluded: ExcludedEntry[];
  unknownSelected: string[];
  audienceKey: string;
  ruleSnapshot: AudienceRuleSnapshot;
};

/** O que decide o público, já conferido (regra, alcance, turnos, níveis e disparo amplo). */
type Scope = {
  purpose: TeamPurpose;
  base: TeamAudienceBase;
  includeOff: boolean;
  date: CivilDate;
  sectors: TeamSector[];
  active: ShiftRef[];
  shifts: TeamShiftSnapshot[];
  levels: PickedLevels;
  withoutLevel: boolean;
  // null = sem seleção nominal (ausente ou vazia, como em `buildAudience`).
  userIds: string[] | null;
};

const SKIP_REASON: Record<PhoneSkipReason, TeamExclusionReason> = {
  NO_PHONE: 'no_phone',
  SUPPRESSED: 'suppressed',
  NOT_AUTHORIZED: 'not_authorized',
};

const displayName = (u: { name: string | null; email: string | null }) =>
  u.name ?? u.email ?? '';

/** Ordem dos setores no público e no painel (GC12). */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'pt-BR');

/**
 * Público do envio para a equipe por finalidade (C3/C4). A prévia passa pelas
 * mesmas portas do envio (GF8/GF9): remetente (403) → erros de regra (422) →
 * alcance de cada setor, na ordem pedida (403 sem dizer quais setores existem)
 * → turnos e níveis (422) → disparo amplo (403, antes de ler pessoas) →
 * pessoas da data → classificação por setor → público → pulo de telefone →
 * impressão. Telefone e nome só saem pela visão de quem pede (`phoneView` e
 * `nameView`); a impressão usa o telefone completo e nunca é logada.
 */
@Injectable()
export class TeamAudienceService {
  private secret: Buffer | null = null;

  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly consent: ConsentService,
    private readonly levels: LevelsRepository,
    private readonly config: ConfigService<Env>,
  ) {}

  /**
   * Prévia (C4): aceita texto e seleção vazios e devolve as travas como lista
   * (CF4). Id marcado sem relação → 422 `invalid_selection`, sem lista.
   */
  async preview(
    actorId: string,
    input: TeamAudienceRequest,
  ): Promise<TeamAudiencePreview> {
    const actor = await this.requireSender(actorId);
    const resolved = await this.resolve(actor, input);
    if (resolved.unknownSelected.length > 0) throw invalidSelection();
    const channels = await this.repo.findSectorChannels(
      resolved.sectors.map((s) => s.id),
    );
    // O mesmo instante do envio (DG8): o "data e hora" chega às travas.
    const scheduledFor = scheduledForOf({
      request: input,
      date: resolved.date,
      shifts: resolved.shifts,
    });
    const blocks = blocksFor({
      request: input,
      receivingCount: resolved.receiving.length,
      selectedCount: resolved.ruleSnapshot.selectedUserIds?.length ?? null,
      scheduledFor,
      numbersMissing: [...channels.values()].some((c) => c === null),
      now: new Date(),
    });
    return toPreview(resolved, {
      input,
      scheduledFor,
      blocks,
      full: seesFullPhone(actor),
    });
  }

  /** Público da regra (GF5/GF9 até a leitura das pessoas), com a impressão (CF7). */
  async resolve(
    actor: TeamActor,
    input: AudienceRequest,
  ): Promise<ResolvedAudience> {
    const scope = await this.scopeOf(actor, input);
    const people = await this.repo.loadDayPeopleMany(
      scope.sectors.map((s) => s.id),
      scope.date,
    );
    const audience = buildAudience({
      sectors: classifyPeople({
        base: scope.base,
        includeOff: scope.includeOff,
        date: scope.date,
        sectors: scope.sectors,
        shiftIds: scope.shifts.map((s) => s.id),
        shiftNames: shiftNamesOf(scope.active, [...people.values()].flat()),
        level: scope.levels.filter,
        people,
      }),
      userIds: scope.userIds ?? undefined,
    });
    const { receiving, skipped } = await this.splitByPhone(audience.included);
    const excluded = [...withReason(audience.excluded), ...skipped];
    return {
      purpose: scope.purpose,
      base: scope.base,
      includeOff: scope.includeOff,
      date: scope.date,
      sectors: scope.sectors,
      shifts: scope.shifts,
      levels: scope.levels.levels,
      receiving,
      excluded,
      unknownSelected: audience.unknownSelected,
      audienceKey: audienceKey(
        keyInputOf(scope, receiving, excluded),
        this.secretKey(),
      ),
      ruleSnapshot: ruleSnapshotOf(scope),
    };
  }

  private async requireSender(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    return actor;
  }

  /** Portas antes de ler pessoas, na ordem de GF9; nada é lido além do necessário. */
  private async scopeOf(
    actor: TeamActor,
    input: AudienceRequest,
  ): Promise<Scope> {
    assertPurposeRules(input);
    const { purpose, target } = input;
    const base = resolveBase(purpose, input.base);
    const sectors = await this.requireSectors(actor, target.sectorIds);
    const active = await this.repo.listActiveShifts();
    const shifts = requireShifts(active, target.shiftIds);
    const levels = await requireLevels(this.levels, target);
    await this.requireBroadSendAllowed(actor, sectors);
    return {
      purpose,
      base,
      includeOff: target.includeOff === true,
      date: target.date,
      sectors,
      active,
      shifts,
      levels,
      withoutLevel: target.withoutLevel === true,
      userIds: target.userIds?.length ? [...new Set(target.userIds)] : null,
    };
  }

  /** GC6: um setor por vez, na ordem pedida; o primeiro fora do alcance (ou inexistente) dá 403. */
  private async requireSectors(
    actor: TeamActor,
    sectorIds: readonly string[],
  ): Promise<TeamSector[]> {
    const sectors: TeamSector[] = [];
    for (const id of new Set(sectorIds)) {
      const sector = await this.repo.findSector(id);
      if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
      sectors.push(sector);
    }
    return sectors.sort(byName);
  }

  /** Disparo amplo (B4): só depende dos setores pedidos; quem tem a chave nem lê os ativos. */
  private async requireBroadSendAllowed(
    actor: TeamActor,
    sectors: readonly TeamSector[],
  ): Promise<void> {
    if (canBroadSend(actor)) return;
    const requested = sectors.map((s) => s.id);
    const active = await this.repo.listActiveSectorIds();
    if (isBroadSend(requested, active)) throw broadSendDenied();
  }

  /**
   * DF3: dos incluídos, quem não tem telefone, tem o número bloqueado ou não
   * autorizou contato sai de quem recebe e fica excluído com o motivo (ordem
   * do `phoneSkipReason`). Uma consulta por vez, como a montagem do envio.
   */
  private async splitByPhone(
    included: readonly AudienceEntry[],
  ): Promise<{ receiving: AudienceEntry[]; skipped: ExcludedEntry[] }> {
    const receiving: AudienceEntry[] = [];
    const skipped: ExcludedEntry[] = [];
    for (const entry of included) {
      const skip = await phoneSkipReason(entry.member, this.consent);
      if (skip) skipped.push({ ...entry, reason: SKIP_REASON[skip] });
      else receiving.push(entry);
    }
    return { receiving, skipped };
  }

  /** Chave da impressão (DF5), derivada uma vez do JWT_SECRET; nunca logada. */
  private secretKey(): Buffer {
    this.secret ??= deriveAudienceSecret(
      this.config.get('JWT_SECRET', { infer: true }) ?? '',
    );
    return this.secret;
  }
}

/** `buildAudience` só põe em `excluded` quem tem motivo; aqui o tipo diz isso. */
function withReason(entries: readonly AudienceEntry[]): ExcludedEntry[] {
  return entries.flatMap((e) => (e.reason ? [{ ...e, reason: e.reason }] : []));
}

/** Entrada da impressão (CF7): telefone COMPLETO de quem recebe; excluído sem número. */
function keyInputOf(
  scope: Scope,
  receiving: readonly AudienceEntry[],
  excluded: readonly ExcludedEntry[],
): AudienceKeyInput {
  return {
    rule: {
      purpose: scope.purpose,
      base: scope.base,
      includeOff: scope.includeOff,
      date: scope.date,
      sectorIds: scope.sectors.map((s) => s.id),
      shiftIds: scope.shifts.length ? scope.shifts.map((s) => s.id) : null,
      levelIds: scope.levels.levels.map((l) => l.id),
      withoutLevel: scope.withoutLevel,
      userIds: scope.userIds,
    },
    receiving: receiving.map((e) => ({
      userId: e.member.id,
      sectorId: e.sectorId,
      shiftId: e.shiftId,
      phone: sendPhoneOf(e.member) ?? '',
    })),
    excluded: excluded.map((e) => ({
      userId: e.member.id,
      sectorId: e.sectorId,
      reason: e.reason,
    })),
  };
}

function ruleSnapshotOf(scope: Scope): AudienceRuleSnapshot {
  return {
    shifts: scope.shifts.length
      ? scope.shifts.map(({ id, name }) => ({ id, name }))
      : null,
    levels: scope.levels.levels,
    withoutLevel: scope.withoutLevel,
    selectedUserIds: scope.userIds,
  };
}

/** Atividade do painel: só nas finalidades que a têm, e só se algo foi informado. */
function activityViewOf(input: TeamAudienceRequest): TeamActivity | null {
  if (PURPOSE_RULES[input.purpose].activity === 'none') return null;
  const { date, time, place } = input.activity ?? {};
  const view = { date: date ?? null, time: time ?? null, place: place || null };
  return view.date || view.time || view.place ? view : null;
}

function ruleViewOf(
  r: ResolvedAudience,
  input: TeamAudienceRequest,
  scheduledFor: Date | null,
): TeamAudienceRuleView {
  const urgent = PURPOSE_RULES[input.purpose].urgencyReason;
  return {
    purpose: r.purpose,
    base: r.base,
    includeOff: r.includeOff,
    rosterDate: r.date,
    sectors: r.sectors.map(({ id, name }) => ({ id, name })),
    shifts: r.ruleSnapshot.shifts,
    levels: r.levels,
    withoutLevel: r.ruleSnapshot.withoutLevel,
    selectedCount: r.ruleSnapshot.selectedUserIds?.length ?? null,
    activity: activityViewOf(input),
    urgencyReason: (urgent && input.urgencyReason) || null,
    when: input.when ?? 'now',
    scheduledFor: scheduledFor?.toISOString() ?? null,
    // DG6: a política que o envio deste momento grava.
    schedulePolicy: policyOf(input.when),
  };
}

/** Pessoa como sai na prévia: nome pela visão de quem pede (D11). */
function personView(
  e: Omit<AudienceEntry, 'reason'>,
  full: boolean,
): TeamAudiencePerson {
  return {
    userId: e.member.id,
    name: nameView(displayName(e.member), { full }),
    sectorId: e.sectorId,
    sectorName: e.sectorName,
    shiftName: e.shiftName,
    levelName: e.levelName,
  };
}

/** Telefone que o envio usaria, completo só com `telefone.ver_completo`; senão a máscara. */
function phoneOf(m: TeamMember, full: boolean): string | null {
  const view = phoneView(sendPhoneOf(m), { full });
  return view.phoneE164 ?? view.phoneMasked;
}

/** Sem a chave, pelo nome EXIBIDO com desempate por id (GF8); com ela, como veio. */
function viewed<T extends TeamAudiencePerson>(items: T[], full: boolean): T[] {
  return sortByViewedName(items, full, (p) => ({
    group: 0,
    name: p.name,
    id: p.userId,
  }));
}

function toPreview(
  r: ResolvedAudience,
  ctx: {
    input: TeamAudienceRequest;
    scheduledFor: Date | null;
    blocks: AudienceBlock[];
    full: boolean;
  },
): TeamAudiencePreview {
  const { full } = ctx;
  return {
    audienceKey: r.audienceKey,
    rule: ruleViewOf(r, ctx.input, ctx.scheduledFor),
    included: viewed(
      r.receiving.map((e) => ({
        ...personView(e, full),
        phone: phoneOf(e.member, full),
      })),
      full,
    ),
    excluded: viewed(
      r.excluded.map((e) => ({ ...personView(e, full), reason: e.reason })),
      full,
    ),
    blocks: ctx.blocks,
  };
}
