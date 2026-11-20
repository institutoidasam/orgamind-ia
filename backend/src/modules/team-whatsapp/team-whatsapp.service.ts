import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { TeamWhatsappTargetType } from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
import { LevelsRepository } from '../levels/levels.repository';
import { AuditService } from '../../shared/audit/audit.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import {
  teamConnectionStateSchema,
  type CreateTeamDispatchResponse,
  type TeamDispatchChannels,
  type TeamDispatchCounts,
  type TeamDispatchListResponse,
  type TeamPersonRoute,
  type TeamRosterQuery,
  type TeamRosterResponse,
  type TeamSectorChannel,
  type TeamShiftSnapshot,
  type TeamTargetsResponse,
} from '../../schemas/contracts/team-whatsapp.schema';
import { hasPermission } from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';
import {
  fromDbDate,
  todayIn,
  type CivilDate,
} from '../staff-schedule/civil-date';
import { resolveDay } from '../staff-schedule/schedule-resolver';
import { ChannelLiveStateService } from '../whatsapp-providers/channel-live-state.service';
import { purposeView } from './dispatch-purpose-view';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import { dispatchListFilter } from './dispatch-list-filter';
import type { DispatchListQuery } from './dto/dispatch-list-query.dto';
import {
  phoneSkipReason,
  sendPhoneOf,
  type PhoneSkipReason,
} from './recipient-skip';
import {
  TeamAudienceService,
  type AudienceRequest,
} from './team-audience.service';
import {
  canSendToSector,
  canSendToUser,
  isTeamProvider,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import {
  audienceChanged,
  invalidSelection,
  invalidShift,
  noRecipients,
  noSector,
  teamForbidden,
} from './team-whatsapp.errors';
import { blocksFor, scheduledForOf } from './team-whatsapp.purpose';
import {
  requireNoBlock,
  sectorDispatchFields,
  sectorRecipients,
  sectorRequestOf,
  sectorTrail,
  shiftColumns,
  type SectorTrail,
} from './team-whatsapp.sector-dispatch';
import {
  authorView,
  seesFullPhone,
  sortByViewedName,
} from './team-whatsapp.name-view';
import { overnightInProgress } from './team-whatsapp.selection';
import {
  distinctLiveChannels,
  previewChannels,
  recipientChannel,
  recipientChannelIds,
  requireOpenNumbers,
  requireSectorNumbers,
  singleChannelId,
} from './team-whatsapp.channels';
import {
  dayMembers,
  shiftStarts,
  toRosterMembers,
  type SectorDay,
} from './team-whatsapp.roster';
import {
  TeamWhatsappRepository,
  type DispatchSector,
  type NewTeamDispatch,
  type NewTeamDispatchRecipient,
  type NewTeamRecipient,
  type RecipientSnapshot,
  type TeamCreatedDispatch,
  type TeamDispatchRow,
  type TeamMember,
  type TeamSector,
  type TeamSectorChannelRow,
} from './team-whatsapp.repository';
import {
  channelsByDispatch,
  countsByDispatch,
  zeroCounts,
} from './team-whatsapp-results.service';

const QUEUE_UNAVAILABLE = 'team_whatsapp.queue_unavailable';

/**
 * Destinatário do alvo pessoa: o membro, o turno do cadastro e o snapshot de
 * setor/nível (C6; tudo null no alvo pessoa).
 */
type TargetMember = {
  member: TeamMember;
  shiftId: string | null;
  shiftName: string | null;
  snapshot: RecipientSnapshot;
  // Área cujo número manda nesta pessoa (D3): onde ela aparece na data; no alvo
  // pessoa, a área do dia (o destinatário não guarda setor).
  routeSectorId: string;
};

/** Alvo pessoa: sem setor do envio nem nível no destinatário. */
const NO_SECTOR_SNAPSHOT: RecipientSnapshot = {
  sectorId: null,
  sectorName: null,
  levelName: null,
};

/** Alvo pessoa resolvido (GF1, caminho de hoje): a área do dia e o destinatário. */
type ResolvedUser = {
  targetId: string;
  targetLabel: string;
  // Área cujo número o envio usa e confere (GC7): a do dia da pessoa.
  numberSectors: DispatchSector[];
  members: TargetMember[];
};

type SkippedRecipient = CreateTeamDispatchResponse['skipped'][number];

/** Trilha do alvo (GF12): no setor, também setores, finalidade e base. */
type DispatchTrail = {
  targetType: TeamWhatsappTargetType;
  targetId: string;
} & Partial<SectorTrail>;

/** Envio montado e conferido, pronto para gravar: o registro, os números e a trilha. */
type DispatchDraft = {
  record: NewTeamDispatch;
  channelIds: string[];
  trail: DispatchTrail;
};

/** Envio já gravado, a enfileirar (agora) ou só auditar (agendado). */
type CreatedDispatch = {
  actorId: string;
  channelIds: string[];
  trail: DispatchTrail;
  created: TeamCreatedDispatch;
  skipped: SkippedRecipient[];
};

const displayName = (u: { name: string | null; email: string | null }) =>
  u.name ?? u.email ?? '';

/** Ordem dos setores no rótulo, nas linhas do envio e no roster (GC12). */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'pt-BR');

/**
 * Recado de ADMIN/gestor para a equipe. Remetente (403) e então:
 * - alvo setor (GF9): público de `TeamAudienceService.resolve`, o mesmo da
 *   prévia (erros de regra 422 → alcance de cada setor 403 → turnos e níveis
 *   422 → disparo amplo 403, antes de ler pessoas → pessoas da data) →
 *   impressão (409 `audience_changed`) → seleção (422 `invalid_selection`) →
 *   primeira trava do botão (422, CF4) → no imediato, estado ao vivo de cada
 *   número (409 `channel_disconnected`/`channel_unverified`, D7; o agendado não
 *   consulta o provedor) → grava finalidade, regra e excluídos (F2);
 * - alvo pessoa (GF1, como hoje): política (403) → área do dia e número (422
 *   `no_sector`/`sector_without_number`) → estado ao vivo (409) →
 *   destinatário (422 `no_recipients`) → grava.
 * Cada destinatário sai pelo número da sua área (D3); depois enfileira
 * (agendado: não; o disparo é do worker) e audita. Recusa = nada gravado,
 * enfileirado ou auditado (GC6). `channelId` do corpo é aceito e ignorado
 * (C3). Texto e telefones nunca vão para log, auditoria nem foto.
 */
@Injectable()
export class TeamWhatsappService {
  /**
   * Níveis ativos (C4, e o filtro de nível do POST, C5). Injeção por
   * propriedade: o construtor já tem 4 dependências, o limite da GC2.
   */
  @Inject(LevelsRepository)
  private readonly levels!: LevelsRepository;

  /** Estado ao vivo do número (D7), pela porta com cache; por propriedade, pelo mesmo motivo. */
  @Inject(ChannelLiveStateService)
  private readonly live!: ChannelLiveStateService;

  /** Público por finalidade (C3/GF9), o mesmo da prévia; por propriedade, pelo mesmo motivo. */
  @Inject(TeamAudienceService)
  private readonly audience!: TeamAudienceService;

  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Queue<TeamWhatsappSendJob>,
  ) {}

  async dispatch(
    actorId: string,
    input: CreateTeamDispatchInput,
  ): Promise<CreateTeamDispatchResponse> {
    const actor = await this.requireSender(actorId);
    const draft =
      input.target.type === 'user'
        ? await this.userDraft(actor, input, input.target.userId)
        : await this.sectorDraft(actor, sectorRequestOf(input, input.target));
    const { record } = draft;
    const created = await this.repo.createDispatch(record);
    const done: CreatedDispatch = {
      actorId: actor.id,
      channelIds: draft.channelIds,
      trail: draft.trail,
      created,
      skipped: skippedOf(record.recipients, seesFullPhone(actor)),
    };
    return record.scheduledFor
      ? this.scheduled(done, record.scheduledFor)
      : this.dispatchNow(done);
  }

  /** Alvo pessoa (GF1): o caminho de hoje, sem finalidade nem foto. */
  private async userDraft(
    actor: TeamActor,
    input: CreateTeamDispatchInput,
    userId: string,
  ): Promise<DispatchDraft> {
    const target = await this.resolveUser(actor, userId);
    const numbers = await this.requireNumbers(target);
    // O DTO só agenda alvo setor (D9); chegando direto, 422 como hoje.
    if (input.when === 'shift_start') throw invalidShift();
    await this.requireOpen(numbers);
    const recipients = await this.classify(target.members, numbers);
    if (!recipients.some((r) => r.status === 'QUEUED')) throw noRecipients();
    const channelIds = recipientChannelIds(recipients);
    const { targetId, targetLabel } = target;
    return {
      record: {
        authorId: actor.id,
        targetType: 'USER',
        targetId,
        targetLabel,
        ...shiftColumns(null),
        sectors: [],
        channelId: singleChannelId(channelIds),
        text: input.text,
        recipients,
      },
      channelIds,
      trail: { targetType: 'USER', targetId },
    };
  }

  /**
   * Alvo setor (GF9): a impressão é conferida antes da seleção (marcado que
   * perdeu a relação dá 409, não 422) e as travas, antes do provedor. Nada é
   * gravado antes do fim.
   */
  private async sectorDraft(
    actor: TeamActor,
    input: AudienceRequest,
  ): Promise<DispatchDraft> {
    const resolved = await this.audience.resolve(actor, input);
    if (resolved.audienceKey !== input.audienceKey) throw audienceChanged();
    if (resolved.unknownSelected.length > 0) throw invalidSelection();
    // Um instante só para prévia e envio (DG8): o "data e hora" chega às travas.
    const scheduledFor = scheduledForOf({
      request: input,
      date: resolved.date,
      shifts: resolved.shifts,
    });
    const found = await this.repo.findSectorChannels(
      resolved.sectors.map((s) => s.id),
    );
    requireNoBlock(
      blocksFor({
        request: input,
        receivingCount: resolved.receiving.length,
        selectedCount: resolved.ruleSnapshot.selectedUserIds?.length ?? null,
        scheduledFor,
        numbersMissing: resolved.sectors.some((s) => !found.get(s.id)),
        now: new Date(),
      }),
    );
    const numbers = requireSectorNumbers(resolved.sectors, found);
    if (!scheduledFor) await this.requireOpen(numbers);
    const pending = scheduledFor ? 'SCHEDULED' : 'QUEUED';
    const recipients = sectorRecipients(resolved, pending, numbers);
    const channelIds = recipientChannelIds(recipients);
    return {
      record: {
        authorId: actor.id,
        ...sectorDispatchFields(resolved, input),
        channelId: singleChannelId(channelIds),
        text: input.text,
        recipients,
        ...(scheduledFor ? { state: 'SCHEDULED' as const, scheduledFor } : {}),
      },
      channelIds,
      trail: {
        targetType: 'SECTOR',
        targetId: resolved.sectors[0].id,
        ...sectorTrail(resolved, input.when),
      },
    };
  }

  /** Agendado (início do turno ou data e hora): nada vai para a fila agora; o disparo é do worker. */
  private async scheduled(
    { actorId, trail, created, skipped }: CreatedDispatch,
    scheduledFor: Date,
  ): Promise<CreateTeamDispatchResponse> {
    const scheduled = created.recipients.filter(
      (r) => r.status === 'SCHEDULED',
    ).length;
    await this.audit.log(
      'team_whatsapp.schedule',
      'TeamWhatsappDispatch',
      created.id,
      {
        actorId,
        dispatchId: created.id,
        // GF12/DG6: finalidade, base, momento e política (valores da API),
        // sem nome, telefone nem texto.
        purpose: trail.purpose,
        base: trail.base,
        when: trail.when,
        policy: trail.policy,
        scheduled,
        skipped: skipped.length,
      },
    );
    return {
      dispatchId: created.id,
      queued: 0,
      scheduled,
      scheduledFor: scheduledFor.toISOString(),
      skipped,
    };
  }

  private async dispatchNow({
    actorId,
    channelIds,
    trail,
    created,
    skipped,
  }: CreatedDispatch): Promise<CreateTeamDispatchResponse> {
    const queuedIds = created.recipients
      .filter((r) => r.status === 'QUEUED')
      .map((r) => r.id);
    await enqueueTeamSend(this.queue, this.repo, queuedIds);
    await this.audit.log(
      'team_whatsapp.dispatch',
      'TeamWhatsappDispatch',
      created.id,
      {
        actorId,
        // Setor: + setores, finalidade, base e política (GF12/DG6); pessoa: como hoje.
        ...trail,
        channelIds,
        queued: queuedIds.length,
        skipped: skipped.length,
      },
    );
    return {
      dispatchId: created.id,
      queued: queuedIds.length,
      scheduled: 0,
      scheduledFor: null,
      skipped,
    };
  }

  /**
   * Alvos permitidos ao remetente: ADMIN vê todos os setores ativos; gestor, os
   * seus. `today`/`inProgress` no fuso de Manaus (GC5).
   */
  async targets(actorId: string): Promise<TeamTargetsResponse> {
    const actor = await this.requireSender(actorId);
    const onlyIds = actor.role === 'ADMIN' ? null : actor.managedSectorIds;
    const [channels, sectors, shifts, levels] = await Promise.all([
      this.repo.listEligibleChannels(),
      this.repo.listSectors(onlyIds),
      this.repo.listActiveShifts(),
      this.levels.listActive(),
    ]);
    const now = new Date();
    return {
      today: todayIn(now),
      inProgress: overnightInProgress(shifts, now),
      shifts,
      channels: eligibleChannels(channels),
      sectors,
      levels,
    };
  }

  /**
   * Escala dos setores na data (C4): cada setor passa pela política antes de
   * ler pessoas (403 no primeiro que falhar, GC6); depois a lista do dia vem
   * numa rodada para todos os setores (`loadDayPeopleMany`), com a regra de hoje
   * (`dayMembers`: uma pessoa em um setor só).
   */
  async roster(
    actorId: string,
    query: TeamRosterQuery,
  ): Promise<TeamRosterResponse> {
    const actor = await this.requireSender(actorId);
    const sectors = await this.requireSectors(actor, query.sectorIds);
    const { date } = query;
    const [shifts, days, channels] = await Promise.all([
      this.repo.listActiveShifts(),
      this.sectorDays(sectors, date),
      this.channelsOf(sectors.map((s) => s.id)),
    ]);
    const viewer = {
      fullPhone: hasPermission(actor, 'telefone.ver_completo'),
    };
    const rows = days.map((d) => ({
      sectorId: d.sectorId,
      name: d.sectorName,
      channel: channels.get(d.sectorId) ?? null,
      members: toRosterMembers(d.members, viewer),
    }));
    return {
      date,
      shiftStarts: shiftStarts(shifts, date),
      sectors: rows.sort(byName),
    };
  }

  /**
   * Por qual número a pessoa recebe hoje (C2): o da área onde ela atua na data.
   * Mesma política do envio a uma pessoa (GC5): 403 fora do alcance, antes de
   * ler a escala ou consultar o provedor. Sem área → `sector` e `channel` null.
   */
  async personRoute(actorId: string, userId: string): Promise<TeamPersonRoute> {
    const actor = await this.requireSender(actorId);
    const user = await this.repo.findTargetUser(userId);
    if (!user || !canSendToUser(actor, user)) throw teamForbidden();
    const sector = await this.daySector(user, todayIn(new Date()));
    const channels = sector ? await this.channelsOf([sector.id]) : null;
    return {
      userId: user.id,
      sector,
      channel: (sector && channels?.get(sector.id)) ?? null,
    };
  }

  /** Área onde a pessoa atua na data (sem política: o POST já a aplicou ao alvo). */
  async personSectorOn(
    userId: string,
    date: CivilDate,
  ): Promise<{ id: string; name: string } | null> {
    const user = await this.repo.findTargetUser(userId);
    return user ? this.daySector(user, date) : null;
  }

  /**
   * Uma página do histórico: ADMIN vê todos; os demais, os próprios (GC5). Os
   * filtros (DG14) entram somados ao autor; sem filtro, a lista de hoje.
   */
  async listDispatches(
    actorId: string,
    query: DispatchListQuery,
  ): Promise<TeamDispatchListResponse> {
    const actor = await this.requireSender(actorId);
    const authorId = actor.role === 'ADMIN' ? null : actor.id;
    const page = { page: query.page, pageSize: query.pageSize };
    const filter = dispatchListFilter(query);
    const { rows, total } = await (filter
      ? this.repo.listDispatches(authorId, page, filter)
      : this.repo.listDispatches(authorId, page));
    const ids = rows.map((r) => r.id);
    const [statuses, channels] = await Promise.all([
      this.repo.countByStatus(ids),
      this.repo.channelsByDispatch(ids),
    ]);
    const counts = countsByDispatch(statuses);
    const channelsOf = channelsByDispatch(channels);
    const full = seesFullPhone(actor);
    return {
      items: rows.map((row) =>
        toListItem(row, counts.get(row.id), channelsOf.get(row.id) ?? [], full),
      ),
      total,
      ...page,
    };
  }

  private async requireSender(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    return actor;
  }

  private async resolveUser(
    actor: TeamActor,
    userId: string,
  ): Promise<ResolvedUser> {
    const user = await this.repo.findTargetUser(userId);
    if (!user || !canSendToUser(actor, user)) throw teamForbidden();
    // D8: sem área na data não há número; recusar é mais claro que gravar um pulado.
    const area = await this.daySector(user, todayIn(new Date()));
    if (!area) throw noSector();
    return {
      targetId: user.id,
      targetLabel: displayName(user),
      numberSectors: [{ sectorId: area.id, sectorName: area.name }],
      // Alvo pessoa: o turno gravado é o do cadastro.
      members: [
        {
          member: user,
          shiftId: user.shiftId,
          shiftName: user.workShift?.name ?? null,
          snapshot: NO_SECTOR_SNAPSHOT,
          routeSectorId: area.id,
        },
      ],
    };
  }

  private async requireSector(
    actor: TeamActor,
    sectorId: string,
  ): Promise<TeamSector> {
    const sector = await this.repo.findSector(sectorId);
    if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
    return sector;
  }

  /** GC6: um setor por vez, na ordem pedida; o primeiro fora do alcance dá 403. */
  private async requireSectors(
    actor: TeamActor,
    sectorIds: readonly string[],
  ): Promise<TeamSector[]> {
    const sectors: TeamSector[] = [];
    for (const id of sectorIds) {
      sectors.push(await this.requireSector(actor, id));
    }
    return sectors;
  }

  /**
   * Área do dia (GC7): a da exceção "Outro setor" (situação WORK), senão a do
   * cadastro. Área inativa vale como sem área, como o gestor já a vê (C2).
   */
  private async daySector(
    user: TeamMember,
    date: CivilDate,
  ): Promise<{ id: string; name: string } | null> {
    const { cycle, exceptions } = await this.repo.loadPersonSchedule(
      user.id,
      date,
    );
    const day = resolveDay(
      {
        id: user.id,
        sectorId: user.sectorId,
        profileShiftId: user.shiftId,
        cycle,
        exceptions,
      },
      date,
    );
    const sectorId =
      (day.kind === 'WORK' ? day.sectorId : null) ?? user.sectorId;
    const sector = sectorId ? await this.repo.findSector(sectorId) : null;
    return sector?.isActive ? { id: sector.id, name: sector.name } : null;
  }

  /**
   * Número e estado ao vivo de cada área (C2): um canal por id na porta (D7),
   * só os envolvidos na prévia. Sem número, nenhuma consulta ao provedor.
   */
  private async channelsOf(
    sectorIds: readonly string[],
  ): Promise<Map<string, TeamSectorChannel | null>> {
    const rows = await this.repo.findSectorChannels(sectorIds);
    const involved = distinctLiveChannels(rows.values());
    const checks = involved.length
      ? await this.live.checkMany(involved)
      : new Map();
    return previewChannels(rows, checks, new Date());
  }

  /** Escala de cada setor na data, numa rodada de consultas (regra de hoje: uma pessoa em um setor só). */
  private async sectorDays(
    sectors: readonly TeamSector[],
    date: CivilDate,
  ): Promise<SectorDay[]> {
    const people = await this.repo.loadDayPeopleMany(
      sectors.map((s) => s.id),
      date,
    );
    return sectors.map((s) => ({
      sectorId: s.id,
      sectorName: s.name,
      members: dayMembers({
        sectorId: s.id,
        date,
        people: people.get(s.id) ?? [],
      }),
    }));
  }

  /**
   * Número de cada área do envio (D2): qualquer área sem número trava o envio
   * inteiro (422, GC7). Só banco; o provedor só entra em `requireOpen`.
   */
  private async requireNumbers(
    target: ResolvedUser,
  ): Promise<Map<string, TeamSectorChannelRow>> {
    const sectors = target.numberSectors.map((s) => ({
      id: s.sectorId,
      name: s.sectorName,
    }));
    const found = await this.repo.findSectorChannels(sectors.map((s) => s.id));
    return requireSectorNumbers(sectors, found);
  }

  /**
   * Envio imediato (D7): só sai se a porta disse `open` para cada número
   * envolvido (409 caso contrário). Um canal por id, só os dos setores do envio.
   */
  private async requireOpen(
    numbers: ReadonlyMap<string, TeamSectorChannelRow>,
  ): Promise<void> {
    const involved = distinctLiveChannels(numbers.values());
    const checks = await this.live.checkMany(involved);
    requireOpenNumbers(involved, checks, new Date());
  }

  /**
   * Alvo pessoa: o contato carrega a grafia que o merge elegeu como a que
   * entrega. Sem telefone, suprimido ou sem autorização de contato → SKIPPED;
   * o resto fica QUEUED. O telefone do envio fica gravado (DG7); sem política.
   */
  private async classify(
    targets: readonly TargetMember[],
    numbers: ReadonlyMap<string, TeamSectorChannelRow>,
  ): Promise<NewTeamDispatchRecipient[]> {
    const recipients: NewTeamDispatchRecipient[] = [];
    for (const target of targets) {
      const { member: m, shiftId, shiftName, snapshot } = target;
      const base = {
        userId: m.id,
        userName: displayName(m),
        shiftId,
        shiftName,
        ...snapshot,
        ...recipientChannel(numbers.get(target.routeSectorId)),
        phoneE164: sendPhoneOf(m),
      };
      const skipReason = await this.skipReasonOf(m);
      recipients.push(
        skipReason
          ? { ...base, status: 'SKIPPED', skipReason }
          : { ...base, status: 'QUEUED', skipReason: null },
      );
    }
    return recipients;
  }

  /** Ordem C8 (`phoneSkipReason`, a mesma do público por finalidade, DF3). */
  private skipReasonOf(m: TeamMember): Promise<PhoneSkipReason | null> {
    return phoneSkipReason(m, this.consent);
  }
}

/**
 * Sem fila não há envio: quem ficou QUEUED vira FAILED e o erro sobe (500 no
 * POST). Um job por destinatário, jobId = recipientId. Usado pelo envio imediato
 * e pelo disparo agendado (T9).
 */
export async function enqueueTeamSend(
  queue: Queue<TeamWhatsappSendJob>,
  repo: Pick<TeamWhatsappRepository, 'markFailed'>,
  recipientIds: readonly string[],
): Promise<void> {
  try {
    await queue.addBulk(
      recipientIds.map((id) => ({
        name: 'send',
        data: { recipientId: id },
        opts: { jobId: id },
      })),
    );
  } catch (err) {
    await repo.markFailed(recipientIds, QUEUE_UNAVAILABLE);
    throw err;
  }
}

/**
 * jobId de um envio do destinatário: o próprio id na primeira vez e
 * `<id>-r<n>` na n-ésima repetição (D12). O BullMQ 5 ignora `add` com o id de um
 * job retido (`removeOnFail` 24 h) e recusa `:` em jobId, então a repetição
 * precisa de um id novo e sem `:`.
 */
export function teamSendJobId(
  recipientId: string,
  manualRetries: number,
): string {
  return manualRetries === 0 ? recipientId : `${recipientId}-r${manualRetries}`;
}

/**
 * Fila das repetições (T12): como o `enqueueTeamSend`, mas com o jobId novo de
 * cada repetição. Sem fila não há reenvio: as linhas que a troca acabou de pôr
 * em QUEUED voltam a FAILED (`queue_unavailable`, repetível) e o erro sobe.
 */
export async function enqueueTeamRetry(
  queue: Queue<TeamWhatsappSendJob>,
  repo: Pick<TeamWhatsappRepository, 'markFailed'>,
  refs: readonly { id: string; manualRetries: number }[],
): Promise<void> {
  try {
    await queue.addBulk(
      refs.map(({ id, manualRetries }) => ({
        name: 'send',
        data: { recipientId: id },
        opts: { jobId: teamSendJobId(id, manualRetries) },
      })),
    );
  } catch (err) {
    await repo.markFailed(
      refs.map((ref) => ref.id),
      QUEUE_UNAVAILABLE,
    );
    throw err;
  }
}

type ChannelRow = Awaited<
  ReturnType<TeamWhatsappRepository['listEligibleChannels']>
>[number];

/** Só provedores de equipe (defesa além do filtro do repositório), com o último estado. */
function eligibleChannels(
  rows: readonly ChannelRow[],
): TeamTargetsResponse['channels'] {
  return rows.flatMap(({ provider, connectionEvents, ...rest }) =>
    isTeamProvider(provider)
      ? [
          {
            ...rest,
            provider,
            connectionState: toConnectionState(connectionEvents[0]?.state),
          },
        ]
      : [],
  );
}

function isSkipped<R extends NewTeamRecipient>(
  r: R,
): r is R & { skipReason: NonNullable<NewTeamRecipient['skipReason']> } {
  return r.status === 'SKIPPED' && r.skipReason !== null;
}

function toSkipped(
  r: NewTeamRecipient & { skipReason: SkippedRecipient['reason'] },
  full: boolean,
) {
  return {
    userId: r.userId,
    name: nameView(r.userName, { full }),
    reason: r.skipReason,
  };
}

/** `skipped` da resposta do POST; o gravado (`userName`) segue com o nome real. */
function skippedOf(
  recipients: readonly NewTeamRecipient[],
  full: boolean,
): SkippedRecipient[] {
  return sortByViewedName(
    recipients.filter(isSkipped).map((r) => toSkipped(r, full)),
    full,
    (s) => ({ group: 0, name: s.name, id: s.userId ?? '' }),
  );
}

/** Estado fora do enum (ex.: `qrcode`) ou ausente vira null: o front não adivinha. */
function toConnectionState(
  state: string | undefined,
): TeamTargetsResponse['channels'][number]['connectionState'] {
  const parsed = teamConnectionStateSchema.safeParse(state);
  return parsed.success ? parsed.data : null;
}

/** Snapshot gravado no envio; incompleto (todos os turnos, alvo pessoa) → null. */
export function shiftSnapshotOf(
  row: Pick<
    TeamDispatchRow,
    'shiftId' | 'shiftName' | 'shiftStartTime' | 'shiftEndTime'
  >,
): TeamShiftSnapshot | null {
  const { shiftId, shiftName, shiftStartTime, shiftEndTime } = row;
  if (!shiftId || !shiftName || !shiftStartTime || !shiftEndTime) return null;
  return {
    id: shiftId,
    name: shiftName,
    startTime: shiftStartTime,
    endTime: shiftEndTime,
  };
}

/** Setores do envio por nome (pt-BR); [] no alvo pessoa. */
function sectorsOf(row: TeamDispatchRow) {
  return row.sectors
    .map((s) => ({ id: s.sectorId, name: s.sectorName }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function toListItem(
  row: TeamDispatchRow,
  counts: TeamDispatchCounts | undefined,
  channels: TeamDispatchChannels,
  full: boolean,
): TeamDispatchListResponse['items'][number] {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    author: authorView(row.author, full),
    target: {
      type: row.targetType === 'USER' ? 'user' : 'sector',
      id: row.targetId,
      label: nameView(row.targetLabel, { full }),
      shift: shiftSnapshotOf(row),
    },
    sectors: sectorsOf(row),
    channels,
    counts: counts ?? zeroCounts(),
    rosterDate: row.rosterDate ? fromDbDate(row.rosterDate) : null,
    state: row.state,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    firedAt: row.firedAt?.toISOString() ?? null,
    // CF3: finalidade, base e atividade; envio antigo → as quatro nulas.
    ...purposeView(row),
  };
}
