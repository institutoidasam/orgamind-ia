import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { ConflictError, DomainError } from '../../shared/errors/domain.error';
import { ChatService, type TeamSendResult } from '../chat/chat.service';
import { ConsentService } from '../consent/consent.service';
import {
  acquirePacingLock,
  releasePacingLock,
} from '../campaigns/pacing.helper';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import { ChannelLiveStateService } from '../whatsapp-providers/channel-live-state.service';
import { isTeamProvider } from './team-whatsapp.policy';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { INDETERMINATE_CODE, failureStatus } from './team-whatsapp.outcome';

const CHANNEL_DISCONNECTED = 'team_whatsapp.channel_disconnected';
const CHANNEL_UNVERIFIED = 'team_whatsapp.channel_unverified';

const channelSelect = {
  id: true,
  provider: true,
  isActive: true,
  evolutionInstanceName: true,
} satisfies Prisma.ChannelSelect;

const recipientSelect = {
  id: true,
  status: true,
  messageId: true,
  user: {
    select: {
      phoneE164: true,
      contact: { select: { id: true, phoneE164: true } },
    },
  },
  // D3: o número do envio é o do destinatário; o do envio é só a reserva da linha legada.
  channel: { select: channelSelect },
  dispatch: {
    select: {
      id: true,
      authorId: true,
      text: true,
      channel: { select: channelSelect },
    },
  },
} satisfies Prisma.TeamWhatsappRecipientSelect;

type LoadedRecipient = Prisma.TeamWhatsappRecipientGetPayload<{
  select: typeof recipientSelect;
}>;
type SendChannel = NonNullable<LoadedRecipient['channel']>;
type Ready = { phone: string; channel: SendChannel };

/** Transição terminal do destinatário (gravada só se ele ainda está QUEUED). */
type FailedData = {
  status: 'FAILED' | 'UNCERTAIN';
  errorCode: string;
  messageId?: string;
};
type FinishData =
  | { status: 'SENT'; messageId?: string; acceptedAt: Date }
  | FailedData
  | { status: 'SKIPPED'; skipReason: 'NO_PHONE' | 'SUPPRESSED' };

/** Telefone de envio: o do contato vinculado, senão o do usuário (spec §1). */
function sendPhoneOf(user: LoadedRecipient['user']): string | null {
  return user?.contact?.phoneE164 ?? user?.phoneE164 ?? null;
}

const INDETERMINATE: FinishData = {
  status: 'UNCERTAIN',
  errorCode: INDETERMINATE_CODE,
};
const DELIVERED_STATUSES = new Set(['SENT', 'DELIVERED', 'READ']);

/** Mesma chave do pacing.helper (lockKey não é exportado; a campanha também a escreve). */
const pacingLockKey = (instanceId: string) => `pacing:send:lock:${instanceId}`;

/** Erro que este processor relança com mensagem só de código (seguro para o Redis). */
class TeamSendJobError extends Error {
  override name = 'TeamSendJobError';
}

/**
 * O erro que sobe ao BullMQ: failedReason e stacktrace ficam 24 h no Redis
 * (removeOnFail), então nada de mensagem de terceiros — um
 * PrismaClientValidationError, por exemplo, traz os args (texto, telefone).
 * DelayedError, erros de domínio e os já sanitizados daqui sobem intactos.
 */
function forQueue(err: unknown): unknown {
  if (
    err instanceof DelayedError ||
    err instanceof DomainError ||
    err instanceof TeamSendJobError
  )
    return err;
  const name =
    err instanceof Error && /^\w{1,64}$/.test(err.name) ? err.name : 'unknown';
  return new TeamSendJobError(`team_whatsapp.unexpected:${name}`);
}

/**
 * Um job por destinatário do recado da equipe (jobId = recipientId, attempts 3).
 *
 * Idempotência (Risco 5): a Message é criada UMA vez (fase 1) e o id vai para o
 * destinatário ANTES do provedor; a retentativa lê o status dessa Message e só
 * reenvia quando ele prova que nada saiu (QUEUED, ou FAILED redispatchável).
 * Logs levam só recipientId/dispatchId/errorCode — nunca texto ou telefone.
 *
 * Registrado SÓ no WorkerModule (um @Processor duplicado derruba o worker).
 */
@Processor(QUEUE_NAMES.TEAM_WHATSAPP_SEND, { concurrency: 2 })
export class TeamWhatsappSendProcessor extends WorkerHost {
  private readonly logger = new Logger(TeamWhatsappSendProcessor.name);

  // Injetados por propriedade: o construtor já tem 4 dependências, o limite de
  // parâmetros do GC2. Resolvidos pelo Nest antes do primeiro job.
  @Inject(TeamWhatsappRepository)
  private readonly repo!: TeamWhatsappRepository;
  @Inject(ChannelLiveStateService)
  private readonly liveState!: ChannelLiveStateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly consent: ConsentService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<TeamWhatsappSendJob>, token?: string): Promise<void> {
    const id = job.data.recipientId;
    try {
      await this.deliver(job, token, id);
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      if (this.isLastAttempt(job)) {
        // Nenhuma exceção deixa o destinatário QUEUED para sempre (contagem e polling),
        // mas também não rebaixa para FAILED um envio que a Message já prova feito.
        const data = await this.lastAttemptData(id, err);
        await this.finish(id, data).catch(() => undefined);
        this.logger.warn(
          {
            recipientId: id,
            status: data.status,
            errorCode: 'errorCode' in data ? data.errorCode : null,
          },
          'team whatsapp job failed on last attempt',
        );
      }
      throw forQueue(err);
    }
  }

  private async deliver(
    job: Job<TeamWhatsappSendJob>,
    token: string | undefined,
    id: string,
  ): Promise<void> {
    const r = await this.load(id);
    if (r?.status !== 'QUEUED') return;
    // O desfecho de uma Message já gravada vem ANTES das pré-checagens: um envio
    // que saiu continua SENT mesmo que o telefone tenha ido para a supressão depois.
    const prior = r.messageId ? await this.priorOutcome(r.messageId) : null;
    if (prior) return this.finish(r.id, prior);
    const pre = await this.precheck(r);
    if ('data' in pre) return this.finish(r.id, pre.data);
    await this.sendPaced(job, token, r, pre);
  }

  private async sendPaced(
    job: Job<TeamWhatsappSendJob>,
    token: string | undefined,
    r: LoadedRecipient,
    ready: Ready,
  ): Promise<void> {
    const paced = isSessionProvider(ready.channel.provider);
    // Antes da fase 1: adiar o job não deixa Message QUEUED para trás.
    if (paced) await this.waitPacing(job, token, ready.channel.id);
    let sent = false;
    try {
      // Depois do pacing e antes de qualquer Message: só `open` segue (D7).
      const blocked = await this.liveBlock(job, ready.channel);
      if (blocked) return await this.finishFailed(r, blocked);
      const messageId = r.messageId ?? (await this.prepare(r, ready));
      // D6: a tentativa é a chamada ao provedor, contada imediatamente antes dela.
      await this.repo.countAttempt(r.id);
      const res = await this.chat.sendTeamMessage({
        messageId,
        text: r.dispatch.text,
      });
      sent = res.sent;
      await this.settle(job, r, res);
    } finally {
      if (paced) await this.releasePacing(ready.channel.id, sent);
    }
  }

  /**
   * Só um envio que saiu segura o canal pelo atraso anti-ban; na falha o lock
   * sai na hora, para a retentativa ou o próximo recado não esperar 10–45 s à
   * toa (mesmo contrato da campanha, send-message.processor).
   */
  private async releasePacing(
    instanceId: string,
    sent: boolean,
  ): Promise<void> {
    if (sent) return releasePacingLock(this.redis, instanceId, this.logger);
    await this.redis.del(pacingLockKey(instanceId)).catch(() => undefined);
  }

  /**
   * Conferência do número no provedor (D7). `open` → `null`; `close`/`connecting`
   * → FAILED repetível; `unknown` → a fila reconfere e, na última tentativa,
   * FAILED repetível. Em todos os casos nada saiu e nenhuma tentativa é contada.
   */
  private async liveBlock(
    job: Job<TeamWhatsappSendJob>,
    channel: SendChannel,
  ): Promise<FailedData | null> {
    const { state } = await this.liveState.check(channel);
    if (state === 'open') return null;
    if (state !== 'unknown')
      return { status: 'FAILED', errorCode: CHANNEL_DISCONNECTED };
    if (!this.isLastAttempt(job))
      throw new TeamSendJobError(CHANNEL_UNVERIFIED);
    return { status: 'FAILED', errorCode: CHANNEL_UNVERIFIED };
  }

  private async finishFailed(
    r: LoadedRecipient,
    data: FailedData,
  ): Promise<void> {
    await this.finish(r.id, data);
    this.logger.warn(
      {
        recipientId: r.id,
        dispatchId: r.dispatch.id,
        errorCode: data.errorCode,
      },
      'team whatsapp send failed',
    );
  }

  private load(id: string): Promise<LoadedRecipient | null> {
    return this.prisma.teamWhatsappRecipient.findUnique({
      where: { id },
      select: recipientSelect,
    });
  }

  /** Supressão e telefone (spec §2, passo 1) e canal ainda válido para o envio. */
  private async precheck(
    r: LoadedRecipient,
  ): Promise<{ data: FinishData } | Ready> {
    const phone = sendPhoneOf(r.user);
    if (!phone) return { data: { status: 'SKIPPED', skipReason: 'NO_PHONE' } };
    if (await this.consent.isSuppressed(phone))
      return { data: { status: 'SKIPPED', skipReason: 'SUPPRESSED' } };
    const channel = r.channel ?? r.dispatch.channel;
    if (!channel?.isActive || !isTeamProvider(channel.provider)) {
      return {
        data: { status: 'FAILED', errorCode: 'team_whatsapp.channel_invalid' },
      };
    }
    return { phone, channel };
  }

  /** Fase 1: cria a Message QUEUED e grava o id no destinatário ANTES do provedor. */
  private async prepare(r: LoadedRecipient, ready: Ready): Promise<string> {
    const { messageId, contactId } = await this.chat.prepareTeamMessage({
      instanceId: ready.channel.id,
      contactId: r.user?.contact?.id ?? null,
      phoneE164: ready.phone,
      text: r.dispatch.text,
      authorUserId: r.dispatch.authorId,
    });
    const { count } = await this.prisma.teamWhatsappRecipient.updateMany({
      where: { id: r.id, status: 'QUEUED', messageId: null },
      data: { messageId, contactId },
    });
    // count 0 = outra execução já gravou a SUA Message (ou fechou o destinatário):
    // enviar esta duplicaria. A Message recém-criada fica QUEUED, sem envio.
    if (count === 0)
      throw new ConflictError(
        'Team recipient already prepared',
        'team_whatsapp.not_claimed',
      );
    return messageId;
  }

  /**
   * O que a Message já gravada diz sobre a tentativa anterior. `null` = pode
   * (re)enviar a mesma linha; senão, a transição terminal do destinatário.
   */
  private async priorOutcome(messageId: string): Promise<FinishData | null> {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, errorCode: true, sentAt: true },
    });
    if (!msg)
      return { status: 'FAILED', errorCode: 'team_whatsapp.message_missing' };
    if (msg.status === 'QUEUED') return null;
    if (msg.status === 'FAILED')
      return this.chat.isRedispatchableFailure(msg.errorCode)
        ? null
        : INDETERMINATE;
    if (DELIVERED_STATUSES.has(msg.status))
      return { status: 'SENT', acceptedAt: msg.sentAt ?? new Date() };
    // SENDING = pode ter saído; CANCELLED/WAITING_INSTANCE/RECEIVED/SKIPPED_* não são deste fluxo.
    return INDETERMINATE;
  }

  /** Best-effort: se a própria consulta falhar, grava o FAILED padrão. */
  private async lastAttemptData(id: string, err: unknown): Promise<FinishData> {
    const fallback: FinishData = {
      status: 'FAILED',
      errorCode:
        err instanceof DomainError ? err.code : 'team_whatsapp.send_failed',
    };
    try {
      const row = await this.prisma.teamWhatsappRecipient.findUnique({
        where: { id },
        select: { messageId: true },
      });
      const prior = row?.messageId
        ? await this.priorOutcome(row.messageId)
        : null;
      return prior ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async settle(
    job: Job<TeamWhatsappSendJob>,
    r: LoadedRecipient,
    res: TeamSendResult,
  ): Promise<void> {
    if (res.sent)
      return this.finish(r.id, {
        status: 'SENT',
        messageId: res.messageId,
        acceptedAt: new Date(),
      });
    if (res.retryable && !this.isLastAttempt(job)) {
      // Relança para a fila retentar: a Message ficou FAILED com código redispatchável.
      throw new TeamSendJobError(
        `team_whatsapp.retry:${res.errorCode ?? 'unknown'}`,
      );
    }
    const errorCode = res.errorCode ?? 'team_whatsapp.send_failed';
    await this.finishFailed(r, {
      status: failureStatus(errorCode, (c) =>
        this.chat.isRedispatchableFailure(c),
      ),
      errorCode,
      messageId: res.messageId,
    });
  }

  private async waitPacing(
    job: Job<TeamWhatsappSendJob>,
    token: string | undefined,
    instanceId: string,
  ): Promise<void> {
    const lock = await acquirePacingLock(this.redis, instanceId);
    if (lock.acquired) return;
    // Contrato do BullMQ: moveToDelayed com o token do worker e DelayedError em seguida.
    await job.moveToDelayed(Date.now() + lock.retryDelayMs, token);
    throw new DelayedError();
  }

  /**
   * Transição condicional (só sai de QUEUED): reexecução nunca sobrescreve um
   * desfecho, e um recibo (DELIVERED/READ) ou a resposta que chegou pelo webhook
   * antes deste SENT não é rebaixado: a linha já não casa com `status: QUEUED`,
   * e o `acceptedAt` do SENT vai no mesmo `updateMany`, então não o sobrescreve.
   */
  private async finish(id: string, data: FinishData): Promise<void> {
    await this.prisma.teamWhatsappRecipient.updateMany({
      where: { id, status: 'QUEUED' },
      data,
    });
  }

  /** Dentro do process, attemptsMade conta as tentativas JÁ falhas (0 na 1ª). */
  private isLastAttempt(job: Job<TeamWhatsappSendJob>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  }
}
