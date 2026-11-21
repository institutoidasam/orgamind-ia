import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { z } from 'zod';
import type { teamReminderResponseSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import { ChannelLiveStateService } from '../whatsapp-providers/channel-live-state.service';
import { phoneSkipReason, sendPhoneOf } from './recipient-skip';
import { requireViewable } from './team-alert-access';
import {
  chooseReminderPeople,
  loadPhoneOwners,
  writeReminder,
  type PhoneOwner,
  type ReminderDraft,
} from './team-alert-reminder.repository';
import { requireUrgencyKey } from './team-alert.policy';
import {
  loadAlertHeader,
  loadAlertPeople,
  type AlertPersonRow,
} from './team-alert.repository';
import { requireAreaOf } from './team-dispatch-area';
import {
  distinctLiveChannels,
  recipientChannel,
  requireOpenNumbers,
  requireSectorNumbers,
} from './team-whatsapp.channels';
import { noRecipients, teamForbidden } from './team-whatsapp.errors';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';
import {
  TeamWhatsappRepository,
  type TeamSectorChannelRow,
} from './team-whatsapp.repository';
import { enqueueTeamSend } from './team-whatsapp.service';

export type TeamReminderResponse = z.infer<typeof teamReminderResponseSchema>;

type Numbers = ReadonlyMap<string, TeamSectorChannelRow>;

/**
 * Lembrete aos pendentes do alerta (I7, CI7, DI10). Recusas, nesta ordem
 * (GI4): 403 chave → 404 alerta invisível → 403 remetente e área (as do
 * "Repetir") → 422 `not_an_alert` → 422 `reminder_empty` → 409
 * `reminder_limit` → 409 `reminder_too_soon` → 422/409 número e canal (regras
 * do envio "agora") → gravação. Banco e provedor só depois da autorização; o
 * provedor nunca dentro da transação. A trilha leva só ids e contagens.
 */
@Injectable()
export class TeamAlertReminderService {
  /** Estado ao vivo do número (D7); por propriedade: o construtor já tem 4 dependências (GC2). */
  @Inject(ChannelLiveStateService)
  private readonly live!: ChannelLiveStateService;

  /** Supressão do telefone (C8), a mesma do envio "agora"; por propriedade, pelo mesmo motivo. */
  @Inject(ConsentService)
  private readonly consent!: ConsentService;

  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Queue<TeamWhatsappSendJob>,
  ) {}

  async send(
    actorId: string,
    alertId: string,
    input: { recipientIds: string[] },
    now: Date,
  ): Promise<TeamReminderResponse> {
    const actor = await this.requireReminderActor(actorId, alertId);
    const drafts = await this.draftsFor(alertId, input.recipientIds, now);
    const written = await writeReminder(this.prisma, {
      alertId,
      authorId: actor.id,
      now,
      drafts,
    });
    const { reminderId, recipients } = written;
    const queuedIds = recipients
      .filter((r) => r.status === 'QUEUED')
      .map((r) => r.id);
    // Falha de fila = regra de hoje: QUEUED → FAILED e 500; o lembrete fica consumido.
    await enqueueTeamSend(this.queue, this.repo, queuedIds);
    await this.audit.log(
      'team_whatsapp.reminder',
      'TeamWhatsappDispatch',
      reminderId,
      {
        actorId: actor.id,
        alertId,
        reminderId,
        queued: queuedIds.length,
        skipped: recipients.length - queuedIds.length,
      },
    );
    return { reminderId, queued: queuedIds.length };
  }

  /** 403 sem ator → 403 chave (antes de ler o alerta) → 404 → 403 remetente → 403 área. */
  private async requireReminderActor(
    actorId: string,
    alertId: string,
  ): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor) throw teamForbidden();
    requireUrgencyKey(actor);
    const dispatch = await requireViewable(this.repo, actor, alertId);
    if (!isTeamSender(actor)) throw teamForbidden();
    await requireAreaOf(this.repo, actor, dispatch);
    return actor;
  }

  /**
   * Pré-checagem fora da transação: cabeçalho (422 `not_an_alert`), pessoas e
   * as três recusas, telefone atual, número das áreas (422) e conferência ao
   * vivo (409). Ninguém ficando na fila → 422 `no_recipients`, como no envio
   * "agora". Nada é gravado aqui.
   */
  private async draftsFor(
    alertId: string,
    recipientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, ReminderDraft>> {
    const header = await loadAlertHeader(this.prisma, alertId);
    const people = await loadAlertPeople(this.prisma, alertId);
    const chosen = chooseReminderPeople(
      header,
      people,
      new Set(recipientIds),
      now,
    );
    const owners = await loadPhoneOwners(
      this.prisma,
      chosen.flatMap((p) => p.userId ?? []),
    );
    const numbers = await this.requireNumbers(chosen);
    const drafts = new Map<string, ReminderDraft>();
    for (const person of chosen) {
      const owner = person.userId ? owners.get(person.userId) : undefined;
      drafts.set(person.id, await this.draftOf(person, owner, numbers));
    }
    if (![...drafts.values()].some((d) => d.status === 'QUEUED')) {
      throw noRecipients();
    }
    await this.requireOpen(numbers, now);
    return drafts;
  }

  /**
   * O destinatário do lembrete: o snapshot do alerta, o número de agora da
   * área da pessoa e o telefone atual dela, pulado pela ordem C8
   * (`phoneSkipReason`); sem usuário, `NO_PHONE`.
   */
  private async draftOf(
    person: AlertPersonRow,
    owner: PhoneOwner | undefined,
    numbers: Numbers,
  ): Promise<ReminderDraft> {
    const skipReason = owner
      ? await phoneSkipReason(owner, this.consent)
      : 'NO_PHONE';
    return {
      parentRecipientId: person.id,
      userId: person.userId,
      userName: person.userName,
      shiftId: person.shiftId,
      shiftName: person.shiftName,
      sectorId: person.sectorId,
      sectorName: person.sectorName,
      levelName: person.levelName,
      ...recipientChannel(
        person.sectorId ? numbers.get(person.sectorId) : undefined,
      ),
      phoneE164: owner ? sendPhoneOf(owner) : null,
      status: skipReason ? 'SKIPPED' : 'QUEUED',
      skipReason,
    };
  }

  /** Número de cada área das pessoas escolhidas (D2): área sem número → 422, antes do provedor. */
  private async requireNumbers(
    chosen: readonly AlertPersonRow[],
  ): Promise<Map<string, TeamSectorChannelRow>> {
    const sectors = new Map<string, string>();
    for (const { sectorId, sectorName } of chosen) {
      if (sectorId) sectors.set(sectorId, sectorName ?? '');
    }
    const found = await this.repo.findSectorChannels([...sectors.keys()]);
    return requireSectorNumbers(
      [...sectors].map(([id, name]) => ({ id, name })),
      found,
    );
  }

  /** Envio imediato (D7): só sai se a porta disse `open` para cada número (409 caso contrário). */
  private async requireOpen(numbers: Numbers, now: Date): Promise<void> {
    const involved = distinctLiveChannels(numbers.values());
    const checks = await this.live.checkMany(involved);
    requireOpenNumbers(involved, checks, now);
  }
}
