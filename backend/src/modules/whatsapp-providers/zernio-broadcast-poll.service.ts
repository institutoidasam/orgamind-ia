import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { MessageStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { QUEUE_NAMES, type ZernioBroadcastPollJob } from '../queue/queue.constants';
import { zernioSendHasPriority } from '../queue/zernio-send-priority.helper';
import { recomputeBroadcastCounters } from './zernio-broadcast-counters';
import {
  ZernioBroadcastClient,
  type ZernioRecipientStatus,
} from './zernio-broadcast.client';

/** O passo do offset. Tem de ser o mesmo `limit` que o cliente usa. */
const PAGE_SIZE = 100;
/** Teto de páginas por tick — um `hasMore` eterno não pode segurar o worker. */
const MAX_PAGES = 50;

/**
 * Quantas vezes reconciliar antes de desistir.
 *
 * O polling come do balde de 60 req/min — o MESMO do envio, e **o envio tem
 * prioridade**. Um polling que não sabe parar rouba vazão da campanha para
 * sempre. Com o backoff abaixo, 24 tentativas cobrem ~11h — folga de sobra para
 * um broadcast do Zernio, que é LENTO (medido ao vivo: 1.015 destinatários, 35
 * min depois de iniciado, `sentCount: 3`).
 *
 * O que sobrar sem status terminal depois disso fica como está: a Message
 * continua no estado que o WEBHOOK deixou — e o webhook é quem sabe a verdade.
 */
const MAX_POLL_ATTEMPTS = 24;

/**
 * Backoff LENTO: 5m, 10m, 20m, 30m, 30m… (teto de 30 min).
 *
 * Era 30s/1m/2m… — agressivo demais para um RECONCILIADOR. Ele não é mais a
 * fundação do status (o webhook é, e chega em tempo real); é a rede de segurança
 * para o que o webhook perdeu. Rede de segurança não precisa ser rápida — precisa
 * ser barata, porque cada requisição sai do mesmo balde que a campanha usa para
 * enviar.
 */
function pollDelayMs(attempt: number): number {
  return Math.min(5 * 60_000 * 2 ** attempt, 30 * 60_000);
}

/**
 * ★ A MÁQUINA DE STATUS, MONOTÔNICA.
 *
 * `sent < delivered < read`; `failed` é terminal. O polling é assíncrono e a
 * ordem de chegada NÃO é garantida — pior: se o webhook do Zernio TAMBÉM
 * funcionar para broadcast (não sabemos, a doc não promete), os dois vão escrever
 * na mesma linha. Um "sent" atrasado NÃO pode rebaixar quem já está DELIVERED.
 *
 * A garantia não é um `if` em memória (que perde a corrida entre dois workers):
 * é o `updateMany` ESCOPADO por status. Só as linhas que estão ABAIXO do alvo são
 * tocadas — o banco decide, atomicamente.
 *
 * Note o que NUNCA aparece nestas listas: `SKIPPED_NO_CONSENT`,
 * `SKIPPED_SUPPRESSED`, `SKIPPED_NO_OPTIN`, `CANCELLED`, `RECEIVED`. As linhas do
 * gate são a PROVA de que o sistema recusou enviar sem autorização — num processo
 * do TSE, a defesa do cliente. Nenhum status vindo do provedor pode sobrescrevê-las.
 */
const STATUSES_BELOW: Record<string, MessageStatus[]> = {
  SENT: ['QUEUED', 'WAITING_INSTANCE', 'SENDING'],
  DELIVERED: ['QUEUED', 'WAITING_INSTANCE', 'SENDING', 'SENT'],
  READ: ['QUEUED', 'WAITING_INSTANCE', 'SENDING', 'SENT', 'DELIVERED'],
  // FAILED é terminal e VENCE qualquer estado de entrega — mas continua sem
  // poder tocar as linhas do gate (que nunca foram enviadas).
  FAILED: [
    'QUEUED',
    'WAITING_INSTANCE',
    'SENDING',
    'SENT',
    'DELIVERED',
    'READ',
  ],
};

/** `pending` não é um status nosso: significa "ainda não saiu". Não escrevemos nada. */
const TARGET_STATUS: Record<string, MessageStatus | undefined> = {
  pending: undefined,
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

/** Estes já acabaram — não há o que esperar deles num próximo poll. */
const TERMINAL = new Set(['read', 'failed']);

export type PollBroadcastArgs = {
  localBroadcastId: string;
  channelId: string;
  attempt?: number;
};

/**
 * ★ O RECONCILIADOR LENTO do broadcast — a REDE DE SEGURANÇA, não a fundação.
 *
 * ## A INVERSÃO (o desenho anterior estava de cabeça para baixo)
 *
 * Este serviço nasceu como "a fonte da verdade do status", por polling. O
 * raciocínio era razoável: a doc descreve `message.sent` como *"sent FROM THE
 * INBOX"* e nunca promete os eventos `message.*` para broadcast; não existe
 * evento `broadcast.*`. Apostar o status de uma campanha de 13.400 pessoas num
 * webhook que a doc não promete parecia construir sobre areia.
 *
 * **A SONDAGEM AO VIVO (13/07, produção) desmentiu os DOIS lados:**
 *
 * 1. O `GET /broadcasts/{id}/recipients` **não devolve o wamid**, nem
 *    `sentAt`/`deliveredAt`/`readAt`, nem `errorCode`. E o `status` dele está
 *    MORTO: 30+ min depois do disparo, os 50 destinatários amostrados seguiam
 *    TODOS em `pending` — com entregas já confirmadas por webhook. Os contadores
 *    agregados também: `sentCount: 3` com `deliveredCount: 8`, congelados.
 * 2. O **WEBHOOK DISPARA para broadcast**, em tempo real, por mensagem, COM o
 *    wamid (`message.platformMessageId`) e o telefone
 *    (`conversation.participantId`). Prova: chegou um `message.delivered` de
 *    `bem_vindo_post_1`, template que o orgamind NUNCA enviou — logo só podia ser do
 *    broadcast disparado pelo painel.
 *
 * Então o webhook virou a fundação (ver `WebhooksService`, que casa por telefone
 * e CARIMBA o wamid na `Message`), e este serviço virou o que ele deve ser: a
 * rede que pega o que o webhook perdeu — ele é at-least-once, mas pode ir para
 * dead-letter depois de ~51h.
 *
 * ## O que ele usa, e o que ele NÃO faz mais
 *
 * Usa só o que a API realmente dá: `platformIdentifier` (telefone), `status` e
 * `errorExplanation`. E, deliberadamente:
 *
 * - **não escreve `providerMessageId`** — não há wamid aqui para escrever, e
 *   inventar um estouraria o `@unique` do campo. Quem carimba é o webhook;
 * - **não escreve `errorCode`** — a API não manda um, e gravar `null` por cima
 *   APAGARIA o 131026 que o webhook gravou (o código que marca o contato como
 *   inalcançável-para-MARKETING — 30% da base);
 * - **não copia os contadores do Zernio** — eles são a mentira congelada. Os
 *   contadores do espelho são uma PROJEÇÃO das nossas Messages, que o webhook
 *   mantém em dia (ver `recomputeBroadcastCounters`).
 *
 * ## O balde
 *
 * Cada página COME um slot dos 60 req/min — o MESMO balde do envio, e **o envio
 * tem prioridade**. Por isso `pollBroadcast` cede a vez (`zernioSendHasPriority`)
 * e o backoff é LENTO (5m → 30m). Ele pode esperar; a campanha não.
 */
@Injectable()
export class ZernioBroadcastPollService {
  private readonly logger = new Logger(ZernioBroadcastPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioBroadcastClient,
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_POLL)
    private readonly pollQueue: Queue<ZernioBroadcastPollJob>,
  ) {}

  async pollBroadcast(args: PollBroadcastArgs): Promise<void> {
    const attempt = args.attempt ?? 0;

    const broadcast = await this.prisma.zernioBroadcast.findUnique({
      where: { id: args.localBroadcastId },
    });
    if (!broadcast) return;

    // PRIORIDADE DO ENVIO: antes de gastar um slot do balde, checa se há campanha
    // disparando neste canal. Se há, o polling CEDE e volta depois — ele é um
    // observador, e atrasar 1 minuto não custa nada; roubar 1 req/s de um disparo
    // custa.
    if (await zernioSendHasPriority(this.prisma, [args.channelId])) {
      await this.reschedule(args, attempt);
      return;
    }

    // As Messages deste disparo, indexadas por TELEFONE — que é a única chave que
    // temos no momento do envio (o `/send` não devolve wamid nenhum; é este
    // polling que os traz).
    const messages = await this.prisma.message.findMany({
      where: { zernioBroadcastId: broadcast.id },
      select: { id: true, status: true, contact: { select: { phoneE164: true } } },
    });
    const byPhone = new Map<string, { id: string; status: string }>();
    for (const m of messages) {
      if (m.contact?.phoneE164) {
        byPhone.set(m.contact.phoneE164, { id: m.id, status: m.status });
      }
    }

    let anyPending = false;
    let reconciled = 0;
    let skip = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client.listRecipients(
        args.channelId,
        broadcast.zernioId,
        skip,
      );

      for (const r of res.items) {
        if (!r.status || !TERMINAL.has(r.status)) anyPending = true;

        const target = r.status ? TARGET_STATUS[r.status] : undefined;
        // `pending` (ainda não saiu) e status desconhecido do Zernio: NÃO tocamos
        // a linha. Escrever um estado que não entendemos é pior do que não
        // escrever nada — e, na prática, TODOS vêm `pending` (o status da API
        // está congelado), então este `continue` é o caminho normal.
        if (!target) continue;

        const msg = byPhone.get(r.phone);
        // Um destinatário que não casa com Message nenhuma (o cliente adicionou
        // gente pelo painel neste mesmo disparo?) não é erro — é um número.
        if (!msg) continue;

        reconciled += 1;
        await this.applyStatus(msg.id, target, r).catch((err) =>
          this.logger.warn(
            { err, messageId: msg.id, phone: r.phone },
            'falha aplicando o status do destinatário — pulando (o próximo tick o pega)',
          ),
        );
      }

      if (!res.hasMore) break;
      skip += PAGE_SIZE;
    }

    // ★ OS CONTADORES SAEM DAS NOSSAS MESSAGES — não dos números do Zernio.
    //
    // Copiar os agregados da API de volta para cá seria APAGAR, a cada tick, tudo
    // o que o webhook apurou: a API reporta todo mundo como `pending` enquanto os
    // webhooks já confirmaram entrega e leitura. A tela mostraria "0 enviadas"
    // numa campanha que entregou.
    //
    // Nota: `status`/`completedAt` do espelho NÃO são escritos aqui — eles são o
    // ciclo de vida do disparo NO ZERNIO, e quem os traz é o sync de leitura
    // (`ZernioBroadcastSyncService`, do `GET /broadcasts`). Dois escritores no
    // mesmo campo brigariam.
    const counters = await recomputeBroadcastCounters(
      this.prisma,
      broadcast.id,
    );
    await this.prisma.zernioBroadcast
      .update({
        where: { id: broadcast.id },
        data: { ...counters, syncedAt: new Date() },
      })
      .catch(() => undefined);

    if (anyPending) {
      await this.reschedule(args, attempt);
    } else {
      this.logger.log(
        `broadcast ${broadcast.zernioId} assentou (reconciliadas ${reconciled}): ` +
          `${counters.sentCount} enviadas, ${counters.deliveredCount} entregues, ` +
          `${counters.readCount} lidas, ${counters.failedCount} falhas.`,
      );
    }
  }

  /**
   * Aplica UM status, atomicamente e de forma MONOTÔNICA.
   *
   * O `updateMany` escopado por `status: { in: STATUSES_BELOW[target] }` é a
   * garantia: se a linha já avançou (por outro poll, ou por um webhook que
   * chegou antes), o update simplesmente não casa nenhuma linha — count 0, e
   * nada é rebaixado. Sem `if` em memória, sem corrida.
   */
  private async applyStatus(
    messageId: string,
    target: MessageStatus,
    r: ZernioRecipientStatus,
  ): Promise<void> {
    const data: Record<string, unknown> = { status: target };

    // ⚠️ NÃO escrevemos `providerMessageId`: o `/recipients` NÃO devolve o wamid
    // (sondado ao vivo). O campo é `@unique` — inventar um valor aqui explodiria.
    // Quem carimba o wamid é o WEBHOOK, que o tem de verdade.
    //
    // ⚠️ Os TIMESTAMPS também não vêm da API (não existem lá). O que carimbamos é
    // a hora da RECONCILIAÇÃO, e ela é uma aproximação por cima — o horário
    // VERDADEIRO do evento vem no `statusAt` do webhook, que é o caminho normal.
    // Por isso só preenchemos o timestamp quando ele ainda está vazio: um
    // `deliveredAt` real, posto pelo webhook, nunca é sobrescrito por este chute.
    const now = new Date();
    if (target === 'SENT') {
      data.sentAt = now;
    } else if (target === 'READ') {
      data.readAt = now;
    } else if (target === 'FAILED') {
      data.failedAt = now;
      // ⚠️ `errorCode` NÃO é tocado. A API não manda um, e gravar `null` por cima
      // APAGARIA o código que o webhook de `message.failed` gravou — justamente o
      // 131026 que marca o contato como inalcançável-para-MARKETING (30% da base
      // medida). Só a EXPLICAÇÃO, que é o que a API de fato dá, é escrita.
      if (r.errorExplanation) data.errorMessage = r.errorExplanation;
    }

    const { count: advanced } = await this.prisma.message.updateMany({
      where: { id: messageId, status: { in: STATUSES_BELOW[target] } },
      data,
    });

    // ★ O `deliveredAt` é preenchido SÓ QUANDO AINDA ESTÁ VAZIO — e por isso sai
    // do update de cima.
    //
    // O comentário acima sempre prometeu isso, mas o código escrevia
    // `deliveredAt: now` junto com o status: um `read` reconciliado (que só é
    // aplicado sobre uma linha JÁ DELIVERED) reescrevia por cima da hora real que
    // o webhook havia gravado, trocando o instante da entrega pelo instante da
    // reconciliação — que o backoff deste serviço coloca até 30 min depois, e o
    // dead-letter, horas. Quem prova entrega para o TSE é esse timestamp.
    //
    // O `updateMany` escopado por `deliveredAt: null` faz o BANCO decidir: se já
    // existe hora, nenhuma linha casa.
    //
    // E só preenchemos quando a transição ACIMA de fato CASOU (`advanced === 1`).
    // Sem essa condição o preenchimento rodava mesmo com a transição recusada, e
    // o caso concreto é feio: chega `delivered` para uma linha que já está READ
    // com `deliveredAt` nulo — o primeiro update não casa (READ não está abaixo
    // de DELIVERED), mas o segundo gravaria a hora da RECONCILIAÇÃO, que o
    // backoff deste serviço coloca até 30 min DEPOIS do `readAt`. `deliveredAt >
    // readAt` é uma ordenação impossível, e é dela que o swim-lanes calcula
    // duração e largura de barra. Com a condição, `now` é sempre o mesmo
    // instante do `readAt`/status que acabamos de gravar.
    if (advanced === 1 && (target === 'DELIVERED' || target === 'READ')) {
      await this.prisma.message.updateMany({
        where: {
          id: messageId,
          deliveredAt: null,
          status: { in: ['DELIVERED', 'READ'] },
        },
        data: { deliveredAt: now },
      });
    }
  }

  private async reschedule(
    args: PollBroadcastArgs,
    attempt: number,
  ): Promise<void> {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      this.logger.warn(
        `broadcast ${args.localBroadcastId}: ${MAX_POLL_ATTEMPTS} tentativas de reconciliação ` +
          `e o Zernio ainda não deu status terminal a todo mundo — desistindo. Isto é ESPERADO: ` +
          `o /recipients reporta todos como "pending" indefinidamente. As mensagens ficam no ` +
          `estado que o WEBHOOK deixou, que é a fonte da verdade.`,
      );
      return;
    }
    await this.pollQueue.add(
      'poll',
      { ...args, attempt: attempt + 1 },
      {
        delay: pollDelayMs(attempt),
        removeOnComplete: { age: 3600, count: 20 },
      },
    );
  }
}
