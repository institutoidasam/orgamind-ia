import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';
import {
  QUEUE_NAMES,
  type ZernioBroadcastDispatchJob,
  type ZernioBroadcastPollJob,
  type ZernioBroadcastCancelJob,
} from '../queue/queue.constants';
import { ZernioBroadcastSendService } from './zernio-broadcast-send.service';
import { ZernioBroadcastPollService } from './zernio-broadcast-poll.service';

/**
 * ZB — o worker que transforma um lote da campanha num BROADCAST do Zernio.
 *
 * `concurrency: 1` NÃO é preguiça: dois broadcasts montados em paralelo brigariam
 * pelo balde de 60 req/min (que o envio 1-a-1 e os syncs também usam) e, pior,
 * competiriam pelo mesmo teto de tier — cada um lendo a janela rolante ANTES de o
 * outro escrever nela. Serializar é o que torna a contagem do tier confiável.
 *
 * A regra do gate, do claim e do tier está no SERVIÇO, não aqui: este processor é
 * casca. É lá que se lê o que protege as 13.400 pessoas.
 */
@Processor(QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH, { concurrency: 1 })
export class ZernioBroadcastDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioBroadcastDispatchProcessor.name);

  constructor(private readonly svc: ZernioBroadcastSendService) {
    super();
  }

  async process(job: Job<ZernioBroadcastDispatchJob>): Promise<void> {
    const res = await this.svc.dispatchBatch(job.data);

    // ★ ENTREGA INDETERMINADA — o `POST /send` não respondeu.
    //
    // O serviço NÃO relança nesse caso (relançar convidaria a retentativa a
    // remontar o lote e a duplicar a entrega), então o `@OnWorkerEvent('failed')`
    // abaixo nunca roda: este é o ÚNICO ponto em que alguém fica sabendo que N
    // mensagens de campanha eleitoral estão num estado que ninguém consegue
    // afirmar. Sem ele, o silêncio seria absoluto.
    if (res.indeterminate && res.indeterminate > 0) {
      const err = new Error(
        `Broadcast do Zernio com ENTREGA INDETERMINADA: o POST /send não respondeu para ` +
          `${res.indeterminate} mensagens da campanha ${job.data.campaignId}. ` +
          `Elas ficaram SENT e NÃO serão reenviadas — confira o painel do Zernio antes de redisparar.`,
      );
      this.logger.error({ err, campaignId: job.data.campaignId }, err.message);
      Sentry.captureException(err, {
        tags: {
          campaignId: job.data.campaignId,
          channelId: job.data.channelId,
          zernioBroadcast: 'indeterminate',
        },
      });
    }
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error({ err }, 'worker de broadcast do Zernio: erro');
    Sentry.captureException(err);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ZernioBroadcastDispatchJob>, err: Error) {
    // Um broadcast que CHEGA AQUI falhou por um motivo demonstradamente ANTERIOR
    // ao disparo (o caminho indeterminado não relança — ver o serviço), e por
    // isso devolveu as mensagens para QUEUED: é de lá que a retentativa as
    // reivindica.
    this.logger.error(
      { err, campaignId: job?.data?.campaignId },
      'broadcast do Zernio FALHOU antes de disparar — as mensagens voltaram para QUEUED',
    );
    Sentry.captureException(err, {
      tags: { campaignId: job?.data?.campaignId, channelId: job?.data?.channelId },
    });

    // ★ E se esta foi a ÚLTIMA tentativa, QUEUED vira um beco sem saída: não há
    // mais job nenhum para buscar aquelas linhas, a campanha fica "Em execução"
    // para sempre e o "Disparar novamente" recusa (countInFlight conta QUEUED).
    // O lote passa a FALHA RECUPERÁVEL, que o "Reenviar falhas" resgata.
    //
    // `?? 1` é o padrão do BullMQ para job enfileirado sem `attempts` — que é
    // EXATAMENTE o caso aqui: os dois `registerQueue` desta fila (campaigns.module
    // e whatsapp-providers.module) são pelados e sombreiam o defaultJobOptions do
    // QueueModule, então na prática a primeira falha já é a última. Ler
    // `job.opts.attempts` (em vez de fixar um número) é o mesmo contrato do
    // send-message.processor.
    //
    // O resgate é AGUARDADO, e a rejeição dele é capturada AQUI. Um
    // `void promise` dentro de um @OnWorkerEvent tem duas consequências ruins e
    // as duas doem no pior momento possível: se o banco estiver fora (a causa
    // provável de o dispatch ter falhado), a rejeição vira unhandled rejection e
    // o erro SOME — o lote fica QUEUED órfão e ninguém fica sabendo. O EventEmitter
    // do BullMQ não espera este handler, mas o `await` + `catch` garantem que
    // nada escape sem alarme.
    //
    // (O `failOrphanedBatch` é UMA ida ao banco para o lote inteiro, não uma por
    // mensagem — ver o serviço.)
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job?.data && (job.attemptsMade ?? 0) >= maxAttempts) {
      try {
        await this.svc.failOrphanedBatch(job.data, err);
      } catch (rescueErr) {
        this.logger.error(
          { err: rescueErr, campaignId: job.data.campaignId },
          'FALHA AO RESGATAR o lote órfão do broadcast — as mensagens podem ter ficado QUEUED sem job',
        );
        Sentry.captureException(rescueErr, {
          tags: {
            campaignId: job.data.campaignId,
            zernioBroadcast: 'orphan-rescue-failed',
          },
        });
      }
    }
  }
}

/**
 * ZB — o worker do POLLING do status por destinatário.
 *
 * `concurrency: 1` pelo mesmo motivo: cada página come um slot do balde do ENVIO.
 * O serviço já cede a vez à campanha (`zernioSendHasPriority`); a concorrência 1
 * garante que N disparos em polling não somem N requisições por segundo.
 */
@Processor(QUEUE_NAMES.ZERNIO_BROADCAST_POLL, { concurrency: 1 })
export class ZernioBroadcastPollProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioBroadcastPollProcessor.name);

  constructor(private readonly svc: ZernioBroadcastPollService) {
    super();
  }

  async process(job: Job<ZernioBroadcastPollJob>): Promise<void> {
    await this.svc.pollBroadcast(job.data);
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error({ err }, 'worker de polling de broadcast: erro');
    Sentry.captureException(err);
  }
}

/**
 * ★ ZB — o worker do KILL-SWITCH.
 *
 * Fila própria (e não uma chamada direta de `CampaignsService.cancel`) por duas
 * razões, e as duas importam:
 *
 * 1. **Acoplamento**: `CampaignsModule` não importa `WhatsappProvidersModule`.
 *    Uma fila é um contrato sem dependência — o cancel publica um id e segue.
 * 2. **Resiliência**: cancelar N broadcasts são N chamadas HTTP ao Zernio, e
 *    qualquer uma pode falhar. Se isso rodasse DENTRO do `cancel()`, uma falha de
 *    rede derrubaria o cancelamento da campanha inteira — o operador apertaria
 *    "Cancelar", veria um erro, e a campanha continuaria RUNNING. Aqui, o cancel
 *    do orgamind é instantâneo e o cancelamento no Zernio é retentado pelo BullMQ.
 */
@Processor(QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL, { concurrency: 1 })
export class ZernioBroadcastCancelProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioBroadcastCancelProcessor.name);

  constructor(private readonly svc: ZernioBroadcastSendService) {
    super();
  }

  async process(job: Job<ZernioBroadcastCancelJob>): Promise<void> {
    await this.svc.cancelForCampaign(job.data.campaignId);
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error({ err }, 'worker de cancelamento de broadcast: erro');
    Sentry.captureException(err);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ZernioBroadcastCancelJob>, err: Error) {
    // Um kill-switch que falha em silêncio é o pior dos mundos: o operador acha
    // que parou o disparo, e o Zernio continua mandando.
    this.logger.error(
      { err, campaignId: job?.data?.campaignId },
      'KILL-SWITCH FALHOU: os broadcasts do Zernio podem AINDA ESTAR DISPARANDO',
    );
    Sentry.captureException(err, {
      tags: { campaignId: job?.data?.campaignId, killSwitch: 'zernio-broadcast' },
    });
  }
}
