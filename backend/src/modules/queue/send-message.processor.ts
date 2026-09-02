import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { ClsService } from 'nestjs-cls';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import type Redis from 'ioredis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { DomainError } from '../../shared/errors/domain.error';
import { QUEUE_NAMES, type SendMessageJob } from './queue.constants';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CampaignsRepository } from '../campaigns/campaigns.repository';
import { ChatRepository } from '../chat/chat.repository';
import { ChatEventsService } from '../chat/chat-events.service';
import { renderTemplateBody } from '../../shared/template/render-template-body';
import { enrichVariablesWithContact } from '../../shared/template/enrich-variables';
import {
  isMarketingUndeliverableCode,
  marketingUndeliverableReason,
} from '../campaigns/marketing-reachability';
import {
  AUDIT_CLS_KEY,
  AuditService,
  type AuditContext,
} from '../../shared/audit/audit.service';
import {
  isTwilioKillSwitchCode,
  isImmediateKillSwitchCode,
  pausesTemplateLocally,
} from '../whatsapp-providers/adapters/twilio-error-mapper';
import { WhatsappInstanceRouter } from '../whatsapp-instances/whatsapp-instance-router.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { warmupEffectiveCap } from '../whatsapp-instances/warmup.helper';
import type { Channel, MessageStatus, Prisma } from '@prisma/client';
// ★ I9 (revisão de integração) — A GUARDA ANTI-DUPLICATA MORA NUM LUGAR SÓ.
//
// Ela vivia AQUI e tinha uma cópia idêntica em
// `whatsapp-providers/zernio-broadcast-duplicate-guard.ts`, porque os dois
// pacotes nasceram em branches separadas da mesma auditoria. Elas chegaram
// juntas — e as duas já tinham divergido JUNTAS da rede da audiência na régua da
// campanha CANCELADA, de um jeito que nenhum `diff` entre as cópias acusava.
// Agora é uma função só, em `campaigns/duplicate-guard.ts`, com o mesmo
// conjunto de status das outras quatro camadas.
import {
  duplicateGuardWhere,
  DUPLICATE_ERROR_CODE,
} from '../campaigns/duplicate-guard';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';
import {
  acquirePacingLock,
  releasePacingLock,
  checkAndPauseBurst,
} from '../campaigns/pacing.helper';
import { parseEnvNumber } from './env-number.helper';
import { acquireZernioSendSlot } from './zernio-throttle.helper';
import { ConsentService } from '../consent/consent.service';
import { TIMEZONE_DEFAULT } from '../../schemas/contracts/schedule.schema';
import { mayStillSendToContact } from '../campaigns/campaign-consent-gate';
import {
  classifyFailure,
  buildContactFailureUpdate,
} from '../campaigns/failure-reason';

// Rede de segurança independente do mapper de cada provedor: estes códigos da
// Meta são fatais mesmo que o adapter tenha reportado `fatal: false` (o adapter
// do META, por exemplo, não tem mapper próprio).
//
// ZE — 130472 entrou aqui: "the recipient is part of a marketing-message
// experiment and cannot receive marketing templates right now" (UTILITY não é
// afetado). Sem ele, o código caía no default retryable e queimava as 5
// tentativas + cota de tier contra uma parede. Junto com 131026 (marketing
// desligado pelo destinatário), formam as falhas DEFINITIVAS de MARKETING —
// ver marketing-reachability.ts.
const FATAL_META_ERROR_CODES = new Set([
  '130472',
  '131026',
  '131047',
  '131051',
  '132000',
  '132001',
  '133010',
]);

// ── B3: timeout indeterminado de CLIENTE — nunca reenviar automaticamente ───
// Um timeout/reset client-side no POST significa que NUNCA soubemos se o
// provedor aceitou (e cobrou) a mensagem: o envio pode ter saído e não há
// SID/id para casar com o webhook de status nem com o reconciler SENT+id.
// Reenviar arrisca cobrança dupla + entrega DUPLICADA a uma pessoa real (um
// sinal forte de ban). Nasceu como guarda exclusiva da Twilio
// (`code === 'twilio.timeout'`); generalizada aqui para TODO provedor cujo
// adapter emite um sinal de timeout indeterminado — o Zernio é o provedor do
// tráfego REAL do cliente e tinha o MESMO buraco (o error-mapper já marca
// `zernio.timeout` como `fatal: false`/retentável, então caía direto no ramo
// de retry do BullMQ).
//
// Cada entrada mapeia o código CRU que o adapter emite para o código
// TERMINAL gravado em `Message.errorCode` (distinto do cru, não-auto-
// retentável) e a mensagem operador-facing correta para aquele provedor.
const INDETERMINATE_TIMEOUTS: Record<
  string,
  { terminal: string; label: string; operatorMessage: string }
> = {
  'twilio.timeout': {
    terminal: 'twilio.indeterminate',
    label: 'Twilio',
    operatorMessage:
      'Timeout ao enviar via Twilio: a mensagem PODE ter sido entregue. Verifique no painel da Twilio antes de reenviar.',
  },
  'zernio.timeout': {
    terminal: 'zernio.indeterminate',
    label: 'Zernio',
    operatorMessage:
      'Timeout ao enviar via Zernio: a mensagem PODE ter sido entregue. Verifique no painel do Zernio antes de reenviar.',
  },
  'gozap.timeout': {
    terminal: 'gozap.indeterminate',
    label: 'GoZap',
    operatorMessage:
      'Timeout ao enviar via GoZap: a mensagem PODE ter sido entregue. Verifique no painel do GoZap antes de reenviar.',
  },
};

// ── T8: kill-switch de campanha TWILIO ───────────────────────────────────────
// Falhas de template/qualidade (63040/41/42/49, 21610) são propriedades da
// CAMPANHA, não do destinatário: se N envios consecutivos falham por template
// pausado/desativado ou throttle de marketing, o restante do lote vai falhar
// igual — continuar só queima cota de tier e quality rating. Ao atingir o
// limiar, o restante é cancelado pelo mecanismo de cancel existente
// (CampaignsService.cancel: drena jobs + CANCELLED nas QUEUED) + audit
// 'campaign.kill_switch'. Contador em Redis (INCR consecutivo, zerado a cada
// envio bem-sucedido; TTL 24h para não vazar chaves de campanhas mortas).
/**
 * Janela de coalescência dos eventos SSE do espelho de campanha (por canal).
 * O Inbox aberto revalida sozinho a cada 10s (mensagens) / 15s (lista), então
 * 5s é curto o bastante para o operador não perceber e longo o bastante para
 * um disparo de milhares de mensagens não virar milhares de refetches.
 */
const MIRROR_EVENT_THROTTLE_SECONDS = 5;

const KILL_SWITCH_THRESHOLD = 5;
const KILL_SWITCH_TTL_SECONDS = 24 * 3600;
const killSwitchKey = (campaignId: string) =>
  `campaign:killswitch:${campaignId}`;

// ── C2: cap de MARKETING por destinatário (Meta 131049, spec §5.3) ───────────
// A Meta impõe um teto ADAPTATIVO de templates de marketing por usuário em 24h,
// somando TODAS as empresas. Ao estourar, a mensagem falha com 131049 e a
// orientação oficial é esperar 24h — retentar é ativamente pior ("excessive
// retry attempts within 24 hours to users who've reached their limit ... further
// delivery attempts to these users may be unavailable for up to 24 hours").
// Guardamos o bloqueio pelo HASH do telefone (mesma chave durável da supressão:
// sobrevive à exclusão/reimportação do contato e não deixa telefone em claro no
// Redis) e o consultamos no gate de dispatch.
const MARKETING_CAP_CODE = '131049';
const MARKETING_CAP_TTL_SECONDS = 24 * 3600;
const marketingCapKey = (phoneHash: string) => `optout:131049:${phoneHash}`;

// ── K4: A GUARDA ANTI-DUPLICATA, NO ATO DO ENVIO ─────────────────────────────
//
// A pergunta "esta PESSOA já recebeu — ou já está recebendo — o que esta linha
// ia mandar?" e o `errorCode` que ela grava moram em
// `campaigns/duplicate-guard.ts`, junto com a régua de status e a explicação
// inteira. Este worker é UM dos dois transportes que a fazem; o outro é o
// broadcast do Zernio, que não passa por aqui. Uma função só para os dois: era
// o combinado desde que as duas cópias nasceram, e é o que fecha o I9.


// @Processor() runs at module-load time, before any DI container exists,
// so we read tunables straight from process.env. Defaults match the prior
// hard-coded values; restart the worker container to apply changes.
// parseEnvNumber guards against a typo'd env silently becoming NaN (which would
// make `concurrency: NaN` / `limiter.max: NaN` and break the worker).
const WORKER_CONCURRENCY = parseEnvNumber(
  process.env.WORKER_CONCURRENCY,
  10,
  'WORKER_CONCURRENCY',
);
const WORKER_LIMITER_MAX = parseEnvNumber(
  process.env.WORKER_RATE_LIMIT_MAX,
  80,
  'WORKER_RATE_LIMIT_MAX',
);
const WORKER_LIMITER_DURATION = parseEnvNumber(
  process.env.WORKER_RATE_LIMIT_DURATION_MS,
  1000,
  'WORKER_RATE_LIMIT_DURATION_MS',
);

@Processor(QUEUE_NAMES.WHATSAPP_SEND, {
  concurrency: WORKER_CONCURRENCY,
  limiter: { max: WORKER_LIMITER_MAX, duration: WORKER_LIMITER_DURATION },
})
export class SendMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(SendMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    private readonly cls: ClsService,
    private readonly router: WhatsappInstanceRouter,
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly campaignsRepo: CampaignsRepository,
    private readonly campaigns: CampaignsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly consent: ConsentService,
    private readonly chatRepo: ChatRepository,
    private readonly chatEvents: ChatEventsService,
  ) {
    super();
  }

  /**
   * C1 — o destinatário AINDA pode receber esta campanha? (spec §4.3)
   *
   * Roda no dispatch de cada mensagem, e não só na montagem da audiência,
   * porque as duas coisas podem estar separadas por SEMANAS: com tier de 250
   * usuários/24h, uma campanha para milhares de pessoas leva um mês para
   * escoar, e quem revogou no dia 3 não pode receber no dia 30.
   *
   * A supressão global já foi checada antes desta chamada (é absoluta). Aqui
   * cobrimos a revogação POR FINALIDADE, que não suprime o telefone.
   */
  private async mayStillSend(
    campaign: {
      purposeKey: string | null;
      override: boolean;
      overrideJustification: string | null;
    },
    contactId: string,
    instanceId: string,
  ): Promise<boolean> {
    // ZB — A REGRA MUDOU DE ARQUIVO, NÃO DE CONTEÚDO.
    //
    // O corpo deste gate agora mora em `campaigns/campaign-consent-gate.ts`
    // porque existem DOIS caminhos de envio (o 1-a-1 daqui e o BROADCAST do
    // Zernio), e os dois têm de aplicar EXATAMENTE o mesmo gate. Duas cópias
    // divergem; e uma divergência aqui não dá erro nem quebra teste — ela ENVIA,
    // sem consentimento. Uma fonte, nenhuma cópia.
    return mayStillSendToContact(
      {
        consent: this.consent,
        campaignsRepo: this.campaignsRepo,
        prisma: this.prisma,
      },
      campaign,
      contactId,
      instanceId,
    );
  }

  /**
   * T8/C2 — contabiliza uma falha de template/qualidade no kill-switch da
   * campanha e cancela o restante ao atingir o limiar.
   *
   * C2 (spec §5.3), três correções:
   * - vale para TODOS os provedores CLOUD (TWILIO/META/ZERNIO), não só TWILIO:
   *   Zernio e Meta enviam pela API oficial da Meta e recebem os mesmos 13xxxx.
   *   Evolution (não-oficial) segue fora — lá não há template pausado pela Meta.
   * - `132015` dispara com LIMIAR 1: é a Meta pausando o TEMPLATE INTEIRO
   *   (template pacing), não a falha de um destinatário — a 2ª ocorrência já é
   *   desperdício de cota e de quality rating.
   * - ao disparar por `132015`, o template LOCAL vai a PAUSED, para que o
   *   catálogo pare de oferecê-lo antes mesmo de o job de sync confirmar.
   *
   * ZA3 — `131031` (a Meta BLOQUEOU a conta/número) entra com LIMIAR 1 também:
   * nenhuma mensagem daquela conta vai sair, e cada tentativa a mais é uma
   * rejeição a mais no histórico de qualidade do número. Mas ele NÃO pausa o
   * template (quem está bloqueado é a conta) — daí `pausesTemplateLocally`.
   *
   * Best-effort: uma falha aqui (Redis fora, cancel/template update falharam)
   * nunca muda o desfecho da mensagem corrente — ela já foi FAILED/
   * re-enfileirada.
   */
  private async maybeTripKillSwitch(
    campaignId: string,
    code: string | undefined,
    isCloud: boolean,
    logger: Logger,
    templateId?: string,
  ): Promise<void> {
    if (!isCloud || !isTwilioKillSwitchCode(code)) return;
    const immediate = isImmediateKillSwitchCode(code);
    const threshold = immediate ? 1 : KILL_SWITCH_THRESHOLD;
    try {
      const key = killSwitchKey(campaignId);
      const count = await this.redis.incr(key);
      await this.redis.expire(key, KILL_SWITCH_TTL_SECONDS);
      if (count < threshold) return;
      logger.error(
        `[kill-switch] campanha ${campaignId}: ${count} falha(s) consecutiva(s) de template/qualidade (código ${code}, limiar ${threshold}) — cancelando o restante`,
      );
      // 132015: a Meta pausou o template. Refletir isso no catálogo local tira o
      // template do gate de campanha (que só aceita APPROVED) imediatamente, em
      // vez de esperar a próxima rodada do template-approval-sync.
      // ZA3 — a condição é `pausesTemplateLocally(code)`, e NÃO `immediate`: o
      // 131031 (conta bloqueada) também tem limiar 1, mas o template não tem
      // culpa nenhuma — pausá-lo tiraria do ar um template saudável.
      if (pausesTemplateLocally(code) && templateId) {
        await this.prisma.template
          .update({ where: { id: templateId }, data: { status: 'PAUSED' } })
          .catch((e) =>
            logger.warn(
              { err: e, templateId },
              'kill-switch: falha ao marcar o template como PAUSED (best-effort)',
            ),
          );
      }
      await this.audit.log('campaign.kill_switch', 'Campaign', campaignId, {
        errorCode: code,
        consecutiveFailures: count,
        threshold,
        templateId,
      });
      await this.campaigns.cancel(campaignId);
      await this.redis.del(key).catch(() => undefined);
    } catch (err) {
      logger.warn(
        { err, campaignId },
        'kill-switch bookkeeping failed (best-effort)',
      );
    }
  }

  /**
   * Espelha na inbox uma mensagem de campanha JÁ ENVIADA: liga-a à Conversation
   * (é o que a coloca na thread — a leitura filtra por conversationId) e avança
   * o resumo que a lista lateral mostra. Sem isto, o operador via a campanha sair
   * e a conversa continuar sem preview, sem horário e sem a bolha na thread.
   *
   * Best-effort por contrato: NUNCA propaga. A mensagem já foi aceita e cobrada
   * pelo provedor; deixar este espelho derrubar o job faria o BullMQ reenviá-la
   * (cobrança dupla + entrega duplicada, que é sinal de ban).
   */
  private async mirrorToInbox(args: {
    messageId: string;
    instanceId: string;
    contactId: string | null;
    phoneE164: string;
    content: string;
    sentAt: Date;
    logger: Logger;
  }): Promise<void> {
    const { logger, ...link } = args;
    try {
      const conversationId =
        await this.chatRepo.linkOutboundCampaignMessage(link);
      // COALESCÊNCIA — um disparo é um FLUXO, não um evento. Sem gate, uma
      // campanha de 5.000 contatos publicaria 5.000 `message.created`; o
      // frontend invalida a LISTA inteira de conversas a cada evento
      // (use-chat-stream → invalidateChat), então cada aba de Inbox aberta
      // refaria 5.000 GETs que ninguém pediu, no ritmo do envio. O gate (SET NX
      // EX por canal) deixa passar no máximo 1 evento a cada
      // MIRROR_EVENT_THROTTLE_SECONDS por canal: a inbox aberta continua
      // acordando quase em tempo real e, entre um gate e outro, o polling de
      // 10s/15s da própria tela cobre. Best-effort: se o Redis engasgar,
      // publicamos (o evento é barato; perder a atualização não é).
      let mayPublish = true;
      try {
        const gate = await this.redis.set(
          `chat:mirror-evt:${link.instanceId}`,
          '1',
          'EX',
          MIRROR_EVENT_THROTTLE_SECONDS,
          'NX',
        );
        mayPublish = gate === 'OK';
      } catch {
        mayPublish = true;
      }
      if (mayPublish) {
        await this.chatEvents.publish({
          type: 'message.created',
          conversationId,
          instanceId: link.instanceId,
          messageId: link.messageId,
        });
      }
    } catch (err) {
      logger.warn(
        { err, messageId: link.messageId },
        'espelho da mensagem de campanha na inbox falhou (best-effort; a mensagem FOI enviada e continua SENT)',
      );
    }
  }

  async process(job: Job<SendMessageJob>, token?: string): Promise<void> {
    return this.cls.run(() => {
      // Re-bind the originating HTTP correlationId so audit events emitted by
      // anything we call (templates, contacts, etc.) tie back to the request
      // that enqueued this job. AuditContextInterceptor only fires on HTTP
      // contexts; without this seeding, audit rows from job code lose actor/
      // correlation metadata entirely.
      this.cls.set<AuditContext>(AUDIT_CLS_KEY, {
        correlationId: job.data.correlationId,
      });
      return this.processInner(job, token);
    });
  }

  private async processInner(
    job: Job<SendMessageJob>,
    token?: string,
  ): Promise<void> {
    const { messageId, correlationId } = job.data;
    // Tag the logger with the originating correlationId so trace lines
    // line up with the HTTP request that enqueued the job. Legacy jobs
    // without correlationId fall back to the class-level logger.
    const logger = correlationId
      ? new Logger(`SendMessageProcessor[${correlationId}]`)
      : this.logger;

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        contact: true,
        campaign: { include: { template: true } },
      },
    });
    if (!message) {
      logger.warn(`Message ${messageId} not found, skipping`);
      return;
    }
    // campaignId/contactId are nullable on Message now (inbound + manual chat
    // messages have neither). The send pipeline only ever processes campaign
    // messages, so narrow here; if a non-campaign message were ever enqueued,
    // skip it safely instead of throwing.
    if (!message.campaign || !message.contact) {
      logger.warn(
        `Message ${messageId} has no campaign/contact, skipping (not a campaign send)`,
      );
      return;
    }
    // C1 — o gate é REAVALIADO no dispatch de cada mensagem, não só na
    // materialização da audiência (spec §2.7 regra 6). Com tier 250, uma
    // campanha para milhares de pessoas leva semanas: quem deu PARAR no dia 3
    // não pode receber no dia 30.
    //
    // ★ Decisão do cliente, 25/08/2026 — a ÚNICA fonte aqui é a
    // `SuppressionList` (chave durável por `phoneHash`), que continua absoluta.
    // O cache `Contact.optedOut` saiu da condição: o cliente pediu, com o risco
    // de LGPD/política do WhatsApp apresentado e aceito por escrito, que o
    // booleano deixasse de cancelar envio. Ele era, de qualquer forma, o lado
    // frágil do par — envelhece quando a linha de Contact é recriada por uma
    // importação de planilha.
    if (await this.consent.isSuppressed(message.contact.phoneE164)) {
      logger.debug(`Skipping ${messageId}: contact is suppressed`);
      await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'CANCELLED', errorCode: 'opted_out' },
      });
      // Idem: estado terminal sem reavaliação da campanha travava-a em RUNNING.
      void this.campaigns
        .maybeCompleteCampaign(message.campaign.id)
        .catch((e) => logger.warn({ err: e }, 'maybeCompleteCampaign failed'));
      return;
    }

    // ...e o consentimento POR FINALIDADE também é reconsultado aqui: uma
    // revogação parcial (só `captacao_recursos`, digamos) não suprime o
    // telefone, então a checagem acima não a veria.
    if (
      !(await this.mayStillSend(
        message.campaign,
        // `contact` já foi estreitado como não-nulo acima; `contactId` (a FK)
        // continua `string | null` para o TS.
        message.contact.id,
        message.instanceId,
      ))
    ) {
      logger.debug(
        `Skipping ${messageId}: sem consentimento ativo para '${message.campaign.purposeKey ?? '(sem finalidade)'}'`,
      );
      await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'SKIPPED_NO_CONSENT', errorCode: 'no_consent' },
      });
      // GATE SILENCIOSO — este early-return é terminal para a mensagem, e se ela
      // for a ÚLTIMA em voo ninguém mais reavalia a campanha: ela trava "Em
      // execução" para sempre. Mesmo fire-and-forget dos caminhos de sucesso.
      void this.campaigns
        .maybeCompleteCampaign(message.campaign.id)
        .catch((e) => logger.warn({ err: e }, 'maybeCompleteCampaign failed'));
      return;
    }
    // Operator clicked "Cancelar campanha" while this job sat in the BullMQ
    // queue (waiting / active / delayed promoted late). Abort before hitting
    // the provider — sending a message from a "cancelled" campaign is the
    // exact phantom-send the cancel button is supposed to prevent.
    if (message.campaign.status === 'CANCELLED') {
      logger.debug(`Skipping ${messageId}: campaign is CANCELLED`);
      await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'CANCELLED', errorCode: 'campaign_cancelled' },
      });
      return;
    }

    // ── K4: esta PESSOA já recebeu (ou já está recebendo)? ───────────────────
    const twin = await this.prisma.message.findFirst({
      where: duplicateGuardWhere({
        messageId,
        contactId: message.contact.id,
        campaignId: message.campaign.id,
        templateId: message.campaign.templateId,
        createdAt: message.createdAt,
      }),
      select: { id: true, campaignId: true, status: true },
    });
    if (twin) {
      logger.warn(
        `[K4] ${messageId} NÃO enviada: o contato ${message.contact.id} já tem a mensagem ${twin.id} (campanha ${twin.campaignId ?? '—'}, status ${twin.status})`,
      );
      // ★ ESCRITA CONDICIONAL, e não um `update` por id.
      //
      // O retry compõe um `jobId` distinto (há `Date.now()` nele), então o
      // BullMQ NÃO deduplica: dois jobs para o MESMO `messageId` podem estar
      // ativos ao mesmo tempo. Se um deles já reivindicou a linha (SENDING) e
      // está DENTRO do provedor, um `update` por id carimbaria "não enviada
      // para não duplicar" por cima de uma mensagem que ESTÁ saindo — a linha
      // passaria a mentir, e o eleitor teria recebido. Escopar a quem ainda
      // está na FILA é o mesmo padrão de `markWaitingForInstance` logo abaixo.
      const { count: cancelled } = await this.prisma.message.updateMany({
        where: {
          id: messageId,
          status: { in: ['QUEUED', 'WAITING_INSTANCE'] },
        },
        data: {
          status: 'CANCELLED',
          errorCode: DUPLICATE_ERROR_CODE,
          errorMessage: `Não enviada para não duplicar: este contato já tem a mensagem ${twin.id} (status ${twin.status}) nesta campanha ou em outra do mesmo template.`,
        },
      });
      if (cancelled === 0) {
        // A linha deixou a fila entre a guarda e agora: outro ator é o dono
        // dela. Não há o que auditar (nada foi decidido aqui) nem campanha a
        // reavaliar — quem levou a linha responde pelo desfecho dela.
        logger.debug(
          `[K4] ${messageId}: não carimbado — a linha já saiu de QUEUED/WAITING_INSTANCE (outro worker a reivindicou)`,
        );
        return;
      }
      await this.audit.log('campaign.duplicate_blocked', 'Message', messageId, {
        campaignId: message.campaign.id,
        contactId: message.contact.id,
        blockedByMessageId: twin.id,
        blockedByCampaignId: twin.campaignId,
        blockedByStatus: twin.status,
      });
      // Terminal como os outros pulos: sem isto, se esta for a última em voo, a
      // campanha trava "Em execução" para sempre.
      void this.campaigns
        .maybeCompleteCampaign(message.campaign.id)
        .catch((e) => logger.warn({ err: e }, 'maybeCompleteCampaign failed'));
      return;
    }

    // ── C2: o destinatário estourou o cap de marketing da Meta (131049)? ─────
    // Enquanto o bloqueio de 24h vigora, ENVIAR É PROIBIDO — e insistir é o que
    // faz a Meta suspender a entrega àquele usuário por mais 24h. Adiamos o job
    // até o fim do bloqueio (nada foi reivindicado ainda, então não há claim a
    // soltar, e nenhum retry é queimado). Best-effort: se o Redis estiver fora,
    // seguimos o envio — bloquear tudo por causa de um cache seria pior.
    const capKey = marketingCapKey(
      this.consent.hashOf(message.contact.phoneE164),
    );
    const capTtlMs = await this.redis.pttl(capKey).catch(() => -2 as number); // -2 = chave inexistente
    if (capTtlMs > 0) {
      logger.log(
        `[131049] destinatário ${message.contact.id} bloqueado pelo cap de marketing da Meta — adiando ${messageId} por ${capTtlMs}ms`,
      );
      await job.moveToDelayed(Date.now() + capTtlMs, token);
      throw new DelayedError();
    }

    // ── Resolve which WhatsApp instance to use ───────────────────────────────
    const routed = await this.router.resolveForSend({
      contactId: message.contact.id,
      campaignDefaultInstanceId: message.campaign.defaultInstanceId,
    });

    if (routed.kind === 'waiting') {
      // Pré-claim: a linha ainda deve estar QUEUED aqui (claimForSend só roda
      // mais abaixo). Escopar a `from: 'QUEUED'` evita que este job roube uma
      // linha que outro worker já reivindicou (SENDING) entretanto.
      const waitingCount = await this.campaignsRepo.markWaitingForInstance({
        messageId,
        instanceId: routed.instanceId,
        from: 'QUEUED',
      });
      if (waitingCount === 0) {
        logger.debug(
          `Message ${messageId}: not parked WAITING_INSTANCE — row already left QUEUED (claimed elsewhere); skipping`,
        );
        return;
      }
      logger.debug(
        `Message ${messageId} waiting for instance ${routed.instanceId}`,
      );
      return;
    }

    let instance: Channel = routed.instance;

    // The anti-ban pipeline (send-window, warm-up cap, per-instance pacing lock
    // + jitter) exists ONLY to keep unofficial Evolution/Baileys numbers from
    // being banned. Twilio/Meta are official Cloud APIs that enforce their own
    // rate/tier limits, so those gates are skipped entirely for cloud providers.
    // Correctness logic (routing, atomic claim, markSent, incrementSentToday,
    // failure handling) still runs for every provider.
    //
    // T3: this is now decided PER CHANNEL — the resolved instance's `provider`,
    // not the deploy-global WHATSAPP_PROVIDER. A single deploy can route some
    // campaigns through Evolution and others through a cloud provider, so the
    // anti-ban gates must follow the number that actually sends this message.
    const isSessionChannel = isSessionProvider(instance.provider);

    // ── Anti-ban: daily reset check ─────────────────────────────────────────
    //
    // C3 (bônus) — O FUSO DA JANELA DE ENVIO.
    //
    // Era `America/Sao_Paulo`, fixo. Mas a janela existe para não incomodar o
    // DESTINATÁRIO, e o destinatário está em MANAUS (UTC-4, sem
    // horário de verão): com o fuso de SP (UTC-3), uma janela configurada como
    // "8h–20h" abria às **07:00 locais** — uma hora mais cedo, todos os dias.
    // É exatamente o tipo de irritação que faz a pessoa tocar em "Denunciar", e
    // denúncia é o mecanismo real de ban. A janela anti-ban estava, ela própria,
    // gerando sinal de ban.
    //
    // O fuso vem da CAMPANHA (que já o declara, e cujo default o C2 corrigiu
    // para America/Manaus) e não de uma constante: uma campanha gravada
    // explicitamente em outro fuso continua sendo avaliada NAQUELE fuso — mudar
    // o default não pode mover a janela de uma campanha que alguém já
    // configurou. Campanha legada sem fuso cai no default de quem opera o orgamind.
    const tz = message.campaign.timezone || TIMEZONE_DEFAULT;
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const resetAge = now.getTime() - instance.sentTodayResetAt.getTime();
    if (resetAge > DAY_MS) {
      // Conditional (compare-and-swap) reset: only the first worker past the 24h
      // boundary actually zeroes the counter; concurrent workers no-op so they
      // can't wipe slot reservations the winner already counted. We re-resolve
      // the fresh row below regardless of who won.
      await this.instancesRepo.resetSentToday(
        instance.id,
        now,
        new Date(now.getTime() - DAY_MS),
      );
      // Re-resolve to get fresh sentToday=0 from the router
      const freshRouted = await this.router.resolveForSend({
        contactId: message.contact.id,
        campaignDefaultInstanceId: message.campaign.defaultInstanceId,
      });
      if (freshRouted.kind === 'waiting') {
        // Same pre-claim scoping as above: still QUEUED at this point.
        const waitingCount = await this.campaignsRepo.markWaitingForInstance({
          messageId,
          instanceId: freshRouted.instanceId,
          from: 'QUEUED',
        });
        if (waitingCount === 0) {
          logger.debug(
            `Message ${messageId}: not parked WAITING_INSTANCE (post-reset) — row already left QUEUED (claimed elsewhere); skipping`,
          );
        }
        return;
      }
      instance = freshRouted.instance;
    }

    // NOTE: the daily-limit check is intentionally NOT here. The instance we
    // resolved above was read BEFORE the per-instance pacing lock is held, so
    // its `sentToday` is already stale: many jobs can read the same under-cap
    // value, all pass a pre-lock check, then send one-by-one through the lock —
    // overshooting dailySendLimit. The check is moved INTO the lock's critical
    // section below, where we re-read `sentToday` so concurrent sends can't
    // exceed the cap. (See "Anti-ban: daily limit (re-read inside lock)".)

    // ── Anti-ban: send window ─────────────────────────────────────────────────
    //
    // ★ Pedido do cliente 2026-08-25 — `Campaign.respeitarJanelaDeEnvio`
    // (default true, preserva o comportamento de sempre) dá ao operador um
    // botão explícito por campanha. `false` faz esta campanha ignorar a
    // janela mesmo em canal de SESSÃO.
    //
    // Continua condicionado a `isSessionChannel`: em canal OFICIAL (hoje só a
    // ZERNIO em produção) a janela NUNCA foi aplicada — a Cloud API tem seus
    // próprios limites — então este campo não tem efeito visível ali; é
    // exclusivamente sobre o caminho que já existia (EVOLUTION).
    const respeitaJanela = message.campaign.respeitarJanelaDeEnvio !== false;
    if (isSessionChannel && respeitaJanela && instance.sendWindowEnabled) {
      const zonedNow = toZonedTime(now, tz);
      const currentHour = zonedNow.getHours();
      const { sendWindowStartHour: start, sendWindowEndHour: end } = instance;

      // Wrap-aware: start > end is an overnight window (e.g. 22h–06h), where
      // "in window" means at/after start OR before end. The old non-wrapping
      // test (`h < start || h >= end`) was true for EVERY hour when start >= end,
      // so a message would be deferred to `start` forever and never send.
      // start === end is a degenerate config (rejected on write) — treat it as
      // no restriction so it can never trigger the perpetual-defer loop.
      const inWindow =
        start === end
          ? true
          : start < end
            ? currentHour >= start && currentHour < end
            : currentHour >= start || currentHour < end;
      const outsideWindow = !inWindow;
      if (outsideWindow) {
        // Compute the next `start:00:00` LOCAL to the campaign's timezone as a
        // UTC epoch. toZonedTime shifts the Date so native getters read in that
        // TZ; the local calendar pieces are extracted from that shifted view,
        // then assembled as a fresh local-naive Date and converted back to UTC
        // via fromZonedTime.
        const zoned = toZonedTime(now, tz);
        let year = zoned.getFullYear();
        let month = zoned.getMonth();
        let day = zoned.getDate();
        // If the current local hour is already past `start`, the window already
        // happened today — schedule for tomorrow's `start`.
        if (currentHour >= start) {
          const rollover = new Date(year, month, day + 1);
          year = rollover.getFullYear();
          month = rollover.getMonth();
          day = rollover.getDate();
        }
        const targetLocal = new Date(year, month, day, start, 0, 0, 0);
        const delayUntilMs = fromZonedTime(targetLocal, tz).getTime();
        logger.debug(
          `Message ${messageId} outside send window [${start}–${end}) ${tz} — delaying until ${targetLocal.toISOString().slice(0, 19)} local (epoch ${delayUntilMs})`,
        );
        // BullMQ contract: moveToDelayed must receive the worker token (so the
        // job is removed from the active set under our lock) and be followed by
        // throwing DelayedError, otherwise BullMQ tries to moveToCompleted a
        // no-longer-active job ("Missing lock for job …") and re-emits it as an
        // unhandled worker 'error'.
        await job.moveToDelayed(delayUntilMs, token);
        throw new DelayedError();
      }
    }

    // ── Anti-ban: lock de concorrência por instância + teto de warm-up ───────
    // Vale para CANAL DE SESSÃO (trait `sessionBased` — hoje só a EVOLUTION; a
    // condição abaixo é `isSessionProvider`, não o literal). Só um envio por
    // número pode estar ativo de cada vez: workers BullMQ concorrentes
    // metralhando o mesmo número é sinal forte de ban. Providers de nuvem
    // (Twilio/Zernio/Meta) impõem os próprios limites, então nenhum lock é
    // tomado — e, porque nenhum é tomado, nenhum pode ser liberado (ver finally).
    let acquiredLock = false;
    if (isSessionChannel) {
      const lockResult = await acquirePacingLock(this.redis, instance.id);
      if (!lockResult.acquired) {
        // Another worker is currently sending on this instance. Delay the job
        // so BullMQ re-promotes it after the current send + jitter sleep finish.
        logger.debug(
          `[pacing] instance=${instance.id} lock held — delaying message ${messageId} by ${lockResult.retryDelayMs}ms`,
        );
        await job.moveToDelayed(Date.now() + lockResult.retryDelayMs, token);
        throw new DelayedError();
      }
      acquiredLock = true;

      // ── Anti-ban: daily limit (re-read inside lock) ────────────────────────
      // Now that we hold the per-instance lock, re-read the CURRENT row so the
      // check acts on the true sentToday (siblings increment it while holding
      // this same lock, right after their markSent). This is the reservation:
      // under the lock, at most one job at a time sees the counter, so the
      // (N+1)th send when sentToday===dailySendLimit is delayed instead of
      // overshooting the cap. This is independent of the A2 claim (which
      // dedupes a single Message row) — it bounds the *count of distinct sends*
      // per instance per day.
      const fresh =
        (await this.instancesRepo.findById(instance.id)) ?? instance;
      // Anti-ban warm-up: a freshly-paired number sends at a reduced cap that
      // ramps up by age (see warmup.helper). The effective cap is the smaller
      // of the configured dailySendLimit and the ramp value for the age.
      const effectiveCap = warmupEffectiveCap(
        fresh.warmupStartedAt,
        new Date(),
        fresh.dailySendLimit,
      );
      if (fresh.sentToday >= effectiveCap) {
        const nextReset = new Date(
          fresh.sentTodayResetAt.getTime() + 24 * 60 * 60 * 1000,
        );
        const delayMs = Math.max(0, nextReset.getTime() - Date.now());
        logger.log(
          `Daily limit reached for instance ${instance.id} (sentToday=${fresh.sentToday} cap=${effectiveCap}); delaying message until ${nextReset.toISOString()}`,
        );
        // Release the lock immediately (no jitter sleep — nothing was sent) so
        // the next job for this instance isn't needlessly blocked while this
        // one waits.
        await this.redis
          .del(`pacing:send:lock:${instance.id}`)
          .catch(() => undefined);
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
      // Use the freshly-read row for the rest of the pipeline so increment/
      // markSent operate on the same instance state the check validated.
      instance = fresh;
    }

    // ── ZA4: throttle de ≤ 1 msg/s por canal ZERNIO ──────────────────────────
    // O balde do Zernio é de 60 req/min POR CHAVE de API (1 req/s) e é o MESMO
    // que os jobs de sync consomem. Sem espaçamento, um lote grande vira uma
    // sequência de 429 e a fila entra em retry-storm. Como no lock do Evolution,
    // o gate roda ANTES do claim: um job adiado aqui não desperdiça claim nem
    // slot de tier. (Ver zernio-throttle.helper.ts — inclusive sobre por que o
    // sync não pode virar polling sem uma chave de API dedicada.)
    if (instance.provider === 'ZERNIO') {
      const slot = await acquireZernioSendSlot(this.redis, instance.id);
      if (!slot.acquired) {
        logger.debug(
          `[zernio-throttle] canal ${instance.id} enviou há menos de 1s — adiando ${messageId} por ${slot.retryDelayMs}ms`,
        );
        await job.moveToDelayed(Date.now() + slot.retryDelayMs, token);
        throw new DelayedError();
      }
    }

    // ── A2: atomic send claim ────────────────────────────────────────────────
    // Flip QUEUED→SENDING atomically BEFORE touching the provider. If the row
    // is no longer QUEUED (claimed/sent by another BullMQ attempt, or already
    // moved on by a sibling worker), count===0 → skip without sending. This is
    // the duplicate-send guard: even if BullMQ retries after a successful send
    // (attempts>1) or a worker died mid-pipeline and the job is re-promoted,
    // wa.send runs at most once per message row.
    //
    // The claim happens while the pacing lock is held; on a lost claim we
    // release the lock immediately (no jitter sleep — nothing was sent) so the
    // next job for this instance isn't needlessly blocked.
    const claimed = await this.campaignsRepo.claimForSend(messageId);
    if (claimed === 0) {
      logger.debug(
        `Skipping ${messageId}: already claimed/sent (claim count=0) — idempotency guard`,
      );
      // Only release the pacing lock if we actually took it (session channel).
      if (acquiredLock) {
        await this.redis
          .del(`pacing:send:lock:${instance.id}`)
          .catch(() => undefined);
      }
      return;
    }

    // ── Tier batching (cloud): reserve one daily send slot ───────────────────
    // Now that we OWN the row (SENDING), reserve a slot atomically against the
    // instance's daily cap (dailySendLimit = the number's current WhatsApp tier,
    // e.g. 250/24h for a fresh number). If the cap is reached, un-claim the row
    // (→QUEUED so it stays pending and the campaign remains "Em execução") and
    // defer the job to the next 24h window. Reserving AFTER the claim means each
    // message consumes exactly one slot (a lost claim never wastes budget). The
    // session-channel path enforces its own cap inside the pacing lock above,
    // so this block is cloud-only.
    let reservedCloudSlot = false;
    if (!isSessionChannel) {
      // ── T8/ZA1: janela ROLANTE de 24h (guarda adicional, TODO CLOUD) ──────
      // O limite de tier da Meta conta usuários ÚNICOS em 24h MÓVEIS, não
      // mensagens em dia-calendário. O contador sentToday (reserveSendSlot,
      // abaixo) segue intacto — as duas guardas COEXISTEM: esta impede
      // adicionar um usuário único NOVO quando a janela móvel já tem
      // `dailySendLimit` destinatários distintos; mensagens a quem JÁ está na
      // janela não adicionam usuário único e passam. Deferimento idêntico ao
      // do tier batching (moveToDelayed p/ a próxima janela).
      //
      // ZA1 — a guarda nasceu `if (provider === 'TWILIO')`, e isso era uma
      // BOMBA: o número ZERNIO do cliente está em TIER_2K (2.000 usuários
      // únicos / 24h ROLANTES) e só o contador de dia-calendário o protegia.
      // Estourar o teto → mensagens rejeitadas pela Meta → quality rating
      // despenca → o tier CAI. O teto é da META, não do BSP: vale para
      // TWILIO, ZERNIO e META por igual. Ficam de fora os canais de SESSÃO
      // (trait `sessionBased` — hoje só a EVOLUTION, que não tem tier), e é
      // exatamente isso que o `!isSessionChannel` deste bloco expressa: a
      // condição é o trait, não uma lista de nomes de provider.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentRecipients = await this.prisma.message.groupBy({
        by: ['contactId'],
        where: {
          instanceId: instance.id,
          direction: 'OUTBOUND',
          contactId: { not: null },
          sentAt: { gte: since },
        },
      });
      const alreadyInWindow = recentRecipients.some(
        (r) => r.contactId === message.contact!.id,
      );
      if (
        recentRecipients.length >= instance.dailySendLimit &&
        !alreadyInWindow
      ) {
        const nextReset = new Date(
          instance.sentTodayResetAt.getTime() + 24 * 60 * 60 * 1000,
        );
        const delayMs = Math.max(0, nextReset.getTime() - Date.now());
        logger.log(
          `[rolling-24h] instance ${instance.id} (${instance.provider}): ${recentRecipients.length} destinatários únicos nas últimas 24h (cap=${instance.dailySendLimit}) e ${message.contact.id} está fora da janela — adiando ${messageId} até ${nextReset.toISOString()}`,
        );
        await this.campaignsRepo
          .releaseClaim(messageId)
          .catch((e) =>
            logger.warn({ err: e }, 'releaseClaim (rolling-24h defer) failed'),
          );
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }

      const cap = instance.dailySendLimit;
      const reserved = await this.instancesRepo.reserveSendSlot(
        instance.id,
        cap,
      );
      if (!reserved) {
        const nextReset = new Date(
          instance.sentTodayResetAt.getTime() + 24 * 60 * 60 * 1000,
        );
        const delayMs = Math.max(0, nextReset.getTime() - Date.now());
        logger.log(
          `[tier] daily cap reached for instance ${instance.id} (cap=${cap}); deferring message ${messageId} until ${nextReset.toISOString()}`,
        );
        // Release the claim so the deferred job can re-claim on its next run.
        await this.campaignsRepo
          .releaseClaim(messageId)
          .catch((e) =>
            logger.warn({ err: e }, 'releaseClaim (tier defer) failed'),
          );
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
      reservedCloudSlot = true;
    }

    // Track whether we need the jitter sleep on release. On send failure
    // we skip the inter-message sleep so the retry can proceed promptly.
    // providerMessageId/acceptedAt are hoisted so the catch can re-persist SENT
    // if markSent throws AFTER a successful send (never resend a billed message).
    let sendSucceeded = false;
    let providerMessageId: string | undefined;
    let acceptedAt: Date | undefined;
    // BOLHA VAZIA — o corpo renderizado é hoisted junto com o wamid: o retry
    // best-effort do catch precisa re-persistir o MESMO texto, senão uma falha
    // de bookkeeping deixaria a mensagem SENT e a bolha muda.
    let renderedContent: string | undefined;
    // Tracks whether the Evolution daily counter was already bumped inside the
    // try. Post-increment steps (burst pause) can still throw, and the catch's
    // sendSucceeded branch retries the bookkeeping — without this flag it would
    // increment a second time for a single send, prematurely burning the cap.
    let incrementedSentToday = false;
    try {
      // Backfill any template variables the campaign's variableMap missed,
      // using best-effort guesses from the contact record. Without this,
      // unofficial providers (Evolution) send "Olá {{nome}}!" literally
      // when the operator forgot to interact with each variable in the wizard.
      const variables = enrichVariablesWithContact(
        (message.variables ?? {}) as Record<string, string>,
        message.campaign.template.variables,
        message.contact,
      );

      // O texto que a pessoa vai LER, montado do corpo aprovado + as variáveis
      // já resolvidas — os dois estão aqui, no ato do envio, e eram jogados fora.
      // É o que vai para a bolha do Inbox, para o export e para a evidência do
      // opt-in por botão. O placeholder é ÚLTIMO recurso (template de mídia pura
      // ou interativo, sem corpo renderizável): nunca uma bolha muda.
      renderedContent =
        renderTemplateBody(message.campaign.template.body, variables) ||
        `[Template: ${message.campaign.template.metaName}]`;

      // ── Anti-ban: presence delay (Evolution typing simulation) ────────────
      // This delay is forwarded to the Evolution API so it simulates a human
      // typing before sending — distinct from the inter-message sleep below.
      const baseDelay = Math.max(
        message.campaign.presenceDelayMs,
        instance.globalPresenceDelayMs,
      );
      const jitter =
        instance.globalJitterMaxMs > 0
          ? Math.floor(Math.random() * (instance.globalJitterMaxMs + 1))
          : 0;
      const effectiveDelay = baseDelay + jitter;

      // T3: route the send through the adapter that matches THIS channel's
      // provider (sendVia resolves it from the registry), replacing the
      // deploy-global wa.send. The channel is the resolved instance.
      const result = await this.wa.sendVia(instance, {
        toE164: message.contact.phoneE164,
        // Twilio cold sends need an approved `HX…` Content SID. When the
        // template carries one, pass it as `templateName` so the Twilio
        // adapter's `HX` detection fires and uses `ContentSid`; otherwise
        // fall back to the lowercase `metaName` (Evolution/Meta path).
        templateName:
          message.campaign.template.twilioContentSid ??
          message.campaign.template.metaName,
        language: message.campaign.template.language,
        variables,
        // Raw body is what unofficial providers (Evolution) actually send
        // for TEXT kind. Interactive kinds rely on `interactiveConfig`.
        body: message.campaign.template.body,
        kind: message.campaign.template.kind,
        interactiveConfig: message.campaign.template.interactiveConfig,
        delay: effectiveDelay,
        // Optional override on the send port: falls back to the adapter's
        // env-configured default instance when this channel has no
        // evolutionInstanceName (non-Evolution channel) — mirrors the
        // existing `?? undefined` pattern used elsewhere in this codebase.
        evolutionInstanceName: instance.evolutionInstanceName ?? undefined,
      });

      sendSucceeded = true;
      providerMessageId = result.providerMessageId;
      acceptedAt = result.acceptedAt;

      await this.campaignsRepo.markSent({
        messageId,
        instanceId: instance.id,
        providerMessageId,
        sentAt: acceptedAt,
        content: renderedContent,
        contactId: message.contact.id,
      });

      // Espelha o envio na inbox: liga a Message à Conversation (thread) e
      // avança preview/horário da lista lateral. BEST-EFFORT de propósito — a
      // mensagem já foi aceita e COBRADA pelo provedor; um erro aqui é num dado
      // DERIVADO (cosmético) e não pode reenviá-la, rebaixar seu status nem
      // falhar o job.
      await this.mirrorToInbox({
        messageId,
        instanceId: instance.id,
        contactId: message.contact?.id ?? null,
        phoneE164: message.contact.phoneE164,
        content: renderedContent,
        sentAt: acceptedAt ?? new Date(),
        logger,
      });

      // Increment the daily counter. The cloud path already reserved its slot
      // up-front (reserveSendSlot), so only Evolution increments here.
      if (isSessionChannel) {
        await this.instancesRepo.incrementSentToday(instance.id);
        incrementedSentToday = true;
      }

      // T8 — envio bem-sucedido quebra a sequência de falhas: zera o contador
      // do kill-switch da campanha (o gatilho exige falhas CONSECUTIVAS).
      // C2 — o kill-switch vale para todo provedor cloud, então o reset também.
      if (!isSessionChannel) {
        await this.redis
          .del(killSwitchKey(message.campaign.id))
          .catch(() => undefined);
      }

      // ── Anti-ban: burst pause (Evolution only) ────────────────────────────
      // After PACING_BURST_SIZE consecutive sends on this instance, sleep
      // PACING_BURST_PAUSE_MS to mimic a natural break in human activity.
      // This runs while the pacing lock is still held, blocking the next job —
      // there is no lock (and no ban risk) on the cloud path, so it is skipped.
      if (acquiredLock) {
        await checkAndPauseBurst(this.redis, instance.id, logger);
      }

      // Best-effort: flip campaign to COMPLETED once the QUEUED list drains.
      this.campaigns
        .maybeCompleteCampaign(message.campaign.id)
        .catch((e) => logger.warn({ err: e }, 'maybeCompleteCampaign failed'));
    } catch (err: unknown) {
      // ── B2/B3: NEVER resend a message the provider already accepted ────────
      // wa.send RESOLVED, so Twilio accepted (and billed) the message; only the
      // post-send bookkeeping (markSent / completion) threw. Do NOT release the
      // claim and do NOT re-throw — either would let BullMQ resend and
      // double-charge. Best-effort re-persist SENT with the hoisted
      // providerMessageId; if that also fails the row stays SENDING and the
      // reconciler resolves it. Keep the reserved tier slot (message WAS sent).
      if (sendSucceeded) {
        logger.error(
          { err, messageId },
          'post-send bookkeeping failed after a successful send; NOT resending (anti double-charge)',
        );
        await this.campaignsRepo
          .markSent({
            messageId,
            instanceId: instance.id,
            providerMessageId,
            sentAt: acceptedAt,
            content: renderedContent,
            contactId: message.contact.id,
          })
          .catch((e) =>
            logger.warn({ err: e }, 'best-effort markSent retry failed'),
          );
        // Evolution counts the send here (cloud already counted via the
        // reservation). If markSent threw BEFORE the normal increment ran, the
        // daily counter would under-count without this best-effort retry — but
        // if the increment already happened (a later step, e.g. the burst pause,
        // is what threw) we must NOT bump it again for the same send.
        if (isSessionChannel && !incrementedSentToday) {
          await this.instancesRepo
            .incrementSentToday(instance.id)
            .catch((e) =>
              logger.warn(
                { err: e },
                'best-effort incrementSentToday retry failed',
              ),
            );
        }
        this.campaigns
          .maybeCompleteCampaign(message.campaign.id)
          .catch((e) =>
            logger.warn({ err: e }, 'maybeCompleteCampaign failed'),
          );
        return;
      }

      let code: string | undefined;
      let providerMsg: string | undefined;
      let isFatal = false;
      if (err instanceof WhatsappSendError) {
        code = err.providerErrorCode;
        providerMsg = err.providerErrorMessage;
        isFatal = err.fatal;
      }
      const msg = err instanceof Error ? err.message : String(err);

      // ── B3: indeterminate provider timeout — terminalize, do NOT resend ────
      // A client-side timeout/socket reset means we never learned whether the
      // PROVIDER accepted the message (no id returned), so it can't be matched
      // by a status webhook or a SENT+id reconciler. Resending risks a double
      // charge + duplicate delivery (a ban signal). Mark it FAILED with a
      // DISTINCT, non-auto-retryable code (`<provider>.indeterminate`) so it
      // lands in a terminal state immediately (instead of being blind-FAILED as
      // 'sending_stuck' by the 10-min stuck reconciler), stays out of bulk
      // retryFailedMessages, and is clearly labelled for the operator. Keep the
      // reserved tier slot — the message may well have been sent + billed.
      const indeterminateTimeout = code
        ? INDETERMINATE_TIMEOUTS[code]
        : undefined;
      if (indeterminateTimeout) {
        const { terminal, label, operatorMessage } = indeterminateTimeout;
        logger.warn(
          `Message ${messageId}: ${label} timeout (indeterminate) — marking FAILED(${terminal}), will NOT auto-resend.`,
        );
        await this.prisma.message.update({
          where: { id: messageId },
          data: {
            status: 'FAILED',
            errorCode: terminal,
            errorMessage: operatorMessage,
            failedAt: new Date(),
            failureReason: classifyFailure(terminal, instance.provider),
          },
        });
        // F2 — flag durável best-effort no Contact (failureCount sempre;
        // lastFailure* só se a falha for definitiva do destinatário — aqui não
        // é o caso, mas buildContactFailureUpdate já sabe disso).
        await this.prisma.contact
          .update({
            where: { id: message.contact.id },
            data: buildContactFailureUpdate(terminal, instance.provider),
          })
          .catch((e) =>
            logger.warn(
              { err: e },
              'F2: falha ao atualizar flag durável de falha do contato (best-effort)',
            ),
          );
        this.campaigns
          .maybeCompleteCampaign(message.campaign.id)
          .catch((e) =>
            logger.warn({ err: e }, 'maybeCompleteCampaign failed'),
          );
        return;
      }

      const fatalByMetaCode = !!code && FATAL_META_ERROR_CODES.has(code);
      if (isFatal || fatalByMetaCode) {
        logger.warn(
          `Fatal error ${code ?? '(unclassified)'} on message ${messageId}: ${msg}`,
        );
        // The message never reached the recipient — free its reserved tier slot
        // so a doomed send doesn't consume the day's budget.
        if (reservedCloudSlot) {
          await this.instancesRepo
            .releaseSendSlot(instance.id)
            .catch((e) =>
              logger.warn({ err: e }, 'releaseSendSlot (fatal) failed'),
            );
        }
        await this.prisma.message.update({
          where: { id: messageId },
          data: {
            status: 'FAILED',
            errorCode: code,
            // `msg` is the adapter's primary message: the mapped, operator-facing
            // reason for both Evolution and Twilio (raw text is in providerMsg).
            errorMessage: msg,
            failedAt: new Date(),
            failureReason: classifyFailure(code, instance.provider),
          },
        });
        // F2 — flag durável best-effort no Contact (failureCount sempre;
        // lastFailure* só quando a falha é definitiva do destinatário). Não
        // pode mudar o desfecho desta Message, que já está FAILED com a prova.
        await this.prisma.contact
          .update({
            where: { id: message.contact.id },
            data: buildContactFailureUpdate(code, instance.provider),
          })
          .catch((e) =>
            logger.warn(
              { err: e },
              'F2: falha ao atualizar flag durável de falha do contato (best-effort)',
            ),
          );
        // ZE — 131026/130472: o destinatário NÃO recebe template de MARKETING, e
        // isso é definitivo (ver marketing-reachability.ts). O estado vai para o
        // CONTATO, não para a mensagem: vale para todas as campanhas, e é o que
        // impede o próximo lote de queimar cota de tier na mesma parede.
        //
        // Este é o caminho SÍNCRONO (o adapter do Zernio mapeia o platformError
        // inline na resposta do POST). O caminho normal — a Meta aceita e depois
        // reporta a falha — chega pelo webhook de status, que grava o mesmo
        // estado (WebhooksService.processStatusUpdates).
        //
        // Best-effort: é dado DERIVADO (a Message já está FAILED com o código,
        // que é a prova). Não pode mudar o desfecho desta mensagem.
        if (isMarketingUndeliverableCode(code) && message.contact?.id) {
          await this.prisma.contact
            .update({
              where: { id: message.contact.id },
              data: {
                marketingUndeliverableAt: new Date(),
                marketingUndeliverableCode: code,
                marketingUndeliverableReason:
                  marketingUndeliverableReason(code),
              },
            })
            .catch((e) =>
              logger.warn(
                { err: e },
                'ZE: falha ao marcar contato inalcançável para marketing (best-effort)',
              ),
            );
        }
        // C2 — 131049: o destinatário estourou o cap de MARKETING da Meta.
        // Bloqueia o número por 24h (chave hasheada) para que NENHUMA outra
        // mensagem — desta ou de outra campanha — tente entregar antes disso.
        // Best-effort: um Redis fora não pode mudar o desfecho da mensagem.
        if (code === MARKETING_CAP_CODE) {
          await this.redis
            .set(capKey, '1', 'EX', MARKETING_CAP_TTL_SECONDS)
            .catch((e) =>
              logger.warn(
                { err: e },
                'bloqueio 131049 (Redis) falhou — best-effort',
              ),
            );
        }
        // T8 — falha fatal de template/qualidade alimenta o kill-switch da
        // campanha (best-effort; nunca muda o desfecho desta mensagem).
        await this.maybeTripKillSwitch(
          message.campaign.id,
          code,
          !isSessionChannel,
          logger,
          message.campaign.template.id,
        );
        this.campaigns
          .maybeCompleteCampaign(message.campaign.id)
          .catch((e) =>
            logger.warn({ err: e }, 'maybeCompleteCampaign failed'),
          );
        // fall through to finally — lock will be released without jitter sleep
        return;
      }
      // evolution.not_connected: the instance was connected at routing time but
      // dropped mid-send. The 5-attempt / ~62s BullMQ retry budget can't outlast
      // a real disconnect, so instead of burning it (and then permanently
      // FAILing the message) park the row as WAITING_INSTANCE — reconnect-replay
      // re-enqueues it when the instance reconnects, mirroring the router's
      // pre-send 'waiting' path. Vale para os DOIS providers de sessao: GOZAP
      // e sessionBased igual ao Evolution, tem o mesmo replay no evento 'open'
      // (gozap-instances.service#persistLiveState) e tambem nao tem cloud slot
      // a soltar. Sem `gozap.not_connected` aqui, uma queda de sessao com o
      // webhook de conexao perdido (aconteceu: 281 eventos evaporados) queimava
      // as 5 tentativas e matava a linha como FAILED, exigindo relote manual.
      if (
        code === 'evolution.not_connected' ||
        code === 'gozap.not_connected'
      ) {
        // Pós-claim: claimForSend já flipou a linha para SENDING antes do
        // wa.send. Escopar a `from: 'SENDING'` garante que só a mensagem que
        // ESTE attempt reivindicou é reparcada — nunca uma que outro ator já
        // moveu adiante (ex.: o reconciler recuperando-a como FAILED).
        const waitingCount = await this.campaignsRepo.markWaitingForInstance({
          messageId,
          instanceId: instance.id,
          from: 'SENDING',
        });
        if (waitingCount === 0) {
          logger.debug(
            `Message ${messageId}: not parked WAITING_INSTANCE — row already left SENDING (moved on by another actor); skipping`,
          );
          // fall through to finally — lock released without jitter sleep
          return;
        }
        logger.warn(
          `Message ${messageId} parked WAITING_INSTANCE: instance ${instance.id} disconnected mid-send`,
        );
        // fall through to finally — lock released without jitter sleep
        return;
      }
      // Anything that isn't a known WhatsappSendError or DomainError is an
      // unexpected bug — capture before re-throwing so BullMQ can retry.
      // (WhatsappSendError extends DomainError, so this also filters that.)
      if (!(err instanceof DomainError)) {
        Sentry.captureException(err, {
          tags: {
            jobId: typeof job.id === 'string' ? job.id : undefined,
            messageId,
            correlationId,
          },
        });
      }
      // Mute unused-var lint for providerMsg — it's part of the destructuring
      // contract and we read code/isFatal above.
      void providerMsg;
      // T8 — 63049 (throttle de marketing) é transiente, mas consecutivos numa
      // campanha indicam a Meta segurando o lote inteiro: conta para o
      // kill-switch mesmo no caminho de retry.
      await this.maybeTripKillSwitch(
        message.campaign.id,
        code,
        !isSessionChannel,
        logger,
        message.campaign.template.id,
      );
      // Retryable path (we re-throw so BullMQ retries). Release the reserved
      // tier slot first — the retry reserves a fresh one, so not releasing here
      // would make one message consume a slot per attempt. Then return the row
      // to QUEUED so the retry can re-claim; without this the retry hits claim
      // count=0 and silently skips the message forever. Best-effort on both.
      if (reservedCloudSlot) {
        await this.instancesRepo
          .releaseSendSlot(instance.id)
          .catch((e) =>
            logger.warn({ err: e }, 'releaseSendSlot (retry) failed'),
          );
      }
      await this.campaignsRepo
        .releaseClaim(messageId)
        .catch((e) => logger.warn({ err: e }, 'releaseClaim failed'));
      throw err;
    } finally {
      // ── Anti-ban: jittered inter-message sleep then release lock ──────────
      // releasePacingLock sleeps JITTER_MIN…JITTER_MAX ms before deleting the
      // Redis key, so the next job for this instance sees the key as occupied
      // for the full sleep duration. On failure we skip the sleep so BullMQ
      // can retry promptly (burst/daily limits still apply on the retry).
      //
      // CRITICAL: only touch the lock if we actually acquired it. On the cloud
      // path no lock was taken, so a release here would delete a key it never
      // owned (and needlessly hit Redis) — guard every release on acquiredLock.
      if (acquiredLock) {
        if (sendSucceeded) {
          await releasePacingLock(this.redis, instance.id, logger);
        } else {
          // Best-effort: delete lock immediately so retries aren't unnecessarily
          // blocked. Ignore errors — if the key already expired that's fine.
          await this.redis
            .del(`pacing:send:lock:${instance.id}`)
            .catch(() => undefined);
        }
      }
    }
  }

  // Transient worker-level errors (Redis blips, a stray "Missing lock" from a
  // late deferral, etc.) are emitted as a worker 'error' event. Without a
  // registered listener @nestjs/bullmq lets the emit propagate as an uncaught
  // rejection that can disrupt the whole worker run loop. Swallow + report so a
  // single transient error can never crash the process.
  @OnWorkerEvent('error')
  async onError(err: Error) {
    this.logger.error({ err }, 'WhatsApp send worker error');
    Sentry.captureException(err);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendMessageJob>, err: Error) {
    // BullMQ resolves `defaultJobOptions.attempts` into `job.opts.attempts`
    // at enqueue time, so we read it directly instead of hard-coding a
    // fallback that could drift from QueueModule's config. `?? 1` matches
    // BullMQ's library default for jobs added without an explicit attempts.
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      // Pull a useful errorCode from the classified error. WhatsappSendError
      // is checked FIRST (it extends DomainError) so its providerErrorCode
      // wins over the generic 'whatsapp.send_failed' code. Router/domain
      // failures (e.g. 'campaign.default_instance_inactive') are DomainErrors
      // thrown before the send try/catch — their .code used to be dropped,
      // leaving errorCode NULL in prod.
      const code =
        err instanceof WhatsappSendError
          ? err.providerErrorCode
          : err instanceof DomainError
            ? err.code
            : undefined;
      try {
        await this.prisma.message.update({
          where: { id: job.data.messageId },
          data: {
            status: 'FAILED',
            errorCode: code,
            errorMessage: err.message,
            failedAt: new Date(),
            // F2 — provider não está no escopo deste handler (job.data só
            // carrega messageId/campaignId/correlationId); classifyFailure
            // não precisa dele hoje para desambiguar nenhum código.
            failureReason: classifyFailure(code),
          },
        });
        await this.campaigns
          .maybeCompleteCampaign(job.data.campaignId)
          .catch((e) =>
            this.logger.warn({ err: e }, 'maybeCompleteCampaign failed'),
          );
      } catch (updateErr) {
        this.logger.error(
          { err: updateErr },
          'Failed to mark message as FAILED after all retries',
        );
      }
    }
  }
}

// A regra mora em shared/template/enrich-variables.ts (o reparo de dados precisa
// da MESMA função sem arrastar o worker inteiro). Re-exportada aqui porque os
// testes e chamadores históricos importam deste módulo.
export { enrichVariablesWithContact } from '../../shared/template/enrich-variables';
