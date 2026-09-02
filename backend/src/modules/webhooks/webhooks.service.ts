import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { CampaignsService } from '../campaigns/campaigns.service';
import {
  isMarketingUndeliverableCode,
  marketingUndeliverableReason,
} from '../campaigns/marketing-reachability';
import { ValidationError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import type { Env } from '../../shared/config/env.schema';
import {
  ConsentAction,
  ConsentSource,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import type { Channel, ChannelProvider, FailureReason } from '@prisma/client';
import { ConsentService, GLOBAL_PURPOSE } from '../consent/consent.service';
import {
  classifyFailure,
  buildContactFailureUpdate,
} from '../campaigns/failure-reason';
import { ChatIngestService } from '../chat/chat-ingest.service';
import { resolveContactByAnyBrForm } from '../chat/resolve-conversation';
import { OrganizationService } from '../organization/organization.service';
import { ChatEventsService } from '../chat/chat-events.service';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import { QUEUE_NAMES, type ChatHistorySyncJob } from '../queue/queue.constants';
import { isTwilioOptOutCode } from '../whatsapp-providers/adapters/twilio-error-mapper';
import { parseZernioTemplateStatusEvent } from '../whatsapp-providers/adapters/zernio-cloud.adapter';
import { recomputeBroadcastCounters } from '../whatsapp-providers/zernio-broadcast-counters';
import { TemplatesService } from '../templates/templates.service';

// CORREÇÃO consent-crítica (fix/meta-optout-codes): este arquivo TINHA um
// `META_OPT_OUT_CODES = ['131026', '131047']` próprio que disparava REVOKE
// GLOBAL de consentimento — suprimindo o contato para TUDO, inclusive UTILITY.
// Doc oficial da Meta (developers.facebook.com/documentation/business-messaging/
// whatsapp/support/error-codes):
//   - 131026 "Message Undeliverable": falha de ENTREGA, não uma revogação
//     dirigida à organização. Medido ao vivo (broadcast de 120: 36/37 falhas):
//     fortemente correlacionado com o titular ter desligado MARKETING no
//     próprio app — um toggle de PLATAFORMA, não uma declaração À organização.
//     UTILITY continua entregando (ver 130472 irmão: "Utility templates are
//     not affected"). Já tratado como inalcançável-para-MARKETING, escopado
//     (ver marketing-reachability.ts) — isto é o suficiente.
//   - 131047 "Re-engagement message": janela de atendimento de 24h expirada
//     (tentativa de mensagem livre fora da janela). Não tem NADA a ver com
//     opt-out — é erro transitório/de janela; a mensagem PT-BR (twilio- e
//     zernio-error-mapper) já orienta a usar um template aprovado.
// `ConsentEvent` é um registro JURÍDICO do que a pessoa disse À ORGANIZAÇÃO —
// um toggle do WhatsApp ou uma janela expirada não são isso.
//
// Os opt-outs REAIS que a Meta/Twilio reportam (ex.: Meta 131050 "recipient
// stopped receiving marketing messages", Twilio 21610/63020/63024/63032) já
// são cobertos por `isTwilioOptOutCode`, cuja tabela é COMPARTILHADA entre
// provedores (os códigos 13xxxx são da Meta e chegam por qualquer canal
// cloud — TWILIO, META direto, ou ZERNIO repassando o platformError da Meta).
// Não havia necessidade de uma lista local separada.

const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  WAITING_INSTANCE: 0,
  SENDING: 0, // claimed, pre-send — a 'sent'/'delivered' ack must still advance it
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  RECEIVED: 99, // inbound messages are terminal — never overwritten by outbound status acks
  FAILED: 99,
  CANCELLED: 99,
  // Linhas de contabilização do gate — nunca enviadas, logo nunca recebem ack;
  // terminais por segurança (nenhum status pode sobrescrevê-las).
  SKIPPED_NO_OPTIN: 99,
  SKIPPED_NO_CONSENT: 99,
  SKIPPED_SUPPRESSED: 99,
};

const VALID_MESSAGE_STATUS = new Set<string>(Object.values(MessageStatus));

/**
 * A linha que o processamento de um ack de status manipula: a Message + o
 * telefone do contato (necessário no opt-out por código do provedor, que chaveia
 * a supressão pelo phoneHash, não pelo contactId).
 *
 * Nomeada porque agora ela vem de DOIS caminhos — o `findUnique` pelo wamid (o
 * de sempre) e o resgate do broadcast por TELEFONE (ZW) — e os dois têm de
 * devolver exatamente a mesma forma.
 */
type StatusAckMessage = Prisma.MessageGetPayload<{
  include: { contact: { select: { phoneE164: true } } };
}>;

function shouldUpdate(currentStatus: string, newStatus: string): boolean {
  if (STATUS_RANK[currentStatus] === 99) return false; // terminal
  const currentRank = STATUS_RANK[currentStatus] ?? -1;
  const newRank = STATUS_RANK[newStatus] ?? -1;
  if (newRank === 99) return true; // terminal status (FAILED/CANCELLED) wins
  return newRank > currentRank;
}

/**
 * ZW — os status em que uma Message de BROADCAST ainda pode ser casada por
 * TELEFONE (ver `matchBroadcastMessageByPhone`).
 *
 * O que está FORA é o ponto: `SKIPPED_NO_CONSENT`, `SKIPPED_SUPPRESSED`,
 * `SKIPPED_NO_OPTIN`, `CANCELLED` e `RECEIVED` NUNCA são candidatos. As linhas do
 * gate são a PROVA de que o sistema recusou enviar sem autorização — nenhum
 * evento vindo do provedor pode encostar nelas. (Elas também nascem sem
 * `zernioBroadcastId`, então o predicado do broadcast já as excluiria; esta lista
 * é a segunda tranca, explícita.)
 *
 * READ e FAILED ficam DENTRO de propósito: um evento atrasado para uma linha já
 * assentada ainda pode CARIMBAR o wamid (útil para os eventos seguintes), e a
 * máquina monotônica se encarrega de não rebaixar o status.
 */
const BROADCAST_MATCHABLE_STATUSES: MessageStatus[] = [
  MessageStatus.QUEUED,
  MessageStatus.WAITING_INSTANCE,
  MessageStatus.SENDING,
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
  MessageStatus.READ,
  MessageStatus.FAILED,
];

/**
 * ZW — a janela do casamento por telefone, contada a partir do `sentAt` que o
 * orgamind carimbou no DISPARO do broadcast.
 *
 * 48h e não "alguns minutos": o broadcast do Zernio é LENTO (medido ao vivo —
 * 1.015 destinatários, 35 min depois do início, `sentCount: 3`), então o
 * `delivered` de alguém pode chegar MUITAS horas depois do disparo. E 48h e não
 * "para sempre": passado isso, uma linha ainda sem wamid é uma linha que nunca
 * recebeu webhook — casá-la com um evento NOVO seria inventar história.
 */
const BROADCAST_MATCH_WINDOW_MS = 48 * 3600 * 1000;

/**
 * Teto de candidatos lidos no resgate por telefone (K6). A decisão é binária —
 * "há mais de uma campanha entre os candidatos?" —, então basta uma amostra
 * pequena: um valor baixo já responde a pergunta sem materializar uma lista sem
 * limite num webhook que roda a cada ack.
 */
const BROADCAST_MATCH_CANDIDATE_LIMIT = 10;

/**
 * Tolerância de relógio ao descartar o candidato "impossível" (disparado DEPOIS
 * do ack). O `occurredAt` vem do PROVEDOR e o `sentAt` é nosso: 5 min absorvem
 * a diferença normal entre dois relógios sem absorver um disparo inteiro.
 */
const BROADCAST_ACK_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A distância dentro da qual duas campanhas empatam de verdade pelo mesmo ack.
 * Um ack chega segundos a minutos depois do envio, então dois disparos
 * separados por mais de 10 min já são distinguíveis pelo relógio; abaixo disso
 * a escolha seria chute, e chute vira prova de entrega da campanha errada.
 */
const BROADCAST_ACK_TIEBREAK_MS = 10 * 60 * 1000;

// Reject `sent` events older than this. Tight window because outbound sends
// are timestamped at the moment we hand the message to the provider, so any
// large skew is genuinely suspicious replay traffic.
const SENT_REPLAY_WINDOW_SECONDS = 300;
// `delivered`/`read` events legitimately arrive much later — the recipient
// may have been offline for hours. Idempotency is already guaranteed by the
// per-event Redis dedupe key, so this window only filters absurd skew.
const ASYNC_REPLAY_WINDOW_SECONDS = 72 * 3600;

// Match ONLY when the whole (trimmed) message is an unsubscribe keyword. A
// prefix match would opt out engaged contacts whose reply merely *begins* with
// a common Portuguese word like "não"/"cancelar"/"parar" (e.g. "Não consigo
// comparecer, pode remarcar?") — a real bug that silently unsubscribed them.
// T8 core set: PARAR|PARE|SAIR|CANCELAR|STOP (+ legacy extras kept — removing
// them would regress contacts that already learned those words).
const STOP_REGEX =
  /^(stop|sair|cancelar|parar|pare|cancel|nao|não|opt[-\s]?out)$/i;

// T8 — reversão de opt-out: keyword exata (palavra única, trim).
const OPT_BACK_IN_REGEX = /^voltar$/i;

// Confirmação free-form do opt-out em canal TWILIO. Enviada best-effort logo
// após o inbound (a janela de 24h acabou de abrir, então free-form é permitido).
//
// C1 — este texto NOMEIA a organização porque ele é o `evidenceText` do GRANT
// que o VOLTAR grava (spec §2.7 regra 5): é literalmente o que o titular leu
// antes de decidir voltar. Um "você não receberá mais mensagens nossas" anônimo
// não prova de QUEM a pessoa voltou a aceitar mensagens.
//
// É FUNÇÃO, e não constante, porque o nome vem de `Organization` (configuração,
// semeada do env e editável em Configurações). Era uma constante com o nome de
// um cliente dentro — e uma mensagem enviada ao titular nomeando a organização
// errada é, além de confusa, uma prova que não prova nada.
export function optOutConfirmationText(orgName: string): string {
  return (
    `Pronto: ${orgName} não vai mais te enviar mensagens. ` +
    'Se mudar de ideia, responda VOLTAR e você volta a receber o que já recebia antes.'
  );
}

// Staggered delays for the post-pair history import. Baileys streams the
// on-link history in PROGRESSIVE batches over a minute+, so a single early
// sync only catches the first chats. We re-run at increasing offsets to pick
// up later batches; the sync is idempotent (dedups by providerMessageId), so
// re-runs are cheap and only import what's newly arrived.
const HISTORY_SYNC_DELAYS_MS = [15_000, 90_000, 300_000];

// connection.update dedup window. We only collapse a same-state event that
// repeats within this window of the last recorded event (a true Evolution
// burst). A same-state event after a longer gap is a genuine re-report and is
// always recorded — otherwise a fresh `open` on reconnect gets swallowed by the
// previous session's stale `open` (which never got a `close` when the app was
// down), leaving the UI stuck "disconnected" while the socket is live.
const CONNECTION_DEDUP_WINDOW_MS = 60_000;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    private readonly config: ConfigService<Env>,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly connectionRepo: WhatsappProvidersRepository,
    private readonly campaigns: CampaignsService,
    private readonly chatIngest: ChatIngestService,
    private readonly chatEvents: ChatEventsService,
    private readonly organization: OrganizationService,
    // ZC — o webhook `whatsapp.template.status_updated` atualiza o catálogo na
    // hora (sem polling: o balde do Zernio é o MESMO do envio).
    private readonly templates: TemplatesService,
    @InjectQueue(QUEUE_NAMES.CHAT_HISTORY_SYNC)
    private readonly historyQueue: Queue<ChatHistorySyncJob>,
    private readonly consent: ConsentService,
  ) {}

  /**
   * Persists a connection lifecycle event, deduplicating burst webhooks
   * that Evolution fires in rapid succession with the same state.
   * Only inserts a new row when the state actually changed.
   */
  private async persistConnectionEvent(
    instanceId: string,
    state: string,
    reasonCode: number | null,
    occurredAt: Date,
  ): Promise<void> {
    const last = await this.connectionRepo.findLastEvent(instanceId);
    if (
      last &&
      last.state === state &&
      last.occurredAt &&
      Math.abs(occurredAt.getTime() - new Date(last.occurredAt).getTime()) <
        CONNECTION_DEDUP_WINDOW_MS
    ) {
      // Same state repeated within the burst window — dedup: skip. (A same-state
      // event after a longer gap falls through and IS recorded.)
      this.logger.debug(
        { instanceId, state },
        'connection.update deduped (same-state burst)',
      );
      return;
    }
    await this.connectionRepo.createEvent({
      instanceId,
      state,
      reasonCode,
      // Stamp the event's own time (from the webhook's date_time) so out-of-order
      // delivery can't make an older event look like the latest state.
      occurredAt,
    });
    this.logger.log(
      { instanceId, state, reasonCode },
      'connection.update event persisted',
    );
    // A genuine transition to `open` (re-pair / reconnect) — auto-import the
    // recent history, like WhatsApp Web on link. No static jobId: a same-state
    // `open` burst is already collapsed at the event level (the dedup window
    // above), and the sync is idempotent. Using a fixed jobId would let a
    // retained completed job (removeOnComplete keeps it for a while) silently
    // dedup a LATER re-pair — defeating the whole point.
    if (state === 'open') {
      // Stagger several idempotent syncs to catch progressively-arriving
      // on-link history batches (a single early sync misses later ones).
      for (const delay of HISTORY_SYNC_DELAYS_MS) {
        try {
          await this.historyQueue.add('sync', { instanceId }, { delay });
        } catch (err) {
          this.logger.warn(
            { err, instanceId, delay },
            'failed to enqueue history sync on connect',
          );
        }
      }
    }
  }

  verifySignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): boolean {
    if (!signatureHeader) return false;
    if (!signatureHeader.startsWith('sha256=')) return false;
    const secret = this.config.get('META_APP_SECRET', { infer: true });
    if (!secret) return false;

    const expected =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    // NOTE: this Meta HMAC path is effectively DEAD in production — ORGAMIND runs
    // the `evolution` provider, which does NOT cryptographically sign webhooks
    // (it's authenticated by the apikey guard in the controller + IP reachability,
    // not HMAC). This method only runs under the `meta` provider.
    //
    // The length guard below is REQUIRED, not a leak: `timingSafeEqual` throws
    // when the two buffers differ in length, so we must reject mismatched
    // lengths first. The HMAC hex output is a fixed width (`sha256=` + 64 hex
    // chars), so `expected.length` is a constant and reveals nothing about the
    // secret. The actual byte comparison is still constant-time.
    if (expected.length !== signatureHeader.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  }

  verifyChallenge(mode: string, token: string, challenge: string): string {
    const expected = this.config.get('META_WEBHOOK_VERIFY_TOKEN', {
      infer: true,
    });
    if (mode === 'subscribe' && token === expected) return challenge;
    throw new ValidationError(
      'Invalid verify token',
      undefined,
      'webhook.invalid_verify_token',
    );
  }

  /**
   * @param provider The webhook payload's own provider, resolved by the
   * controller from the payload SHAPE (see `detectWhatsappWebhookProvider` in
   * webhooks.controller.ts) or fixed to 'TWILIO' for the Twilio route.
   * Status-ack parsing routes to that provider's adapter via `parseWebhookFor`
   * — correct even when a deploy has multiple provider channels active at
   * once. Both webhook controllers ALWAYS resolve and pass a provider before
   * calling `process()` (an unrecognized payload shape is rejected earlier,
   * before `process()` is ever invoked) — `provider` stays optional here only
   * because `processStopKeywords` still has its own legacy no-provider
   * fallback (see below); a status-ack call without a provider now processes
   * no events instead of falling back to a deploy-global legacy adapter.
   */
  async process(
    payload: unknown,
    instanceId?: string,
    provider?: ChannelProvider,
  ): Promise<void> {
    await this.processConnectionEvent(payload, instanceId);
    await this.processStatusUpdates(payload, provider, instanceId);
    await this.processTemplateStatus(payload, provider, instanceId);
    await this.processStopKeywords(payload, provider, instanceId);
    // Persist inbound/outbound-echo messages into the chat inbox. Evolution-only
    // (Meta returns no chat messages); failures must not break webhook handling.
    try {
      // Only pass `provider` through when given, so a legacy (no-provider) call
      // keeps calling ChatIngestService with its original 2-arg signature —
      // existing Evolution-only callers are unaffected.
      if (provider) {
        const { parsed } = await this.chatIngest.ingestFromWebhook(
          payload,
          instanceId,
          provider,
        );
        this.warnSilentChatDrop(payload, provider, instanceId, parsed);
      } else {
        await this.chatIngest.ingestFromWebhook(payload, instanceId);
      }
    } catch (err) {
      this.logger.warn({ err }, 'chat ingest from webhook failed');
    }
  }

  /**
   * ★ A PERDA SILENCIOSA NÃO PODE VOLTAR (C17/C19).
   *
   * O modo de falha: um provider cujo adapter não implementa
   * `parseInboundChatMessages` faz o roteador devolver `[]` —
   * `?.parseInboundChatMessages?.(payload) ?? []` RETORNA, não lança —, então
   * nem o try/catch que envolve o ingest (o único log daquele trecho) dispara.
   * Em produção isso significou 70 de 74 webhooks do GoZap sem efeito nenhum,
   * todos HTTP 200: o operador via só a bolha do disparo, e o suporte procurava
   * no log por um erro que nunca existiu.
   *
   * O alarme é comparativo, e é isso que o torna preciso: só grita quando o
   * parser de OPT-OUT (`parseInboundMessages`, alimentado pelo MESMO payload)
   * reconheceu uma mensagem de entrada e o parser do CHAT não devolveu nada. Um
   * recibo de status, um evento de conexão ou uma mensagem de grupo (que os
   * dois parsers recusam igual) devolvem `[]` legitimamente e continuam
   * silenciosos — senão o alarme viraria ruído e ninguém o leria.
   *
   * Por que log e não `WebhookDropsService`: aquele contador existe para
   * "chegou webhook de uma conta SEM CANAL", e `listUnresolved` esconde
   * automaticamente todo drop cujo `accountRef` casa com um canal ativo. Aqui o
   * canal EXISTE — o alerta ou seria escondido na hora (inútil) ou ficaria
   * pendurado para sempre sem forma de resolver (pior). O instrumento certo
   * para "o canal existe e o código não sabe ler" é o log.
   *
   * SEM PII: provider, canal e contagem. Telefone, nome de perfil e texto de
   * eleitor NÃO entram em log — numa campanha eleitoral até "quem escreveu" é
   * dado sensível.
   */
  private warnSilentChatDrop(
    payload: unknown,
    provider: ChannelProvider,
    instanceId: string | undefined,
    parsed: number,
  ): void {
    if (parsed > 0) return;
    const recognized = this.wa.parseInboundMessagesFor(provider, payload).length;
    if (recognized === 0) return;
    this.logger.warn(
      { provider, instanceId, recognized, parsed },
      'MENSAGEM DE ENTRADA DESCARTADA: o provedor reconheceu a mensagem para o opt-out mas o parser do chat não devolveu nada — a resposta do eleitor NÃO chegou à inbox (adapter sem parseInboundChatMessages, ou shape novo do provedor)',
    );
  }

  private async processConnectionEvent(
    payload: unknown,
    instanceId?: string,
  ): Promise<void> {
    // Persist connection lifecycle events for health tracking.
    const raw = payload as {
      event?: string;
      instance?: string | { instanceName?: string };
      data?: { state?: string; statusReason?: number | null };
      date_time?: string;
    } | null;
    if (raw?.event === 'connection.update' && instanceId) {
      const state = raw.data?.state;
      if (state === 'open' || state === 'connecting' || state === 'close') {
        const reasonCode =
          typeof raw.data?.statusReason === 'number'
            ? raw.data.statusReason
            : null;
        // Use the event's own timestamp (Evolution stamps it on the body) so
        // out-of-order webhook delivery doesn't corrupt the latest-state read.
        const parsed = raw.date_time ? new Date(raw.date_time) : null;
        const occurredAt =
          parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
        await this.persistConnectionEvent(
          instanceId,
          state,
          reasonCode,
          occurredAt,
        );
      }
      return;
    }

    // GOZAP — outro nome de evento e outro shape. O envelope é
    // `{event:'connection', instance_id, data:{status, reason}, timestamp}` e
    // `status` observado em produção é `connected` | `disconnected` |
    // `syncing`. O gate acima (`connection.update` + `data.state`) é literal do
    // Evolution: até 2026-08-07 todo evento de conexão do GoZap era recebido,
    // autenticado, respondido 200 e DESCARTADO — o canal pareado nunca ficava
    // "online" para o roteador de envio.
    if (raw?.event === 'connection' && instanceId) {
      const gozap = payload as { data?: { status?: string } } | null;
      const status = gozap?.data?.status;
      // `syncing` é transitório (reconexão de websocket, ~10s): NÃO vira
      // evento, senão cada oscilação derrubaria o canal e parquearia envios.
      const state =
        status === 'connected'
          ? 'open'
          : status === 'disconnected'
            ? 'close'
            : null;
      if (state) {
        await this.persistConnectionEvent(instanceId, state, null, new Date());
      }
    }
  }

  /**
   * ZC — `whatsapp.template.status_updated`: a Meta aprovou/reprovou/pausou um
   * template, e o status muda NA HORA.
   *
   * O orgamind já estava INSCRITO neste evento no painel do Zernio, mas o
   * `parseWebhook` o descartava (o STATUS_MAP só cobre `message.*`): o sinal
   * chegava e ia para o lixo. É este handler que permite manter a reconciliação
   * como rede de segurança espaçada (1h) em vez de polling — o balde do Zernio é
   * de 60 req/min POR CHAVE e é o MESMO do envio.
   *
   * Best-effort: uma falha aqui não pode derrubar o processamento do resto do
   * webhook (nem fazer o Zernio retentar 7x um erro nosso).
   */
  private async processTemplateStatus(
    payload: unknown,
    provider?: ChannelProvider,
    instanceId?: string,
  ): Promise<void> {
    if (provider !== 'ZERNIO' || !instanceId) return;
    const event = parseZernioTemplateStatusEvent(payload);
    if (!event) return;

    try {
      const applied = await this.templates.applyZernioTemplateStatus({
        channelId: instanceId,
        ...event,
      });
      if (applied) {
        this.logger.log(
          `template "${event.metaName}" (${event.language}) → ${
            event.status ?? '?'
          } via webhook do Zernio`,
        );
      } else {
        // O webhook pode chegar antes do 1º sync, ou o template pode ter nascido
        // fora do orgamind. O job de reconciliação o traz depois — não é erro.
        this.logger.warn(
          `template "${event.metaName}" (${event.language}) desconhecido no canal ${instanceId}; o sync de reconciliação o trará`,
        );
      }
    } catch (err) {
      this.logger.warn({ err }, 'zernio template status update failed');
    }
  }

  /**
   * ZW — ★ O CASAMENTO DO BROADCAST, POR TELEFONE — e o CARIMBO do wamid.
   *
   * O `POST /broadcasts/{id}/send` do Zernio devolve `{success, status, sent,
   * failed, recipientCount}` e **nenhum wamid**. As Messages do broadcast nascem,
   * portanto, SEM `providerMessageId` — e o webhook de status, que chega em tempo
   * real E TRAZ o wamid, não casa com linha nenhuma. Era o buraco: os eventos
   * chegavam, não achavam nada, e a campanha inteira ficava congelada em SENT.
   *
   * Aqui a linha é achada pelo TELEFONE e o wamid é CARIMBADO nela. A partir daí
   * os eventos seguintes (`delivered`, `read`) casam pelo `providerMessageId`,
   * pelo caminho que já existia — este fallback roda UMA vez por mensagem.
   *
   * ## O que impede este casamento de ROUBAR a mensagem errada
   *
   * 1. `zernioBroadcastId: { not: null }` — só linhas que saíram POR UM
   *    BROADCAST. O envio 1-a-1 (Evolution/Twilio/Zernio inbox) grava o wamid no
   *    POST e nunca passa por aqui. E as linhas do GATE (`SKIPPED_NO_CONSENT`,
   *    `SKIPPED_SUPPRESSED`, `CANCELLED` por opt-out) nascem SEM
   *    `zernioBroadcastId` — este predicado sozinho já as torna intocáveis. Elas
   *    são a PROVA de que o sistema recusou enviar sem autorização; num processo
   *    do TSE, a defesa do cliente.
   * 2. `providerMessageId: null` — nunca rouba uma linha JÁ casada com outro
   *    wamid. É também o guarda da corrida (o campo é `@unique`).
   * 3. `instanceId` — só o canal que RECEBEU o webhook.
   * 4. a JANELA — só um disparo recente (ver BROADCAST_MATCH_WINDOW_MS).
   * 5. ★ K6 — CAMPANHA INEQUÍVOCA. Este era o buraco: o casamento não olhava
   *    `campaignId` nenhum e desempatava por `sentAt desc` — uma HEURÍSTICA
   *    assumida em comentário, não uma garantia. Com a mesma pessoa em duas
   *    campanhas irmãs no mesmo canal dentro de 48h (cenário que os achados de
   *    TOCTOU já mostram ser possível), o `delivered` da campanha ANTIGA era
   *    carimbado na linha da campanha NOVA: o wamid e o DELIVERED iam para a
   *    campanha errada, e a linha certa ficava SENT sem wamid PARA SEMPRE (o
   *    reconciliador ignora linha sem `providerMessageId`). Para o dono, os
   *    números de "quem recebeu" por campanha — base da coluna "Campanhas
   *    recebidas" e da prova de entrega num questionamento do TSE — trocavam de
   *    lugar entre campanhas.
   *
   *    O DESEMPATE (revisto na 2ª rodada). A 1ª correção recusava o carimbo
   *    sempre que houvesse duas campanhas entre os candidatos — e isso trocou
   *    "carimba a errada" por "não carimba nada", que também perde a prova.
   *    Pior: como o filtro já exige `providerMessageId: null`, todo candidato
   *    ANTIGO é por definição uma linha cujo ack SE PERDEU, então cada ack
   *    perdido passava a ENVENENAR a campanha seguinte para aquela pessoa
   *    durante 48h — num cliente que dispara para bases sobrepostas o tempo
   *    todo, o estrago se acumula exatamente na métrica que o K6 protege.
   *
   *    O critério que DESEMPATA é o RELÓGIO DO ACK (`occurredAt`), que estava
   *    disponível no evento e não era usado:
   *      a) um ack não confirma um envio que ainda não aconteceu — candidato
   *         com `sentAt` depois do ack (fora da tolerância de relógio) sai;
   *      b) entre os possíveis, vence o mais PRÓXIMO do ack;
   *      c) só é AMBÍGUO quando o melhor de OUTRA campanha está a menos de
   *         `BROADCAST_ACK_TIEBREAK_MS` de distância do vencedor — aí sim as
   *         duas campanhas dispararam quase juntas e carimbar seria chutar.
   *
   *    Dentro de UMA campanha nada disso importa: a atribuição por CAMPANHA —
   *    que é o que a métrica e a prova medem — é inequívoca (é o caso da mesma
   *    pessoa com duas linhas Contact por causa do 9º dígito).
   */
  private async matchBroadcastMessageByPhone(
    phone: string,
    instanceId: string,
    ackAt: Date,
  ): Promise<StatusAckMessage | null> {
    const candidates = await this.prisma.message.findMany({
      where: {
        zernioBroadcastId: { not: null },
        providerMessageId: null,
        instanceId,
        // As DUAS formas do 9º dígito: o Zernio pode reportar a legada de 8
        // enquanto o contato está gravado na moderna de 9 (ou o contrário). Um
        // lookup exato perderia a entrega em silêncio.
        contact: { phoneE164: { in: brazilianPhoneVariants(phone) } },
        status: { in: BROADCAST_MATCHABLE_STATUSES },
        sentAt: { gte: new Date(Date.now() - BROADCAST_MATCH_WINDOW_MS) },
      },
      orderBy: { sentAt: 'desc' },
      // Teto: o desempate só precisa saber SE há mais de uma campanha entre os
      // candidatos, nunca materializar a lista inteira.
      take: BROADCAST_MATCH_CANDIDATE_LIMIT,
      include: { contact: { select: { phoneE164: true } } },
    });
    if (candidates.length === 0) return null;

    const ack = ackAt.getTime();
    const gap = (m: { sentAt: Date | null }) =>
      Math.abs(ack - (m.sentAt?.getTime() ?? 0));

    // (a) Um ack não confirma um envio que ainda não aconteceu. Se o relógio do
    // provedor estiver adiantado a ponto de NENHUM candidato ser possível,
    // volta a considerar todos — perder o ack por causa de relógio seria pior.
    const possible = candidates.filter(
      (c) =>
        c.sentAt != null &&
        c.sentAt.getTime() <= ack + BROADCAST_ACK_CLOCK_SKEW_MS,
    );
    const pool = possible.length > 0 ? possible : candidates;

    // (b) O mais próximo do ack no tempo. Ordena aqui em vez de confiar no
    // `sentAt desc` do banco: com um ack ATRASADO (o destinatário estava
    // offline), "mais recente" e "contemporâneo ao ack" não são a mesma linha.
    const byProximity = [...pool].sort((a, b) => gap(a) - gap(b));
    const best = byProximity[0];

    // (c) Ambíguo é só o EMPATE REAL: a melhor linha de outra campanha quase
    // tão perto do ack quanto a vencedora. Uma órfã de ontem não empata com um
    // disparo de agora.
    const rival = byProximity.find(
      (c) => (c.campaignId ?? null) !== (best.campaignId ?? null),
    );
    if (rival && gap(rival) - gap(best) <= BROADCAST_ACK_TIEBREAK_MS) {
      this.logger.warn(
        {
          instanceId,
          candidates: candidates.length,
          campaignIds: [
            best.campaignId ?? '(sem campanha)',
            rival.campaignId ?? '(sem campanha)',
          ],
          bestGapSec: Math.round(gap(best) / 1000),
          rivalGapSec: Math.round(gap(rival) / 1000),
        },
        'ACK DE BROADCAST AMBÍGUO: duas campanhas dispararam para a mesma pessoa quase no mesmo instante e o ack cabe nas duas — nenhuma foi carimbada (atribuir a errada trocaria a prova de entrega entre campanhas)',
      );
      return null;
    }
    return best;
  }

  /**
   * ZW — CARIMBA o wamid na linha do broadcast, à prova da corrida.
   *
   * `Message.providerMessageId` é `@unique`, e `message.sent` / `message.delivered`
   * do MESMO wamid podem chegar quase juntos: os dois erram o `findUnique`, os
   * dois acham o MESMO candidato por telefone e os dois tentam carimbar.
   *
   * O `updateMany` escopado por `providerMessageId: null` faz o BANCO arbitrar:
   * um carimba (count 1), o outro não casa nenhuma linha (count 0). Quem perde
   * NÃO desiste e NÃO explode — RELÊ a linha pela chave (que agora existe) e
   * segue pelo caminho normal. O `catch` cobre o mesmo desfecho quando a corrida
   * estoura o `@unique` (P2002) em vez de simplesmente não casar.
   */
  private async stampBroadcastWamid(
    candidate: StatusAckMessage,
    wamid: string,
  ): Promise<StatusAckMessage | null> {
    const byWamid = () =>
      this.prisma.message.findUnique({
        where: { providerMessageId: wamid },
        include: { contact: { select: { phoneE164: true } } },
      });

    try {
      const stamped = await this.prisma.message.updateMany({
        where: { id: candidate.id, providerMessageId: null },
        data: { providerMessageId: wamid },
      });
      if (stamped.count === 0) {
        // Alguém carimbou primeiro (o outro evento do mesmo wamid). Relê.
        return byWamid();
      }
    } catch (err) {
      this.logger.warn(
        { err, messageId: candidate.id, providerMessageId: wamid },
        'ZW: carimbo do wamid do broadcast colidiu — relendo pela chave',
      );
      return byWamid();
    }

    this.logger.log(
      `ZW: broadcast casado por telefone — wamid ${wamid} carimbado na mensagem ${candidate.id}`,
    );
    // Sem reler: a linha é a que acabamos de carimbar.
    return { ...candidate, providerMessageId: wamid };
  }

  private async processStatusUpdates(
    payload: unknown,
    provider?: ChannelProvider,
    instanceId?: string,
  ): Promise<void> {
    // The legacy no-provider fallback (`this.wa.parseWebhook(payload)`, routed
    // through the deploy-global MESSAGE_PROVIDER) was removed in F6: both
    // webhooks.controller.ts and twilio-webhooks.controller.ts always resolve
    // a concrete provider before calling `process()`, so this branch was dead
    // in production. An omitted provider now yields no events rather than
    // silently guessing an adapter.
    const events = provider ? this.wa.parseWebhookFor(provider, payload) : [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const event of events) {
      const eventSec = Math.floor(event.occurredAt.getTime() / 1000);
      const replayWindow =
        event.status === 'sent'
          ? SENT_REPLAY_WINDOW_SECONDS
          : ASYNC_REPLAY_WINDOW_SECONDS;
      if (Math.abs(nowSec - eventSec) > replayWindow) {
        this.logger.warn(
          {
            providerMessageId: event.providerMessageId,
            status: event.status,
            eventSec,
            nowSec,
          },
          'Webhook event outside replay window, skipping',
        );
        continue;
      }

      const dedupeKey = `webhook:${event.providerMessageId}:${event.status}`;
      const isNew = await this.redis.set(dedupeKey, '1', 'EX', 72 * 3600, 'NX');
      if (!isNew) continue;

      let message = await this.prisma.message.findUnique({
        where: { providerMessageId: event.providerMessageId },
        // `contact` é necessário no opt-out por código do provedor: a supressão
        // é chaveada pelo phoneHash, não pelo contactId.
        include: { contact: { select: { phoneE164: true } } },
      });

      // ZW — O RESGATE DO BROADCAST. O wamid é desconhecido porque o `/send` do
      // broadcast NUNCA o devolveu. Antes de desistir do evento, tenta achar a
      // linha pelo TELEFONE e CARIMBAR o wamid nela.
      //
      // Só entra aqui quem tem `recipientPhone` — ou seja, hoje, só o Zernio. Um
      // evento de Evolution/Twilio (que sempre traz o wamid, e cuja Message
      // sempre tem `providerMessageId` desde o POST) NÃO passa por este caminho:
      // a ausência do campo o desliga inteiro.
      if (!message && event.recipientPhone && instanceId) {
        const candidate = await this.matchBroadcastMessageByPhone(
          event.recipientPhone,
          instanceId,
          event.occurredAt,
        );
        if (candidate) {
          message = await this.stampBroadcastWamid(
            candidate,
            event.providerMessageId,
          );
        }
      }

      if (!message) {
        // The ack arrived before the outbound row was persisted (a `delivered`/
        // `read` can legitimately race ahead of the send pipeline's markSent).
        // Releasing the claimed dedup key lets the provider's later redelivery
        // re-process this event once the row exists — otherwise the 72h key
        // would drop it forever, stranding the message at QUEUED.
        try {
          await this.redis.del(dedupeKey);
        } catch (err) {
          this.logger.warn(
            { err, providerMessageId: event.providerMessageId },
            'failed to release webhook dedup key on message miss',
          );
        }
        continue;
      }

      const newStatus = event.status.toUpperCase();
      if (!VALID_MESSAGE_STATUS.has(newStatus)) {
        this.logger.warn(
          {
            providerMessageId: event.providerMessageId,
            rawStatus: event.status,
          },
          'Webhook event with unknown status, skipping',
        );
        continue;
      }
      if (!shouldUpdate(message.status, newStatus)) {
        this.logger.debug(
          {
            providerMessageId: event.providerMessageId,
            currentStatus: message.status,
            newStatus,
          },
          'Skipping out-of-order webhook status update',
        );
        continue;
      }

      const update: {
        status: MessageStatus;
        errorCode?: string | null;
        errorMessage?: string | null;
        sentAt?: Date;
        deliveredAt?: Date;
        readAt?: Date;
        failedAt?: Date;
        failureReason?: FailureReason | null;
      } = {
        status: newStatus as MessageStatus,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };
      if (event.status === 'sent') update.sentAt = event.occurredAt;
      if (event.status === 'delivered') update.deliveredAt = event.occurredAt;
      if (event.status === 'read') update.readAt = event.occurredAt;
      if (event.status === 'failed') {
        update.failedAt = event.occurredAt;
        update.failureReason = classifyFailure(event.errorCode, provider);
      }

      // Atomic, rank-guarded transition: scope the UPDATE by the set of statuses
      // that must NOT be overwritten (those a fresh read would reject via
      // shouldUpdate). Each status has its own dedupe key, so two acks for the
      // same message can race the read-decide-write; without a DB-level guard a
      // lower-rank ack committing last could clobber a higher one. `notIn`
      // makes the guard part of the WHERE so the DB arbitrates the race.
      const blockedStatuses = Object.keys(STATUS_RANK).filter(
        (s) => !shouldUpdate(s, newStatus),
      ) as MessageStatus[];

      try {
        const updated = await this.prisma.message.updateMany({
          where: { id: message.id, status: { notIn: blockedStatuses } },
          data: update,
        });
        if (updated.count === 0) {
          // A concurrent equal/higher-rank ack already settled the row between
          // our read and this write — nothing changed, so fire no side effects.
          continue;
        }

        // Live-update the chat thread tick when this ack belongs to a conversation.
        if (message.conversationId) {
          await this.chatEvents.publish({
            type: 'message.status',
            conversationId: message.conversationId,
            instanceId: message.instanceId,
            messageId: message.id,
            status: newStatus,
          });
        }

        // ZW — os contadores do espelho do BROADCAST são uma PROJEÇÃO das nossas
        // Messages, e este ack acabou de mudar uma delas. Quem apura o status é
        // quem tem de recontar: o reconciliador roda devagar (5–30 min) e desiste
        // depois de ~11h, e os contadores do Zernio estão congelados/incoerentes
        // (`sentCount: 3` com `deliveredCount: 8`). Sem esta linha, a tela
        // mostraria números velhos — ou zerados — numa campanha que entregou.
        //
        // Best-effort: é um dado DERIVADO (a Message é a prova). Uma falha aqui
        // não pode derrubar o webhook e fazer o Zernio reentregar o evento 7x.
        if (message.zernioBroadcastId) {
          const localBroadcastId = message.zernioBroadcastId;
          try {
            const counters = await recomputeBroadcastCounters(
              this.prisma,
              localBroadcastId,
            );
            await this.prisma.zernioBroadcast.update({
              where: { id: localBroadcastId },
              data: { ...counters, syncedAt: new Date() },
            });
          } catch (err) {
            this.logger.warn(
              { err, zernioBroadcastId: localBroadcastId },
              'ZW: falha recontando os contadores do broadcast (best-effort)',
            );
          }
        }

        // Best-effort: webhook ack might be the last status change for the
        // campaign — try to close it out. Failures are non-fatal.
        if (message.campaignId) {
          this.campaigns
            .maybeCompleteCampaign(message.campaignId)
            .catch((e) =>
              this.logger.warn(
                { err: e },
                'maybeCompleteCampaign from webhook failed',
              ),
            );
        }

        // F2 — flag durável best-effort no Contact (failureCount sempre;
        // lastFailure* só quando a falha é definitiva do destinatário — ver
        // buildContactFailureUpdate). Não pode mudar o desfecho da Message,
        // que já está FAILED com a prova (errorCode/failureReason).
        if (event.status === 'failed' && message.contactId) {
          const contactId = message.contactId;
          try {
            await this.prisma.contact.update({
              where: { id: contactId },
              data: buildContactFailureUpdate(event.errorCode, provider),
            });
          } catch (err) {
            this.logger.warn(
              { err, contactId, errorCode: event.errorCode },
              'F2: falha ao atualizar flag durável de falha do contato (best-effort)',
            );
          }
        }

        // ZE — INALCANÇÁVEL PARA MARKETING (ver marketing-reachability.ts).
        //
        // A falha 131026/130472 chega POR AQUI (o POST de envio devolve
        // 200/accepted; quem diz que a Meta não entregou é o webhook de status),
        // então este é o único ponto onde dá para aprender o fato. Medido ao
        // vivo: 30% da base. Sem gravar isso no CONTATO, toda campanha nova
        // recomeça do zero e queima os mesmos 30% da cota do tier contra a mesma
        // parede.
        //
        // Best-effort de propósito: é um dado DERIVADO (a Message já está FAILED
        // com o código, que é a prova). Uma falha ao gravá-lo não pode derrubar o
        // webhook e fazer a Meta reentregar o evento — o pior caso é o contato
        // continuar pendente e falhar de novo no próximo lote, que é exatamente o
        // comportamento de hoje.
        if (
          event.status === 'failed' &&
          isMarketingUndeliverableCode(event.errorCode) &&
          message.contactId
        ) {
          const code = event.errorCode as string;
          try {
            await this.prisma.contact.update({
              where: { id: message.contactId },
              data: {
                marketingUndeliverableAt: event.occurredAt ?? new Date(),
                marketingUndeliverableCode: code,
                marketingUndeliverableReason:
                  marketingUndeliverableReason(code),
              },
            });
            await this.audit.log(
              'contact.marketing_undeliverable',
              'Contact',
              message.contactId,
              { errorCode: code, providerMessageId: event.providerMessageId },
            );
          } catch (err) {
            this.logger.warn(
              { err, contactId: message.contactId, errorCode: code },
              'ZE: falha ao marcar contato como inalcançável para marketing (best-effort)',
            );
          }
        }

        if (
          event.status === 'failed' &&
          isTwilioOptOutCode(event.errorCode ?? undefined) &&
          message.contactId &&
          message.contact
        ) {
          // O titular bloqueou/parou DENTRO do WhatsApp — quem nos conta é o
          // provedor. É um REVOKE global como qualquer outro (spec §2.7 regra
          // 3): "You must respect all requests (either on or off WhatsApp) by a
          // person to... opt out". Passa pelo ConsentService para virar
          // supressão DURÁVEL, e não só um boolean na linha de Contact que a
          // próxima reimportação de planilha apagaria.
          await this.consent.record({
            contactId: message.contactId,
            phoneE164: message.contact.phoneE164,
            purposeKey: GLOBAL_PURPOSE,
            action: ConsentAction.REVOKE,
            source: ConsentSource.PROVIDER_OPTOUT,
            evidenceText: `Opt-out reportado pelo provedor (código ${event.errorCode ?? 'desconhecido'}).`,
            channelId: message.instanceId,
            suppressionReason: 'provider_optout_code',
            evidence: {
              errorCode: event.errorCode ?? null,
              providerMessageId: event.providerMessageId ?? null,
            },
          });
          // LGPD: track auto opt-outs as audit events. No actor here (event
          // arrived from Meta), so actorId stays null.
          await this.audit.log(
            'contact.auto_opt_out',
            'Contact',
            message.contactId,
            {
              errorCode: event.errorCode,
              providerMessageId: event.providerMessageId,
            },
          );
        }
      } catch (err) {
        // A durable write (or the LGPD auto-opt-out) failed AFTER we claimed the
        // dedupe key. Release the key so the provider's redelivery can
        // re-process this event — otherwise the 72h key would drop it forever,
        // e.g. leaving a `failed`/blocked ack un-opted-out. Then rethrow so the
        // controller surfaces the error and the provider retries.
        try {
          await this.redis.del(dedupeKey);
        } catch (delErr) {
          this.logger.warn(
            { err: delErr, providerMessageId: event.providerMessageId },
            'failed to release webhook dedup key after write failure',
          );
        }
        throw err;
      }
    }
  }

  /**
   * @param provider When given, routes parsing through the channel-aware
   * `parseInboundMessagesFor` (resolves the matching adapter from the
   * registry — needed on a multi-provider deploy, e.g. a Twilio inbound on a
   * deploy that also has Evolution channels). Omitted, falls back to the
   * legacy env-selected `parseInboundMessages`, unchanged for existing callers.
   */
  private async processStopKeywords(
    payload: unknown,
    provider?: ChannelProvider,
    instanceId?: string,
  ): Promise<void> {
    // LGPD: STOP-keyword opt-out. When an inbound message matches a known
    // unsubscribe keyword (or carries the stable `optout` button payload —
    // T8), mark the contact as opted out. Actor is null (the event arrived
    // from the provider on behalf of the contact). VOLTAR reverts.
    const inbound = provider
      ? this.wa.parseInboundMessagesFor(provider, payload)
      : this.wa.parseInboundMessages(payload);
    // Resolved lazily (at most once) — only opt-out/opt-in hits need the
    // channel, and most webhooks contain neither.
    let channel: Channel | null | undefined;
    const resolveChannel = async (): Promise<Channel | null> => {
      if (channel === undefined) {
        channel = instanceId
          ? await this.prisma.channel.findUnique({ where: { id: instanceId } })
          : null;
      }
      return channel;
    };
    for (const msg of inbound) {
      const text = msg.text?.trim() ?? '';
      const isOptOut = STOP_REGEX.test(text) || msg.buttonPayload === 'optout';
      const isOptBackIn = !isOptOut && OPT_BACK_IN_REGEX.test(text);
      if (!isOptOut && !isOptBackIn) continue;
      // Match the contact across BOTH Brazilian 9th-digit forms, exactly as
      // chat-ingest does: Evolution may echo the legacy 8-digit JID while the
      // contact is stored canonically with the extra 9 (or vice-versa). An exact
      // lookup would miss it and the opt-out would be silently dropped (LGPD).
      //
      // I13 — e com o MESMO desempate do resto do sistema. Casar as duas grafias
      // nunca bastou: enquanto os dois gêmeos coexistirem como duas linhas, um
      // `findFirst` sem `orderBy` devolve a que o ÍNDICE entrega primeiro (a
      // legada de 12 díg.), enquanto a audiência da campanha, a planilha e a
      // tela de contatos operam na de 13 (`findByAnyBrForm`). Uma REVOGAÇÃO de
      // "PARAR" gravada no gêmeo errado é um registro jurídico no lugar errado:
      // o cache `ContactConsent`, que é o que o gate de envio lê, fica pendurado
      // numa linha que o disparo não consulta — e a pessoa continua recebendo.
      const { contact } = await resolveContactByAnyBrForm(
        this.prisma,
        msg.fromE164,
      );
      // NÃO fazer `if (!contact) continue` aqui embaixo, na ramificação de
      // opt-out: um número que o orgamind NUNCA VIU, mandando PARAR como primeira
      // mensagem, tem que ter a revogação registrada mesmo assim (LGPD —
      // art. 8º §5º, a revogação não pode depender de já sermos "conhecidos"
      // dele). `ConsentService.record` aceita `contactId: null` e grava a
      // REVOKE + a SuppressionList pelo `phoneHash`, que é durável e nasce
      // ANTES de qualquer Contact existir. VOLTAR continua exigindo um Contact
      // (abaixo) porque `reinstate()` restaura GRANTs por `contactId`, e um
      // número nunca visto não tem nenhum para restaurar.

      // Fonte da verdade = SuppressionList, não o cache Contact.optedOut (que
      // pode estar velho se a linha de Contact foi recriada por importação).
      const suppressed = await this.consent.isSuppressed(msg.fromE164);

      if (isOptBackIn) {
        if (!contact) continue;
        // VOLTAR só age sobre quem está suprimido. E deixa de ser um
        // `optInAt = now()` genérico (que era, por construção, a autorização
        // genérica que o art. 8º §4º anula): levanta a supressão E restaura os
        // GRANTs que estavam ativos imediatamente antes do REVOKE global. Se não
        // havia nenhum, o contato volta a poder ser ATENDIDO, não a receber
        // campanha (spec §2.7 regra 5).
        if (!suppressed) continue;
        const ch = await resolveChannel();
        const restored = await this.consent.reinstate({
          contactId: contact.id,
          phoneE164: contact.phoneE164,
          source: ConsentSource.WA_KEYWORD,
          // O texto que a pessoa LEU antes de decidir voltar.
          evidenceText: optOutConfirmationText(
            (await this.organization.get()).name,
          ),
          channelId: ch?.id ?? null,
          evidence: {
            inboundWamid: msg.providerMessageId ?? null,
            text: msg.text ?? null,
          },
        });
        await this.audit.log('contact.keyword_opt_in', 'Contact', contact.id, {
          text: msg.text,
          providerMessageId: msg.providerMessageId,
          restoredPurposes: restored,
        });
        continue;
      }

      if (suppressed) continue;
      const chForRevoke = await resolveChannel();
      await this.consent.record({
        // `contact` pode ser null (número nunca visto) — a REVOKE global vale
        // do mesmo jeito: `ConsentService.record` chaveia pelo `phoneHash`
        // durável, não pelo `contactId`.
        contactId: contact?.id ?? null,
        phoneE164: contact?.phoneE164 ?? msg.fromE164,
        purposeKey: GLOBAL_PURPOSE, // revoga TODAS as finalidades
        action: ConsentAction.REVOKE,
        source:
          msg.buttonPayload === 'optout'
            ? ConsentSource.WA_BUTTON
            : ConsentSource.WA_KEYWORD,
        evidenceText: msg.text ?? msg.buttonPayload ?? 'optout',
        channelId: chForRevoke?.id ?? null,
        occurredAt: msg.receivedAt,
        suppressionReason:
          msg.buttonPayload === 'optout' ? 'button_optout' : 'keyword_parar',
        evidence: {
          inboundWamid: msg.providerMessageId ?? null,
          text: msg.text ?? null,
        },
      });
      await this.audit.log(
        'contact.stop_keyword_opt_out',
        'Contact',
        contact?.id,
        {
          text: msg.text,
          providerMessageId: msg.providerMessageId,
          trigger: msg.buttonPayload === 'optout' ? 'button' : 'keyword',
        },
      );

      // T8 — confirmação free-form em canal TWILIO. O inbound acabou de abrir
      // a janela de 24h, então free-form é permitido. Best-effort: falha aqui
      // nunca pode derrubar o webhook (o opt-out já foi persistido acima).
      // Dispara mesmo sem `contact` — quem recebe é `msg.fromE164`, não uma
      // FK de Contact.
      const ch = await resolveChannel();
      if (ch?.provider === 'TWILIO') {
        try {
          await this.wa.sendChatTextVia(ch, {
            instanceName: '',
            toE164: msg.fromE164,
            text: optOutConfirmationText((await this.organization.get()).name),
          });
        } catch (err) {
          this.logger.warn(
            { err, contactId: contact?.id ?? null },
            'opt-out confirmation send failed (best-effort)',
          );
        }
      }
    }
  }
}
