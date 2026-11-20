import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AuditService } from '../../shared/audit/audit.service';
import { ChatService } from '../chat/chat.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import {
  stuckOutcome,
  type StuckCandidate,
  type StuckOutcome,
} from './stuck-recipients';
import { TeamStuckRecipientsRepository } from './team-stuck-recipients.repository';
import { teamSendJobId } from './team-whatsapp.service';

export type StuckCounts = {
  queueLost: number;
  missing: number;
  sent: number;
  failed: number;
  uncertain: number;
};

/**
 * `checked` = candidatos lidos; `alive` = job vivo (não tocado); `lost` = job
 * perdido (tentou a troca); `counts` = trocas feitas, por desfecho. Quem deu
 * erro na consulta do job não entra em `alive` nem em `lost`.
 */
export type StuckCycle = {
  checked: number;
  alive: number;
  lost: number;
  counts: StuckCounts;
};

type JobVerdict = 'alive' | 'lost' | 'unchecked';
type StuckKind = StuckOutcome['kind'];

/**
 * Estados FINAIS do job (DH5). Lista de perda, nunca de vida: qualquer outro
 * valor de `getState` (inclusive um que uma versão futura do BullMQ acrescente)
 * conta como vivo, para um estado novo nunca virar perda.
 */
const LOST_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'unknown',
]);

function emptyCounts(): StuckCounts {
  return { queueLost: 0, missing: 0, sent: 0, failed: 0, uncertain: 0 };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Verificador de destinatários presos (spec H2, CH4). A cada ciclo lê os
 * `QUEUED` parados há mais de 30 min e, UM POR VEZ, consulta o job dele no
 * BullMQ logo antes da troca: o banco não impede que um processor vivo pegue a
 * Message `FAILED queue_lost` depois da troca (o chat aceita `QUEUED|FAILED`),
 * então a única proteção é só trocar quem tem o job comprovadamente perdido.
 * Nunca enfileira (GH2): da fila de envio só usa `getJob`. Trilhas e logs só
 * com ids e contagens (GH3).
 */
@Injectable()
export class TeamStuckReconcilerService {
  private readonly logger = new Logger(TeamStuckReconcilerService.name);

  constructor(
    private readonly repo: TeamStuckRecipientsRepository,
    private readonly chat: ChatService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Pick<Queue<TeamWhatsappSendJob>, 'getJob'>,
  ) {}

  async reconcile(now: Date): Promise<StuckCycle> {
    const candidates = await this.repo.findCandidates(now);
    const cycle: StuckCycle = {
      checked: candidates.length,
      alive: 0,
      lost: 0,
      counts: emptyCounts(),
    };
    const byDispatch = new Map<string, StuckCounts>();
    for (const candidate of candidates) {
      // A consulta do job fica colada à troca do MESMO candidato: nunca
      // "consulta todos e troca depois" (um job pode nascer ou andar no meio).
      const verdict = await this.jobVerdict(candidate);
      if (verdict === 'alive') cycle.alive++;
      if (verdict !== 'lost') continue;
      cycle.lost++;
      const kind = await this.settleLost(candidate, now);
      if (kind === null) continue;
      cycle.counts[kind]++;
      const counts = byDispatch.get(candidate.dispatchId) ?? emptyCounts();
      counts[kind]++;
      byDispatch.set(candidate.dispatchId, counts);
    }
    await this.writeTrails(byDispatch);
    this.logger.log(cycle, 'Team WhatsApp stuck-recipient cycle');
    return cycle;
  }

  /** DH5: sem job, ou job em estado final → perdido; erro na consulta → não toca. */
  private async jobVerdict(candidate: StuckCandidate): Promise<JobVerdict> {
    try {
      const job = await this.queue.getJob(
        teamSendJobId(candidate.id, candidate.manualRetries),
      );
      if (!job) return 'lost';
      return LOST_STATES.has(await job.getState()) ? 'lost' : 'alive';
    } catch (err: unknown) {
      this.logger.warn(
        { recipientId: candidate.id, error: errorName(err) },
        'Team WhatsApp stuck check: job lookup failed',
      );
      return 'unchecked';
    }
  }

  /** Classifica pela Message e troca; `null` = outro caminho venceu ou erro de banco. */
  private async settleLost(
    candidate: StuckCandidate,
    now: Date,
  ): Promise<StuckKind | null> {
    try {
      const message =
        candidate.messageId === null
          ? null
          : await this.repo.loadMessage(candidate.messageId);
      const outcome = stuckOutcome({
        messageId: candidate.messageId,
        message,
        now,
        redispatchable: (code) => this.chat.isRedispatchableFailure(code),
      });
      const settled = await this.repo.settle(candidate, outcome, now);
      return settled ? outcome.kind : null;
    } catch {
      // Sem o erro: a mensagem dele pode trazer dado da linha (GH3).
      this.logger.error(
        { recipientId: candidate.id },
        'Team WhatsApp stuck settle failed',
      );
      return null;
    }
  }

  /** DH8: uma trilha por envio com alguma troca, só com o id e as contagens. */
  private async writeTrails(
    byDispatch: ReadonlyMap<string, StuckCounts>,
  ): Promise<void> {
    for (const [dispatchId, counts] of byDispatch) {
      await this.audit.log(
        'team_whatsapp.stuck_reconciled',
        'TeamWhatsappDispatch',
        dispatchId,
        { dispatchId, ...counts },
      );
    }
  }
}
