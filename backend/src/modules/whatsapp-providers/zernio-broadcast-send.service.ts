import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { CampaignsRepository } from '../campaigns/campaigns.repository';
import { classifyFailure } from '../campaigns/failure-reason';
import { ConsentService } from '../consent/consent.service';
import { mayStillSendToContact } from '../campaigns/campaign-consent-gate';
import { AuditService } from '../../shared/audit/audit.service';
// ★ I9 (revisão de integração) — A CÓPIA MORREU, O COMBINADO FOI CUMPRIDO.
//
// Este arquivo tinha a sua própria `zernioDuplicateGuardWhere`, uma cópia
// deliberada da guarda do worker, com um TODO escrito no topo: "QUANDO OS DOIS
// PACOTES ESTIVEREM NA MAIN, o certo é apagar esta cópia". Eles chegaram
// juntos, e a revisão de integração mostrou o preço de adiar: as duas cópias já
// tinham divergido JUNTAS da rede da audiência na régua da campanha CANCELADA,
// e comparar uma com a outra não acusava nada. Agora é uma função só.
import {
  duplicateGuardWhere,
  DUPLICATE_ERROR_CODE,
} from '../campaigns/duplicate-guard';
import {
  QUEUE_NAMES,
  type SendMessageJob,
  type ZernioBroadcastPollJob,
} from '../queue/queue.constants';
import { ZernioBroadcastClient } from './zernio-broadcast.client';
import { ZernioHttpError, ZernioRateLimitError } from './zernio-api.client';
import { planBroadcastVariables } from './zernio-broadcast-variables';
import { effectiveChunkSize } from './zernio-broadcast-chunk.helper';

/**
 * Os status de `ZernioBroadcast` que ainda podem ser CANCELADOS. Um `completed`
 * já entregou tudo; um `cancelled` já foi cancelado.
 */
const CANCELLABLE_STATUSES = ['draft', 'scheduled', 'sending', 'queued'];

/** O bloqueio de 24h do cap de MARKETING da Meta (131049). Ver send-message.processor. */
const marketingCapKey = (phoneHash: string) => `optout:131049:${phoneHash}`;

/** O código de falha do lote que ficou órfão (o "Reenviar falhas" o recupera). */
const ORPHAN_BATCH_ERROR_CODE = 'zernio.broadcast_dispatch_failed';

/**
 * ★ O MARCADOR da entrega INDETERMINADA — e por que ele é um PREFIXO de texto.
 *
 * Uma linha indeterminada é, no banco, indistinguível de uma linha recém-
 * disparada com sucesso: as duas ficam `SENT` + `zernioBroadcastId` +
 * `providerMessageId` nulo até o webhook chegar. Sem uma marca própria, NENHUMA
 * consulta consegue listá-las — e a instrução "confira o painel do Zernio" vira
 * uma ordem que o operador não tem como executar.
 *
 * `errorCode` está fora de questão de propósito: o código é o vocabulário da
 * FALHA (alimenta `classifyFailure`, a reachability do contato e o "Reenviar
 * falhas"), e esta linha não é uma falha — é uma dúvida. Sobra o `errorMessage`,
 * que já é o texto que o operador lê; um PREFIXO estável o torna consultável
 * (`errorMessage: { startsWith: … }`) sem inventar coluna nem migration.
 */
export const INDETERMINATE_DELIVERY_MARK = '[ENTREGA INDETERMINADA]';

/**
 * O texto EXECUTÁVEL. A versão anterior mandava "conferir o painel do Zernio
 * antes de redisparar esta campanha" — e redisparar não funciona para estas
 * linhas: elas ficam `SENT`, e SENT conta como RECEBIDO no recorte `unreached`
 * (o modo padrão do botão "Disparar novamente" e do tick recorrente). O
 * operador clicaria e teria um no-op silencioso; o único modo que as alcança,
 * `full`, reenviaria para a audiência INTEIRA. O caminho que o produto de fato
 * oferece é outro: listar essas pessoas e criar uma CAMPANHA NOVA só com elas.
 */
export const INDETERMINATE_DELIVERY_MESSAGE =
  `${INDETERMINATE_DELIVERY_MARK} O disparo foi enviado ao Zernio, mas a resposta não chegou ` +
  '(timeout). Não dá para saber se estas pessoas receberam. CONFIRA O PAINEL DO ZERNIO: ' +
  'se o disparo existe lá, nada a fazer. Se NÃO existe, ninguém recebeu — e o botão ' +
  '"Disparar novamente" NÃO resolve (estas linhas contam como enviadas, então o modo ' +
  'padrão as ignora e o modo "para todos" reenviaria para a audiência inteira). O caminho ' +
  'é listar os afetados em GET /api/whatsapp/zernio/indeterminate-deliveries?campaignId=… ' +
  'e criar uma campanha nova só com esses contatos.';

/** O erro relançado pelo dispatch, com os ids que JÁ TÊM outro dono. */
type HandedOffCarrier = { zernioHandedOffMessageIds?: string[] };

/**
 * ★ Quem ficou ÓRFÃO e quem tem DONO.
 *
 * `failOrphanedBatch` roda no `@OnWorkerEvent('failed')`, que só recebe o `job`
 * — e o `job.data.messageIds` é o lote ORIGINAL. Mas nem tudo nele é órfão: no
 * meio do caminho o dispatch pode ter ENTREGUE mensagens a outro dono (o
 * excedente do teto de 24h, re-enfileirado com `delay` nesta mesma fila; e os
 * bloqueados pelo cap 131049, mandados para a fila 1-a-1). Essas continuam
 * QUEUED DE PROPÓSITO, com job vivo esperando por elas.
 *
 * O erro é o único canal entre o dispatch e o `onFailed`, então é nele que a
 * lista viaja. Quando o erro estoura ANTES de qualquer entrega (canal sem
 * profileId, por exemplo), a lista vem vazia e o lote inteiro é resgatado — que
 * é o comportamento correto ali.
 */
function tagHandedOff(err: unknown, handedOff: Set<string>): void {
  if (handedOff.size === 0) return;
  if (typeof err !== 'object' || err === null) return;
  (err as HandedOffCarrier).zernioHandedOffMessageIds = [...handedOff];
}

function readHandedOff(err: unknown): Set<string> {
  if (typeof err !== 'object' || err === null) return new Set();
  return new Set((err as HandedOffCarrier).zernioHandedOffMessageIds ?? []);
}

/**
 * ★ O erro do `POST /broadcasts/{id}/send` DEIXA DÚVIDA sobre a entrega?
 *
 * A pergunta não é "deu erro?" — é **"o Zernio recebeu o disparo?"**. Só há duas
 * respostas aceitáveis, e o padrão é a pessimista:
 *
 * - `false` (NÃO recebeu — provado): o servidor RESPONDEU recusando. Um 4xx com
 *   corpo é a porta batendo na cara da requisição: ela não rodou, nada foi
 *   enviado, e retentar é o certo. O `ZernioRateLimitError` é o mesmo caso — 429
 *   é recusa na porta, e é por isso que é o ÚNICO status que a base retenta
 *   sozinha (ver `ZernioApiClient.post`).
 * - `true` (NÃO SEI): timeout, conexão cortada, 408, 5xx, ou qualquer coisa que
 *   não seja um erro HTTP reconhecível. O servidor pode ter processado o disparo
 *   inteiro e só ter perdido a resposta. Nenhum endpoint de broadcast do Zernio
 *   aceita `Idempotency-Key`, então NÃO EXISTE como perguntar "você já fez isto?"
 *   — e reenviar às cegas é entregar duas vezes.
 *
 * ⚠️ Um `ECONNREFUSED`/`ENOTFOUND` (conexão que nem chegou a existir) É, na
 * verdade, prova de que nada saiu — mas o `ZernioHttpError` só carrega `status` e
 * `body`, e ambos vêm vazios tanto no timeout quanto na recusa de conexão. Sem
 * conseguir distinguir, classificamos como INDETERMINADO: o custo é um lote que
 * não sai (alto e visível, com alarme no Sentry); o custo do erro contrário é
 * propaganda eleitoral duplicada, que não tem desfazer.
 */
export function isSendOutcomeIndeterminate(err: unknown): boolean {
  if (err instanceof ZernioRateLimitError) return false;
  if (err instanceof ZernioHttpError) {
    const status = err.status;
    if (typeof status !== 'number') return true; // timeout / sem resposta
    // 408 é literalmente "eu não recebi seu pedido a tempo" — indeterminado.
    if (status === 408) return true;
    if (status >= 400 && status < 500) return false; // recusado na porta
    return true; // 5xx: o servidor pode ter processado antes de quebrar
  }
  return true;
}

export type DispatchBatchJob = {
  campaignId: string;
  channelId: string;
  messageIds: string[];
  correlationId?: string;
};

/**
 * ★ O CAMINHO DE ESCRITA DO BROADCAST — a campanha do orgamind vira um disparo de
 * verdade no painel do Zernio.
 *
 * NÃO confundir com o `ZernioBroadcastSyncService`, que é o irmão de LEITURA
 * (espelha no orgamind os disparos feitos PELO PAINEL). Este aqui CRIA.
 *
 * ## O que muda, e o que NÃO muda
 *
 * Muda o TRANSPORTE: em vez de N chamadas `POST /inbox/conversations` (uma por
 * pessoa, invisíveis no painel do Zernio), fazemos
 * `POST /broadcasts` → `/recipients` → `/send`.
 *
 * **NÃO muda NADA do que protege as 13.400 pessoas.** Este serviço é escrito para
 * que as invariantes sobrevivam intactas ao novo transporte:
 *
 * 1. **O gate roda POR CONTATO, ANTES de montar o broadcast** — e grava a linha
 *    `SKIPPED_NO_CONSENT` de CADA pessoa pulada. Essa linha é a PROVA de que o
 *    sistema recusou enviar sem autorização; num processo do TSE é a DEFESA do
 *    cliente. Ela NUNCA vira contador agregado. O gate é o MESMO do 1-a-1
 *    (`mayStillSendToContact`) — uma fonte, nenhuma cópia.
 * 2. **O claim atômico (QUEUED→SENDING) roda por mensagem**, igual ao 1-a-1:
 *    quem perde o claim não entra no broadcast. É o que impede o envio duplicado
 *    quando o BullMQ retenta.
 * 3. **O teto do tier (2.000 únicos/24h) é contado pelo ORGAMIND**, na janela
 *    ROLANTE. O Zernio não sabe do nosso tier, e estourar o teto derruba o
 *    quality rating do número — que já teve display name reprovado pela Meta.
 * 4. **O 1-a-1 continua sendo o PADRÃO e o FALLBACK.** Quando o broadcast não
 *    pode expressar a campanha (variável por contato — ver
 *    `planBroadcastVariables`), este serviço NÃO improvisa: devolve as mensagens
 *    para a fila 1-a-1, que sabe fazer aquilo direito.
 *
 * ## ⚠️ O PACING — MEDIDO, e o número é RUIM
 *
 * A incógnita era se o Zernio espaça as mensagens ou joga tudo de uma vez na Meta
 * (disparo frio e rápido é o que queimou os números do Evolution DESTE cliente).
 * A resposta, medida ao vivo em 13/07 num broadcast REAL de **1.015
 * destinatários**: 35 minutos depois de iniciado, o disparo tinha `sentCount: 3`
 * e ~9 entregas confirmadas por webhook.
 *
 * Ele não é rápido demais — ele é **LENTÍSSIMO**, e isso pode inviabilizar o caso
 * de uso: nesse ritmo, os 2.000/dia do tier levariam DIAS. O número exato não é
 * confiável (os contadores do Zernio estão quebrados; a contagem boa é a dos
 * webhooks), mas a ordem de grandeza é essa e não há solução aqui dentro — é uma
 * decisão de PRODUTO (medir com um disparo controlado e, se se confirmar, o 1-a-1
 * do orgamind, que faz ≤ 1 msg/s = 3.600/h, é ORDENS DE GRANDEZA mais rápido).
 *
 * ## O TAMANHO do disparo (validado na doc em 13/07)
 *
 * Não existe limite por broadcast nem por campanha — nem no Zernio (OpenAPI e
 * doc completa não declaram nenhum; o plano "não tem limite de posts") nem na
 * Meta (o messaging limit é por PORTFÓLIO, únicos/24h rolantes). O único teto
 * real é o tier — e é o corte desta classe (abaixo) que o aplica: o lote chega
 * inteiro, sai o que cabe na janela como UM broadcast, e o excedente volta
 * re-enfileirado. `Channel.zernioBroadcastChunk` NÃO fatia mais o disparo: ele
 * é só o tamanho de cada requisição do addRecipients, invisível no painel.
 */
@Injectable()
export class ZernioBroadcastSendService {
  private readonly logger = new Logger(ZernioBroadcastSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioBroadcastClient,
    private readonly consent: ConsentService,
    private readonly campaignsRepo: CampaignsRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QUEUE_NAMES.WHATSAPP_SEND)
    private readonly sendQueue: Queue<SendMessageJob>,
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_POLL)
    private readonly pollQueue: Queue<ZernioBroadcastPollJob>,
    // A PRÓPRIA fila deste serviço: é por ela que o excedente do tier volta
    // (ver requeueLeftoverForNextWindow). Opcional pelo mesmo motivo do
    // broadcastDispatchQueue no CampaignsService.
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH)
    private readonly dispatchQueue?: Queue<DispatchBatchJob>,
    // O pulo por duplicata precisa deixar rastro fora da linha (o mesmo evento
    // que o worker 1-a-1 grava). `@Optional` porque o AuditModule é @Global e a
    // ausência dele nunca pode impedir um disparo de sair.
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Dispara UM lote de mensagens como UM broadcast do Zernio.
   *
   * O lote chega INTEIRO (a campanha não é mais fatiada em pedaços fixos —
   * pedido de 13/07): quem dita o tamanho real do disparo é o TETO DO TIER da
   * janela rolante de 24h, GLOBAL por número. O que couber sai agora como UM
   * broadcast; o excedente volta para esta mesma fila, adiado até a janela
   * abrir. Quem é o dono do "quem recebeu, quem foi pulado e por quê" continua
   * sendo o orgamind.
   */
  /**
   * "O excedente entra em fila até o limite liberar" — o pedaço do lote que
   * não coube no teto da janela rolante volta para a PRÓPRIA fila de dispatch,
   * adiado até a janela ABRIR de verdade.
   *
   * ## A âncora é a PRÓPRIA janela rolante, não um reset de calendário
   *
   * A janela abre quando o envio MAIS ANTIGO dentro dela completa 24h — não
   * existe "reset diário". A primeira versão ancorava em `sentTodayResetAt +
   * 24h` (o contador dia-calendário do 1-a-1, que o caminho de broadcast nunca
   * avança) e por isso acordava GARANTIDAMENTE com a janela ainda cheia —
   * ciclo de zero envio, para sempre. Como o tráfego de broadcast é em rajada,
   * quando o envio mais antigo sai da janela, sai quase tudo junto: acordar em
   * `min(sentAt) + 24h` tende a liberar o excedente numa leva só (sem o
   * rosário de broadcasts pequenos que o fatiamento fixo criava).
   *
   * ## SEM jobId customizado — de propósito
   *
   * Um id determinístico que se repete entre ciclos (acordou → ainda não coube
   * → re-enfileira o MESMO pedaço) colide com o próprio job em execução e o
   * BullMQ DESCARTA o novo em silêncio (`handleDuplicatedJob`): o excedente
   * ficaria QUEUED órfão para sempre — o exato bug que este método mata. Um
   * job duplicado ocasional (retry do processor) é inofensivo: o refetch por
   * `status: QUEUED` e o claim atômico tornam o segundo no-op.
   *
   * ## Falha ao re-enfileirar → FAILED recuperável, nunca órfã
   *
   * QUEUED sem job é um beco sem saída: o "Disparar novamente" da tela recusa
   * enquanto houver mensagem em voo (countInFlight conta QUEUED). FAILED com
   * código próprio é o estado com caminho de volta — o "Reenviar falhas" da
   * campanha as pega. É o MESMO contrato do enqueue inicial (dispatchAudience).
   *
   * O ciclo TERMINA sozinho: campanha cancelada, mensagens que deixaram de
   * estar QUEUED ou lote vazio fazem o dispatchBatch retornar sem re-enfileirar.
   */
  private async requeueLeftoverForNextWindow(
    job: DispatchBatchJob,
    leftover: Array<{ id: string }>,
    channel: { id: string },
    handedOff: Set<string>,
  ): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oldest = await this.prisma.message
      .aggregate({
        _min: { sentAt: true },
        where: {
          instanceId: channel.id,
          direction: 'OUTBOUND',
          contactId: { not: null },
          sentAt: { gte: since },
        },
      })
      .catch(() => ({ _min: { sentAt: null } }));
    const oldestSentAt = oldest._min.sentAt;
    // 5 min de folga sobre a saída do mais antigo; janela vazia com budget 0 é
    // um estado estranho (teto zerado?) — reavalia em 15 min em vez de chutar.
    const wakeAt = oldestSentAt
      ? oldestSentAt.getTime() + 24 * 60 * 60 * 1000 + 5 * 60_000
      : Date.now() + 15 * 60_000;
    const delay = Math.max(wakeAt - Date.now(), 60_000);
    const messageIds = leftover.map((m) => m.id);
    try {
      await this.dispatchQueue?.add('dispatch', {
        campaignId: job.campaignId,
        channelId: job.channelId,
        messageIds,
        correlationId: job.correlationId,
      }, { delay });
      // A PARTIR DAQUI estas mensagens têm DONO: um job adiado desta mesma fila.
      // Elas ficam QUEUED de propósito, e um `failOrphanedBatch` que as marcasse
      // como FALHA quebraria exatamente o mecanismo automático construído acima —
      // o job adiado acordaria, buscaria por `status: QUEUED` e não acharia
      // ninguém. Numa campanha de 13.000 com teto de 2.000/24h TODO lote gera
      // excedente, então este é o caso NORMAL, não a exceção.
      for (const id of messageIds) handedOff.add(id);
      this.logger.log(
        `[tier] campanha ${job.campaignId}: ${messageIds.length} mensagens re-enfileiradas ` +
          `para ${new Date(Date.now() + delay).toISOString()}.`,
      );
    } catch (err) {
      this.logger.error(
        { err, campaignId: job.campaignId, leftover: messageIds.length },
        '[tier] falha ao re-enfileirar o excedente do broadcast — marcando como FAILED recuperável (Reenviar falhas).',
      );
      for (const messageId of messageIds) {
        await this.campaignsRepo
          .markMessageEnqueueFailed(
            messageId,
            'Falha ao re-enfileirar o excedente do limite de 24h (Redis fora?). A mensagem NÃO foi enviada — use "Reenviar falhas".',
            'zernio.broadcast_requeue_failed',
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * `indeterminate` > 0 significa que o `POST /send` NÃO respondeu: as mensagens
   * foram entregues ao Zernio ou não — não dá para saber. Quem chama (o
   * processor) transforma isso em alarme; ninguém pode transformar em reenvio.
   */
  async dispatchBatch(
    job: DispatchBatchJob,
  ): Promise<{ sent: number; indeterminate?: number }> {
    // O conjunto de ids que este dispatch ENTREGOU A OUTRO DONO. Ver
    // `tagHandedOff`: é o que impede o `failOrphanedBatch` de matar mensagens
    // que têm job vivo esperando por elas.
    const handedOff = new Set<string>();
    try {
      return await this.runDispatch(job, handedOff);
    } catch (err) {
      tagHandedOff(err, handedOff);
      throw err;
    }
  }

  private async runDispatch(
    job: DispatchBatchJob,
    handedOff: Set<string>,
  ): Promise<{ sent: number; indeterminate?: number }> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: job.channelId },
    });
    if (!channel) {
      throw new Error(`Canal ${job.channelId} não existe — broadcast abortado.`);
    }

    // ── FALHA BARATA: as credenciais do broadcast, ANTES de qualquer coisa ────
    //
    // `profileId` e `accountId` são OBRIGATÓRIOS no `POST /broadcasts`. Sem eles a
    // criação falharia de qualquer jeito — mas falhar AQUI é falhar de graça:
    // nenhuma mensagem foi reivindicada, nenhuma cota de tier gasta, nenhum
    // contato criado no CRM do Zernio. E falhar ALTO (exceção) em vez de baixo
    // (log + return) é deliberado: um canal com broadcast LIGADO e profileId NULL
    // é uma configuração quebrada, e a pior coisa que ele poderia fazer é ficar
    // quieto. O `zernio-tier-sync` faz o backfill do profileId; se está NULL, o
    // job não rodou, e o operador precisa saber disso agora — não amanhã.
    const accountId = channel.zernioAccountId?.trim();
    if (!accountId) {
      throw new Error(
        `Canal ${job.channelId} está com broadcast LIGADO mas sem zernioAccountId. ` +
          `O POST /broadcasts exige accountId. Configure a conta do canal antes de disparar.`,
      );
    }
    const profileId = channel.zernioProfileId?.trim();
    if (!profileId) {
      throw new Error(
        `Canal ${job.channelId} está com broadcast LIGADO mas sem zernioProfileId. ` +
          `O POST /broadcasts o exige. Ele é preenchido pelo job zernio-tier-sync ` +
          `(a partir do GET /accounts) — rode-o, ou desligue o broadcast neste canal.`,
      );
    }

    const messages = await this.prisma.message.findMany({
      where: { id: { in: job.messageIds }, status: 'QUEUED' },
      include: { contact: true, campaign: { include: { template: true } } },
    });
    if (messages.length === 0) {
      this.logger.log(
        `broadcast ${job.campaignId}: nenhuma mensagem QUEUED no lote — nada a fazer.`,
      );
      return { sent: 0 };
    }

    const campaign = messages[0].campaign;
    if (!campaign) return { sent: 0 };

    // O operador cancelou a campanha enquanto o job esperava na fila. Não montar
    // um broadcast é o mínimo — o botão "Cancelar" existe para isso.
    if (campaign.status === 'CANCELLED') {
      this.logger.log(
        `broadcast ${job.campaignId}: campanha CANCELADA — nada será disparado.`,
      );
      return { sent: 0 };
    }

    // ── A campanha CABE num broadcast? ───────────────────────────────────────
    //
    // Ver `planBroadcastVariables`: o Zernio resolve as variáveis do template
    // contra o CRM DELE, e os destinatários que adicionamos por telefone nascem
    // lá SEM nome. Um `{{1}} = nome` sairia em branco — "Olá , tudo bem?" — para
    // a campanha inteira. Quando isso acontece, o broadcast NÃO É O CAMINHO: o
    // lote volta para o envio 1-a-1, que monta a variável do NOSSO banco.
    //
    // Isto não é uma falha: é o fallback funcionando. O 1-a-1 é o padrão.
    const plan = planBroadcastVariables(
      (campaign.variableMap ?? {}) as Record<string, { source: string }>,
    );
    if (!plan.broadcastable) {
      this.logger.warn(
        `broadcast ${job.campaignId}: NÃO é broadcastable — ${plan.reason} ` +
          `Caindo para o envio 1-a-1 (${messages.length} mensagens).`,
      );
      await this.fallbackToOneByOne(messages, job, handedOff);
      return { sent: 0 };
    }

    // ── ★ O GATE, POR CONTATO, ANTES DE MONTAR O BROADCAST ───────────────────
    const eligible: typeof messages = [];
    for (const m of messages) {
      if (!m.contact) continue;

      // 1. Supressão. ABSOLUTA — nem override a fura.
      //
      // ★ Decisão do cliente, 25/08/2026 — a fonte é APENAS a
      // `SuppressionList` (chave durável por `phoneHash`). O cache
      // `Contact.optedOut` saiu da condição, no mesmo commit que o tirou do
      // `dispatchAudience` e do worker 1-a-1: o cliente pediu, com o risco de
      // LGPD/política do WhatsApp apresentado e aceito por escrito, que o
      // booleano deixasse de excluir alguém do broadcast.
      if (await this.consent.isSuppressed(m.contact.phoneE164)) {
        await this.prisma.message.update({
          where: { id: m.id },
          data: { status: 'CANCELLED', errorCode: 'opted_out' },
        });
        continue;
      }

      // 2. Consentimento POR FINALIDADE — o MESMO gate do 1-a-1.
      //    A linha SKIPPED_NO_CONSENT é gravada POR PESSOA. É a prova.
      const may = await mayStillSendToContact(
        {
          consent: this.consent,
          campaignsRepo: this.campaignsRepo,
          prisma: this.prisma,
        },
        campaign,
        m.contact.id,
        m.instanceId,
      );
      if (!may) {
        await this.campaignsRepo.createSkippedMessage({
          campaignId: campaign.id,
          contactId: m.contact.id,
          instanceId: m.instanceId,
          reason: 'no_consent',
          campaignBatchId: m.campaignBatchId,
        });
        continue;
      }

      // 3. ★ K4 — ESTA PESSOA JÁ RECEBEU (ou já está recebendo)?
      //
      //    O envio 1-a-1 faz esta pergunta no `send-message.processor`, que é o
      //    único ponto que roda POR MENSAGEM no instante do envio. Só que o
      //    broadcast NÃO PASSA POR LÁ: a campanha enfileira UM job e o lote
      //    inteiro é montado aqui. Sem esta cláusula, todo furo de duplicata que
      //    o worker fechou continuava aberto exatamente onde está o volume —
      //    um canal, 13.000 eleitores, propaganda que não tem desfazer.
      //
      //    O pulo é CANCELLED + errorCode + errorMessage nomeando a irmã, o
      //    MESMO balde do worker: o eleitor não pode sumir da campanha em
      //    silêncio.
      const twin = await this.prisma.message.findFirst({
        where: duplicateGuardWhere({
          messageId: m.id,
          contactId: m.contact.id,
          campaignId: campaign.id,
          templateId: campaign.templateId,
          createdAt: m.createdAt,
        }),
        select: { id: true, campaignId: true, status: true },
      });
      if (twin) {
        this.logger.warn(
          `[K4] ${m.id} NÃO entra no broadcast: o contato ${m.contact.id} já tem a mensagem ` +
            `${twin.id} (campanha ${twin.campaignId ?? '—'}, status ${twin.status})`,
        );
        await this.prisma.message.update({
          where: { id: m.id },
          data: {
            status: 'CANCELLED',
            errorCode: DUPLICATE_ERROR_CODE,
            errorMessage:
              `Não enviada para não duplicar: este contato já tem a mensagem ${twin.id} ` +
              `(status ${twin.status}) nesta campanha ou em outra do mesmo template.`,
          },
        });
        await this.audit
          ?.log('campaign.duplicate_blocked', 'Message', m.id, {
            campaignId: campaign.id,
            contactId: m.contact.id,
            blockedByMessageId: twin.id,
            blockedByCampaignId: twin.campaignId,
            blockedByStatus: twin.status,
            via: 'zernio-broadcast',
          })
          .catch(() => undefined);
        continue;
      }

      // 4. Cap de MARKETING da Meta (131049): o destinatário está bloqueado por
      //    24h. Insistir é o que faz a Meta suspender a entrega àquela pessoa por
      //    mais 24h. Ele NÃO entra no broadcast — vai para o 1-a-1, que sabe
      //    adiar o job até o fim do bloqueio (aqui não há job por pessoa para
      //    adiar).
      const ttl = await this.redis
        .pttl(marketingCapKey(this.consent.hashOf(m.contact.phoneE164)))
        .catch(() => -2 as number);
      if (ttl > 0) {
        await this.enqueueOneByOne(m, job, handedOff);
        continue;
      }

      eligible.push(m);
    }

    if (eligible.length === 0) {
      this.logger.log(
        `broadcast ${job.campaignId}: o gate recusou TODO o lote — nenhum disparo criado.`,
      );
      return { sent: 0 };
    }

    // ── TETO DO TIER: 2.000 destinatários ÚNICOS / 24h ROLANTES ──────────────
    //
    // Quem conta é o ORGAMIND. O Zernio não sabe do nosso tier, e a Meta não avisa
    // antes — ela simplesmente REJEITA, e cada rejeição derruba o quality rating
    // do número (que já teve display name reprovado). A janela é ROLANTE, não
    // dia-calendário: é assim que a Meta conta.
    //
    // Duas imprecisões CONHECIDAS desta contagem, ambas no lado conservador
    // (validado na doc da Meta em 13/07):
    // - Desde out/2025 o limite oficial é por PORTFÓLIO (todos os números do
    //   negócio somados), não por número. Contar por canal SUBESTIMA o consumo
    //   se dois números do mesmo portfólio dispararem — hoje só um número
    //   dispara, então a conta fecha; se o segundo canal for reativado, esta
    //   contagem precisa virar por-portfólio.
    // - A Meta só conta entregas FORA de janela de atendimento aberta; nós
    //   contamos todo OUTBOUND (inclui respostas do inbox). Superestimar aqui
    //   só faz o corte chegar mais cedo — nunca estoura o teto real.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.prisma.message.groupBy({
      by: ['contactId'],
      where: {
        instanceId: channel.id,
        direction: 'OUTBOUND',
        contactId: { not: null },
        sentAt: { gte: since },
      },
    });
    const already = new Set(recent.map((r) => r.contactId));
    // Quem JÁ está na janela não adiciona um destinatário único novo.
    const budget = Math.max(0, channel.dailySendLimit - already.size);
    const fresh = eligible.filter((m) => !already.has(m.contactId));
    const withinTier =
      fresh.length <= budget
        ? eligible
        : eligible.filter(
            (m) =>
              already.has(m.contactId) ||
              fresh.slice(0, budget).some((f) => f.id === m.id),
          );

    // ★ O EXCEDENTE ENTRA EM FILA — não morre QUEUED sem dono.
    //
    // Antes, "fica para a próxima janela" era só uma frase de log: a mensagem
    // continuava QUEUED, mas o job dela já tinha terminado e NINGUÉM voltava
    // para buscá-la — a campanha ficava "Em execução" para sempre. Agora o
    // pedaço que não coube é re-enfileirado NESTA fila, adiado até o reset da
    // janela — o mesmo padrão do moveToDelayed do 1-a-1.
    const withinTierIds = new Set(withinTier.map((m) => m.id));
    const leftover = eligible.filter((m) => !withinTierIds.has(m.id));
    if (leftover.length > 0) {
      await this.requeueLeftoverForNextWindow(job, leftover, channel, handedOff);
    }

    if (withinTier.length === 0) {
      this.logger.warn(
        `[tier] canal ${channel.id}: a janela rolante de 24h já tem ${already.size} ` +
          `destinatários únicos (teto ${channel.dailySendLimit}) — o lote inteiro foi ` +
          `re-enfileirado para a próxima janela. As mensagens continuam QUEUED.`,
      );
      return { sent: 0 };
    }
    if (leftover.length > 0) {
      this.logger.warn(
        `[tier] canal ${channel.id}: só cabem ${withinTier.length} de ${eligible.length} ` +
          `no teto de 24h — os ${leftover.length} restantes foram re-enfileirados ` +
          `para a próxima janela (continuam QUEUED até lá).`,
      );
    }

    // ── CLAIM ATÔMICO (QUEUED→SENDING), por mensagem ─────────────────────────
    // Igual ao 1-a-1: quem perde o claim (outra tentativa do BullMQ já pegou)
    // NÃO entra no broadcast. É o guarda anti-envio-duplicado.
    const claimed: typeof messages = [];
    for (const m of withinTier) {
      const count = await this.campaignsRepo.claimForSend(m.id);
      if (count > 0) claimed.push(m);
    }
    if (claimed.length === 0) {
      this.logger.log(
        `broadcast ${job.campaignId}: nenhum claim vencido (lote já em voo) — nada a fazer.`,
      );
      return { sent: 0 };
    }

    const phones = claimed
      .map((m) => m.contact?.phoneE164)
      .filter((p): p is string => Boolean(p));

    // ── HEARTBEAT DO CLAIM ───────────────────────────────────────────────────
    //
    // Com o lote inteiro num job só, a fase de addRecipients pode passar de
    // 10 min (2.000 telefones ÷ chunk 50 = 40 POSTs num balde de 1 req/s
    // disputado, mais retries de 429) — e o reconciler marca SENDING parado há
    // 10 min como FAILED ('sending_stuck'). Só que esses telefones JÁ estão
    // entrando no broadcast: FAILED aqui + "Reenviar falhas" = duplicata real.
    // Enquanto este processo está VIVO e trabalhando, renova o carimbo
    // `sendingAt`; se o processo morrer, o heartbeat morre junto e o
    // reconciler recupera as linhas — que é exatamente o caso dele.
    const claimedIds = claimed.map((m) => m.id);
    const heartbeat = setInterval(() => {
      void this.prisma.message
        .updateMany({
          where: { id: { in: claimedIds }, status: 'SENDING' },
          data: { sendingAt: new Date() },
        })
        .catch(() => undefined);
    }, 4 * 60_000);

    // ── AS CHAMADAS REAIS ────────────────────────────────────────────────────
    let broadcastId: string | undefined;
    let localBroadcastId: string | undefined;
    // O que separa "não saiu" de "não sei": tudo antes desta bandeira é
    // demonstravelmente ANTES do disparo (nem `createBroadcast` nem
    // `addRecipients` enviam mensagem nenhuma — o `/recipients` só cadastra
    // telefone). Depois dela, a dúvida entra em cena.
    let sendAttempted = false;
    try {
      broadcastId = await this.client.createBroadcast(channel.id, {
        profileId,
        accountId,
        name: this.broadcastName(campaign.name, campaign.id),
        templateName: campaign.template.metaName,
        templateLanguage: campaign.template.language,
        variableMapping: plan.variableMapping,
      });

      // O espelho local nasce AGORA, e não depois do `/send` — de propósito. Se o
      // `/send` falhar (ou der timeout), este é o único registro de que existe um
      // disparo lá com o nosso nome nele, e sem ele o kill-switch não teria o que
      // cancelar. `campaignId` é o vínculo que o sync de leitura NUNCA sobrescreve
      // (ver ZernioBroadcastSyncService.upsert).
      const local = await this.prisma.zernioBroadcast.create({
        data: {
          zernioId: broadcastId,
          channelId: channel.id,
          campaignId: campaign.id,
          name: this.broadcastName(campaign.name, campaign.id),
          status: 'draft',
          templateName: campaign.template.metaName,
          recipientCount: phones.length,
        },
      });
      localBroadcastId = local.id;

      await this.client.addRecipients(
        channel.id,
        broadcastId,
        phones,
        effectiveChunkSize(channel.zernioBroadcastChunk),
      );

      sendAttempted = true;
      await this.client.sendBroadcast(channel.id, broadcastId);
    } catch (err) {
      clearInterval(heartbeat);

      // ── ★ O /send NÃO RESPONDEU: a entrega é INDETERMINADA ─────────────────
      //
      // Aqui está a única pergunta que importa: **depois deste erro, o sistema
      // sabe se o Zernio recebeu o disparo?**
      //
      // Se a resposta é NÃO (timeout, conexão morta, 5xx), o certo NUNCA é
      // reenviar por padrão. Devolver o lote para QUEUED é apostar em "não
      // recebeu": quando a aposta erra, o lote INTEIRO é remontado e disparado
      // de novo, e milhares de eleitores recebem a mesma propaganda duas vezes —
      // que é exatamente o dano que este sistema existe para não causar (e o
      // sinal de spam que já custou o display name deste número).
      //
      // O orgamind JÁ tem o conceito certo para isso, e ele é o do 1-a-1:
      // INDETERMINADO não volta para a fila, não vira "Reenviar falhas", e quem
      // descobre a verdade é o RECONCILIADOR (ver INDETERMINATE_DELIVERY_CODES
      // em campaigns.repository.ts). No broadcast o reconciliador já existe em
      // dois níveis — o WEBHOOK, que casa por telefone e carimba o wamid, e o
      // polling por destinatário — e os dois só enxergam a linha se ela estiver
      // amarrada ao disparo. Então é isso que fazemos: SENT + zernioBroadcastId,
      // exatamente como no caminho feliz.
      if (sendAttempted && isSendOutcomeIndeterminate(err)) {
        return this.settleIndeterminateSend({
          err,
          claimedIds,
          localBroadcastId,
          channelId: channel.id,
          campaignId: campaign.id,
          broadcastId,
        });
      }

      // ── FALHOU SEM TER DISPARADO — e isto é DEMONSTRÁVEL ───────────────────
      //
      // Ou o erro veio antes do `/send` (create/recipients: nenhum deles envia
      // nada), ou o próprio `/send` foi RECUSADO NA PORTA (4xx com corpo, ou 429
      // esgotado). Nos dois casos há prova de que nada saiu: devolvemos as
      // mensagens para QUEUED — de onde a retentativa as reivindica de novo — e
      // cancelamos o rascunho, para não deixar lixo no painel do cliente nem um
      // disparo fantasma que alguém possa apertar "enviar" no futuro.
      this.logger.error(
        { err, broadcastId, campaignId: campaign.id },
        'broadcast do Zernio falhou ANTES de disparar — devolvendo o lote para QUEUED e cancelando o rascunho',
      );
      if (broadcastId) {
        await this.client
          .cancelBroadcast(channel.id, broadcastId)
          .catch(() => undefined);
      }
      for (const m of claimed) {
        await this.campaignsRepo.releaseClaim(m.id).catch(() => undefined);
      }
      throw err;
    }

    clearInterval(heartbeat);

    // ── DISPARADO. Agora as mensagens são reais. ─────────────────────────────
    //
    // SENT sem `providerMessageId`: o `/send` devolve `{success, status, sent,
    // failed, recipientCount}` e **nenhum wamid**. É o `zernioBroadcastId` (posto
    // aqui) que amarra estas linhas ao disparo — e é por ele, mais o TELEFONE,
    // que o WEBHOOK de status vai achá-las e CARIMBAR o wamid em cada uma (ver
    // `WebhooksService.matchBroadcastMessageByPhone`). O `sentAt` que carimbamos
    // é a hora do DISPARO, não a da entrega: o Zernio pode levar horas para
    // realmente mandar (ver o PACING, abaixo).
    //
    // (O reconciler de SENT ignora linhas sem providerMessageId, então elas não
    // são "recuperadas" por engano.)
    const sentAt = new Date();
    await this.prisma.message.updateMany({
      where: { id: { in: claimed.map((m) => m.id) }, status: 'SENDING' },
      data: {
        status: 'SENT',
        sentAt,
        zernioBroadcastId: localBroadcastId,
      },
    });

    // ★ O WEBHOOK é a fonte da verdade do status — NÃO este polling.
    //
    // O desenho original era o inverso, e a sondagem ao vivo (13/07) o derrubou:
    // o `GET /{id}/recipients` não devolve wamid, nem timestamps, nem errorCode, e
    // reporta todo mundo como `pending` indefinidamente; já o webhook DISPARA para
    // broadcast, em tempo real, com o wamid. Este job passou a ser a REDE DE
    // SEGURANÇA (para o que o webhook perdeu) e roda DEVAGAR — o balde de
    // 60 req/min é o mesmo do envio, e o envio tem prioridade.
    //
    // 5 min de atraso inicial (era 30s): não há pressa nenhuma em perguntar a
    // quem não sabe responder.
    await this.pollQueue.add(
      'poll',
      { localBroadcastId: localBroadcastId!, channelId: channel.id },
      { delay: 5 * 60_000, removeOnComplete: { age: 3600, count: 20 } },
    );

    this.logger.log(
      `broadcast ${broadcastId} disparado: ${claimed.length} destinatários ` +
        `(campanha ${campaign.id}, canal ${channel.id}).`,
    );
    return { sent: claimed.length };
  }

  /**
   * ★ O DESFECHO INDETERMINADO — o lote fica FORA de todo caminho de reenvio.
   *
   * Chamado quando o `POST /send` não respondeu (ver
   * {@link isSendOutcomeIndeterminate}). Faz TRÊS coisas, e o que ele NÃO faz é
   * tão importante quanto:
   *
   * 1. **SENT + `zernioBroadcastId`**, exatamente como o caminho feliz. Não é
   *    otimismo: é o único estado que (a) não é reivindicável de novo (nada de
   *    QUEUED), (b) não entra em "Reenviar falhas" nem no retry manual (que só
   *    pegam FAILED), e (c) continua VISÍVEL para o reconciliador — o webhook
   *    casa por telefone dentro da janela de 48h contada do `sentAt` e carimba o
   *    wamid, e o polling por destinatário varre o mesmo disparo.
   *    FAILED seria pior de todos os ângulos: é TERMINAL para o webhook
   *    (`STATUS_RANK` 99), então uma entrega confirmada não conseguiria mais
   *    corrigir a linha — e, como "quem já recebeu" é calculado por
   *    SENT/DELIVERED/READ, a próxima campanha reenviaria para essas pessoas.
   * 2. **NÃO cancela o disparo.** O cancel best-effort era a aposta antiga e
   *    perde nos dois lados: se o Zernio está fora (a causa provável do timeout)
   *    ele falha junto; se está no ar, aborta no meio um disparo cujas linhas já
   *    contam como enviadas — entrega pela metade, registrada como inteira.
   * 3. **NÃO relança o erro.** Relançar convida a retentativa do BullMQ a
   *    remontar o lote. (Mesmo que ela rode, o refetch é por `status: QUEUED` e
   *    estas linhas já não estão lá — mas depender disso seria construir a
   *    segurança em cima de um detalhe de outra camada.) O alarme sai por
   *    `indeterminate` no retorno, que o processor manda para o Sentry.
   *
   * O preço: se o Zernio NÃO recebeu nada, estas pessoas ficam marcadas como
   * enviadas sem terem recebido. É um preço consciente — o outro lado da moeda é
   * propaganda eleitoral duplicada, que não tem desfazer. E este lado é
   * DESCOBRÍVEL: o espelho local fica em `draft` (o sync de leitura o atualiza a
   * partir do `GET /broadcasts`), o Sentry avisa, e nada é entregue no painel.
   */
  private async settleIndeterminateSend(args: {
    err: unknown;
    claimedIds: string[];
    localBroadcastId: string | undefined;
    channelId: string;
    campaignId: string;
    broadcastId: string | undefined;
  }): Promise<{ sent: number; indeterminate: number }> {
    const { err, claimedIds, localBroadcastId, channelId, campaignId } = args;

    this.logger.error(
      { err, broadcastId: args.broadcastId, campaignId },
      `★ ENTREGA INDETERMINADA: o POST /send do broadcast ${args.broadcastId} não respondeu. ` +
        `O Zernio PODE estar entregando as ${claimedIds.length} mensagens agora. ` +
        `Elas NÃO voltam para a fila (reenviar seria duplicar) e NÃO são canceladas; ` +
        `ficam SENT, e quem apura a verdade é o webhook + o polling. ` +
        `${INDETERMINATE_DELIVERY_MESSAGE}`,
    );

    await this.prisma.message
      .updateMany({
        where: { id: { in: claimedIds }, status: 'SENDING' },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          zernioBroadcastId: localBroadcastId,
          // ⚠️ SÓ `errorMessage`, nunca `errorCode`: o código é o vocabulário da
          // FALHA (classifyFailure, reachability, "Reenviar falhas") e esta linha
          // não é uma falha — é uma dúvida. O texto é o que o operador lê, e o
          // PREFIXO é o que torna a linha CONSULTÁVEL (ver
          // INDETERMINATE_DELIVERY_MARK e o endpoint que a lista).
          errorMessage: INDETERMINATE_DELIVERY_MESSAGE,
        },
      })
      .catch((updateErr: unknown) =>
        // Se nem isto foi gravado, as linhas ficam SENDING — e SENDING parado é
        // recolhido pelo reconciler como 'sending_stuck', que JÁ é um código
        // indeterminado (não é auto-reenviado). O pior caso continua seguro.
        this.logger.error(
          { err: updateErr, campaignId },
          'falha ao marcar o lote indeterminado como SENT — as linhas ficam SENDING (o reconciler as trata como sending_stuck)',
        ),
      );

    if (localBroadcastId) {
      await this.pollQueue
        .add(
          'poll',
          { localBroadcastId, channelId },
          { delay: 5 * 60_000, removeOnComplete: { age: 3600, count: 20 } },
        )
        .catch(() => undefined);
    }

    return { sent: claimedIds.length, indeterminate: claimedIds.length };
  }

  /**
   * ★ O ÚLTIMO SUSPIRO de um dispatch que falhou de vez — QUEUED sem job é um
   * beco sem saída.
   *
   * Quando o `dispatchBatch` falha por um motivo DEMONSTRADAMENTE anterior ao
   * disparo, ele devolve o lote a QUEUED de propósito: assim a retentativa do
   * BullMQ o reivindica de novo e o disparo sai. Só que, esgotadas as
   * retentativas, ninguém mais volta para buscá-lo — e QUEUED sem job é o pior
   * estado do sistema: a campanha fica "Em execução" para sempre e o
   * "Disparar novamente" da tela RECUSA enquanto houver mensagem em voo
   * (`countInFlight` conta QUEUED).
   *
   * É o MESMO contrato de `requeueLeftoverForNextWindow` e do enqueue inicial:
   * FAILED com código próprio é o estado que TEM caminho de volta — o "Reenviar
   * falhas" da campanha o recupera. E o código é retentável de propósito: aqui
   * sabemos que nada foi enviado (o caminho indeterminado nunca chega neste
   * método — ele nem relança o erro).
   *
   * O `markMessageEnqueueFailed` é escopado a `status: QUEUED`, então uma linha
   * que outro ator já levou (ou que saiu por outro lote) não é tocada.
   */
  async failOrphanedBatch(job: DispatchBatchJob, err: unknown): Promise<void> {
    // ★ SÓ QUEM FICOU SEM DONO. O lote original NÃO é a população órfã: o
    // dispatch pode ter re-enfileirado o excedente do teto de 24h (job adiado
    // nesta fila) e mandado os bloqueados pelo cap 131049 para a fila 1-a-1.
    // Esses continuam QUEUED de propósito, e marcá-los como FALHA quebraria o
    // mecanismo automático que os salvava — transformando envio automático em
    // trabalho manual no meio de uma campanha com prazo.
    const handedOff = readHandedOff(err);
    const orphans = job.messageIds.filter((id) => !handedOff.has(id));

    this.logger.error(
      {
        err,
        campaignId: job.campaignId,
        batch: job.messageIds.length,
        orphans: orphans.length,
        handedOff: handedOff.size,
      },
      'broadcast do Zernio esgotou as retentativas — o que ficou SEM DONO vira FALHA RECUPERÁVEL ("Reenviar falhas"), nunca QUEUED órfão',
    );
    if (orphans.length === 0) return;

    // UMA ida ao banco, não uma por mensagem: num lote de 2.000 eram 2.000
    // updates em série disparados de dentro de um @OnWorkerEvent, enquanto o
    // worker já pegava o próximo job. O escopo `status: 'QUEUED'` é o mesmo de
    // `markMessageEnqueueFailed` — linha que outro ator já levou não é tocada.
    // O `failureReason` sai do MESMO `classifyFailure`, e o código é igual para
    // todas as linhas (é o desfecho do lote, não do destinatário).
    await this.prisma.message.updateMany({
      where: { id: { in: orphans }, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        errorCode: ORPHAN_BATCH_ERROR_CODE,
        errorMessage:
          'O disparo por broadcast do Zernio falhou antes de enviar. A mensagem NÃO foi enviada — use "Reenviar falhas".',
        failedAt: new Date(),
        failureReason: classifyFailure(ORPHAN_BATCH_ERROR_CODE),
      },
    });
  }

  /**
   * ★ O KILL-SWITCH — cancela no Zernio TODO disparo ainda vivo desta campanha.
   *
   * Chamado quando a campanha é cancelada (pelo operador OU pelo kill-switch
   * automático do `send-message.processor`: queda de qualityRating, `131031`
   * conta bloqueada, `132015` template pausado). Sem isto, "cancelar" só pararia
   * a FILA do orgamind — e o Zernio continuaria disparando alegremente as centenas
   * de mensagens que já estão no broadcast dele.
   *
   * Best-effort POR DISPARO: um cancelamento que falha (o disparo já terminou,
   * tipicamente) NÃO pode impedir o cancelamento dos outros. É o mesmo espírito
   * do resto do kill-switch — o objetivo é PARAR O MÁXIMO, não ser elegante.
   */
  async cancelForCampaign(campaignId: string): Promise<number> {
    const live = await this.prisma.zernioBroadcast.findMany({
      where: { campaignId, status: { in: CANCELLABLE_STATUSES } },
      select: { id: true, zernioId: true, channelId: true },
    });
    if (live.length === 0) return 0;

    let cancelled = 0;
    for (const b of live) {
      try {
        const ok = await this.client.cancelBroadcast(b.channelId, b.zernioId);
        if (ok) {
          cancelled += 1;
          await this.prisma.zernioBroadcast
            .update({ where: { id: b.id }, data: { status: 'cancelled' } })
            .catch(() => undefined);
        }
      } catch (err) {
        this.logger.warn(
          { err, zernioId: b.zernioId },
          'kill-switch: falha ao cancelar o disparo no Zernio — seguindo com os outros',
        );
      }
    }

    this.logger.warn(
      `[kill-switch] campanha ${campaignId}: ${cancelled}/${live.length} disparo(s) do Zernio cancelado(s).`,
    );
    return cancelled;
  }

  /**
   * O nome que aparece NO PAINEL DO ZERNIO. É o que o cliente vai ler, e o pedido
   * dele era exatamente esse: enxergar a campanha do orgamind lá dentro. Levamos o
   * id junto porque uma campanha do orgamind pode virar N disparos (um por lote), e
   * "Campanha MG" repetido cinco vezes não ajuda ninguém.
   */
  private broadcastName(campaignName: string, campaignId: string): string {
    return `${campaignName} · orgamind ${campaignId.slice(0, 8)}`;
  }

  /** O FALLBACK: devolve o lote para o envio 1-a-1, que é o padrão do sistema. */
  private async fallbackToOneByOne(
    messages: { id: string; contactId: string | null }[],
    job: DispatchBatchJob,
    handedOff: Set<string>,
  ): Promise<void> {
    for (const m of messages) {
      await this.enqueueOneByOne(m, job, handedOff);
    }
  }

  private async enqueueOneByOne(
    m: { id: string; contactId: string | null },
    job: DispatchBatchJob,
    handedOff: Set<string>,
  ): Promise<void> {
    await this.sendQueue.add(
      'send',
      {
        messageId: m.id,
        campaignId: job.campaignId,
        correlationId: job.correlationId,
      },
      { jobId: `${job.campaignId}:${m.contactId}:${m.id}` },
    );
    // Tem DONO: a fila 1-a-1. Continua QUEUED até o processor dar o claim —
    // marcá-la como falha aqui seria tirar a mensagem de uma fila que ia
    // entregá-la.
    handedOff.add(m.id);
  }
}
