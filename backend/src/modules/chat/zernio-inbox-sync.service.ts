import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatIngestService } from './chat-ingest.service';
import {
  ZernioInboxClient,
  type ZernioConversation,
  type ZernioInboxMessage,
} from '../whatsapp-providers/zernio-inbox.client';
import type { InboundChatMessage } from '../whatsapp-providers/ports/message-provider.port';
import { zernioSendHasPriority } from '../queue/zernio-send-priority.helper';

/**
 * Teto de páginas. Não é performance: é a garantia de que um `hasMore` eterno
 * (ou um cursor que o Zernio repita) não vira um laço infinito segurando o job.
 */
const MAX_CONVERSATION_PAGES = 20; // 20 × 100 = 2.000 conversas
const MAX_MESSAGE_PAGES = 10; // 10 × 100 = 1.000 mensagens por conversa

export type ZernioInboxSyncResult = {
  /** Conversas de WhatsApp visitadas. */
  conversations: number;
  /** Mensagens NOVAS de fato gravadas (duplicata não conta). */
  messages: number;
  /** Conversas que falharam (erro do Zernio) e foram puladas. */
  failed: number;
  /** Preenchido quando o canal inteiro foi pulado — e por quê. */
  skipped?: string;
  /** true => cedeu o balde para uma campanha; NÃO terminou. Ver `sendHasPriority`. */
  paused?: boolean;
  /** Onde retomar quando o envio liberar o balde. */
  resumeCursor?: string | null;
};

/** O que a tela mostra enquanto o job roda ("42 de 100 conversas…"). */
export type ZernioSyncProgress = {
  /** Conversas de WhatsApp descobertas até agora (o Zernio não dá total). */
  total: number;
  processed: number;
  imported: number;
  failed: number;
  /** Página onde retomar se o run morrer AGORA. */
  nextCursor?: string | null;
};

export type ZernioSyncChannelOptions = {
  /** Retomada: a página de conversas onde a execução anterior parou. */
  startCursor?: string;
  /** Chamado a cada conversa — o job persiste isto no `ZernioSyncRun`. */
  onProgress?: (p: ZernioSyncProgress) => Promise<void>;
};

/** `image` → IMAGE, etc. Sem anexo => TEXT. */
function kindOf(msg: ZernioInboxMessage): InboundChatMessage['kind'] {
  const type = msg.attachments[0]?.type;
  if (!type) return 'TEXT';
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'audio':
      return 'AUDIO';
    case 'file':
      return 'DOCUMENT';
    case 'sticker':
      return 'STICKER';
    default:
      return 'UNSUPPORTED';
  }
}

/**
 * Traz para a inbox do orgamind o que aconteceu no PAINEL do Zernio.
 *
 * O problema que isto resolve é concreto: um disparo de ~100 mensagens foi feito
 * pelo painel do Zernio, as pessoas responderam, e o orgamind não sabia de nada — a
 * inbox estava vazia. Mesmo com o webhook funcionando daqui para a frente, o
 * histórico ANTERIOR a ele não entra sozinho. O orgamind é a visão ÚNICA: o que
 * existe no Zernio tem de existir aqui, tenha sido enviado por onde for.
 *
 * Persistência: NÃO tem. Este serviço só traduz (Zernio → `InboundChatMessage`)
 * e delega ao {@link ChatIngestService}, o mesmo caminho do webhook — mesma
 * `Conversation`, mesma `Message`, mesma dedupe por `providerMessageId` (o
 * wamid). É isso que torna o sync IDEMPOTENTE de graça: rodar dez vezes grava
 * o que faltava e mais nada. Um segundo caminho de escrita aqui seria um segundo
 * modelo de conversa — e o fim da visão única.
 *
 * O modo `backfill` do ingest é o que impede que um import em massa fabrique
 * consentimento, ressuscite contato suprimido ou dispare o bot (ver
 * `IngestOptions`).
 */
@Injectable()
export class ZernioInboxSyncService {
  private readonly logger = new Logger(ZernioInboxSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioInboxClient,
    private readonly ingest: ChatIngestService,
  ) {}

  /** Todos os canais ZERNIO ativos e com conta resolvida — o tick do job. */
  async syncAllChannels(): Promise<
    ZernioInboxSyncResult & { channels: number }
  > {
    const total = { channels: 0, conversations: 0, messages: 0, failed: 0 };
    if (!this.client.configured) {
      return { ...total, skipped: 'ZERNIO_API_KEY não configurada' };
    }
    const channels = await this.prisma.channel.findMany({
      where: { provider: 'ZERNIO', isActive: true, zernioAccountId: { not: null } },
      select: { id: true },
    });
    for (const ch of channels) {
      total.channels += 1;
      // Um canal quebrado (conta removida no Zernio, 401) não pode derrubar os
      // outros — o tick seguinte tenta de novo.
      try {
        const r = await this.syncChannel(ch.id);
        total.conversations += r.conversations;
        total.messages += r.messages;
        total.failed += r.failed;
      } catch (err) {
        total.failed += 1;
        this.logger.warn(
          { err, channelId: ch.id },
          'sync do inbox do Zernio falhou para o canal — seguindo',
        );
      }
    }
    return total;
  }

  async syncChannel(
    channelId: string,
    opts: ZernioSyncChannelOptions = {},
  ): Promise<ZernioInboxSyncResult> {
    const empty = { conversations: 0, messages: 0, failed: 0 };
    if (!this.client.configured) {
      return { ...empty, skipped: 'ZERNIO_API_KEY não configurada' };
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, provider: true, isActive: true, zernioAccountId: true },
    });
    if (!channel) return { ...empty, skipped: 'canal não encontrado' };
    if (channel.provider !== 'ZERNIO') {
      return { ...empty, skipped: `canal não é ZERNIO (${channel.provider})` };
    }
    if (!channel.isActive) return { ...empty, skipped: 'canal inativo' };
    // Sem accountId não há como pedir NADA ao Zernio (nem conversas, nem
    // mensagens — o accountId é obrigatório nos dois endpoints).
    if (!channel.zernioAccountId) {
      return { ...empty, skipped: 'canal sem zernioAccountId' };
    }

    const accountId = channel.zernioAccountId;
    let conversations = 0;
    let messages = 0;
    let failed = 0;
    // Retomada: começa na página onde a execução anterior parou. O que já entrou
    // continua valendo (o ingest grava conversa a conversa) e o que for revisto
    // não duplica — a dedupe é por wamid.
    let cursor: string | undefined = opts.startCursor;

    /** Conversas de WhatsApp DESCOBERTAS (o Zernio não devolve total algum). */
    let discovered = 0;

    for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
      const res = await this.client.listConversations(channelId, accountId, cursor);

      // A conta Zernio pode ter Instagram/Telegram no mesmo inbox; o canal do
      // orgamind é WhatsApp, e um DM de Instagram não tem telefone nem janela.
      const whatsapp = res.items.flatMap((conv) => {
        if (conv.platform !== 'whatsapp') return [];
        const digits = conv.participantId.replace(/\D/g, '');
        return digits ? [{ conv, digits }] : [];
      });
      discovered += whatsapp.length;

      for (const { conv, digits } of whatsapp) {
        // PRIORIDADE DO ENVIO: antes de gastar mais um slot do balde, checa se
        // há campanha disparando neste canal. Se há, o sync PARA aqui e devolve
        // o cursor — ele é backfill de histórico e pode esperar; a campanha, não.
        if (await this.sendHasPriority(channelId)) {
          this.logger.log(
            { channelId, processed: conversations },
            'campanha ativa no canal — sync do inbox cedeu o balde do Zernio',
          );
          return {
            conversations,
            messages,
            failed,
            paused: true,
            resumeCursor: cursor ?? null,
          };
        }

        conversations += 1;
        try {
          messages += await this.syncConversation(channelId, accountId, conv, digits);
        } catch (err) {
          // Uma conversa que falha (inclusive um 429 que não cedeu) é UMA
          // conversa perdida, não o sync inteiro. Vira número na tela.
          failed += 1;
          this.logger.warn(
            { err, channelId, conversationId: conv.id },
            'falha importando a conversa do Zernio — pulando',
          );
        }
        // O cursor reportado é o da página ATUAL, não o da próxima: se o job
        // morrer aqui no meio, a retomada REFAZ esta página (idempotente por
        // wamid) em vez de pular as conversas que ainda faltavam nela.
        await opts.onProgress?.({
          total: discovered,
          processed: conversations,
          imported: messages,
          failed,
          nextCursor: cursor ?? null,
        });
      }

      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;

      // Página inteira concluída: agora sim o ponto de retomada avança.
      await opts.onProgress?.({
        total: discovered,
        processed: conversations,
        imported: messages,
        failed,
        nextCursor: cursor,
      });

      if (page === MAX_CONVERSATION_PAGES - 1) {
        this.logger.warn(
          { channelId, pages: MAX_CONVERSATION_PAGES },
          'sync do inbox do Zernio truncado no teto de páginas de conversas',
        );
      }
    }

    this.logger.log(
      { channelId, conversations, messages, failed },
      'sync do inbox do Zernio concluído',
    );
    return { conversations, messages, failed };
  }

  /**
   * Há campanha disparando neste canal? Se sim, o sync cede o balde.
   *
   * A regra mora em `zernioSendHasPriority` — é a MESMA para o sync do inbox e
   * para o sync de disparos (ZD), e duas cópias divergiriam. Consultada a cada
   * conversa: o sync anda a ~1 conversa/s, então é uma query indexada por
   * segundo — barato.
   */
  private sendHasPriority(channelId: string): Promise<boolean> {
    return zernioSendHasPriority(this.prisma, [channelId]);
  }

  /** Importa uma conversa inteira. Devolve quantas mensagens eram NOVAS. */
  private async syncConversation(
    channelId: string,
    accountId: string,
    conv: ZernioConversation,
    digits: string,
  ): Promise<number> {
    let imported = 0;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const res = await this.client.listMessages(
        channelId,
        conv.id,
        accountId,
        cursor,
      );
      const parsed = res.items.map((msg) => this.toInbound(conv, msg, digits));
      imported += await this.ingest.ingestMessages(parsed, channelId, {
        backfill: true,
      });
      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
      if (page === MAX_MESSAGE_PAGES - 1) {
        this.logger.warn(
          { channelId, conversationId: conv.id, pages: MAX_MESSAGE_PAGES },
          'importação da conversa truncada no teto de páginas de mensagens',
        );
      }
    }

    // Foto do participante: o Zernio já a entrega na listagem, então o ingest
    // não precisa (nem deve) ir buscá-la no provedor. Best-effort — um avatar é
    // cosmético e jamais pode fazer a importação falhar.
    if (conv.participantPicture) {
      try {
        await this.prisma.conversation.update({
          where: {
            instanceId_remoteJid: {
              instanceId: channelId,
              remoteJid: `${digits}@s.whatsapp.net`,
            },
          },
          data: {
            profilePicUrl: conv.participantPicture,
            profilePicFetchedAt: new Date(),
          },
        });
      } catch {
        // a conversa pode nem existir (nenhuma mensagem importada) — tudo bem
      }
    }

    return imported;
  }

  /**
   * Zernio → `InboundChatMessage`, a moeda comum do ingest.
   *
   * `providerMessageId` é o `id` da mensagem, que NESTA API REST já é o wamid
   * ("wamid.HBgM…"). É a mesma chave que o webhook grava (lá o wamid vem em
   * `platformMessageId`) — e é só por isso que o backfill não duplica o que o
   * webhook já trouxe.
   *
   * Mídia: o anexo vira `kind` (IMAGE/AUDIO/…), mas o binário NÃO é baixado. O
   * pipeline de mídia é chaveado por Evolution/Twilio; enfiar uma URL do Zernio
   * nele baixaria lixo ou falharia em massa. A mensagem entra na inbox com o
   * texto/legenda e o tipo correto — o arquivo em si fica no painel do Zernio.
   */
  private toInbound(
    conv: ZernioConversation,
    msg: ZernioInboxMessage,
    digits: string,
  ): InboundChatMessage {
    return {
      providerMessageId: msg.id,
      remoteJid: `${digits}@s.whatsapp.net`,
      phoneE164: `+${digits}`,
      isGroup: false,
      fromMe: msg.direction === 'outgoing',
      pushName: conv.participantName ?? msg.senderName ?? undefined,
      kind: kindOf(msg),
      text: msg.message ?? undefined,
      receivedAt: new Date(msg.createdAt),
    };
  }
}
