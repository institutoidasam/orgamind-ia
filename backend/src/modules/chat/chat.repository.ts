import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ListConversationsQuery, ListMessagesQuery, ConversationsPage, ChatMessage, MessagesPage } from '../../schemas/contracts/chat.schema';
import { conversationSummaryInclude, toConversationSummary } from './conversation-summary.mapper';
import { resolveConversationForOutbound } from './resolve-conversation';

@Injectable()
export class ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listConversations(q: ListConversationsQuery): Promise<ConversationsPage> {
    const where: Record<string, unknown> = { archivedAt: null };
    if (q.filter === 'unread') where.unreadCount = { gt: 0 };
    // "Aguardando resposta": a última mensagem foi do CONTATO e ninguém
    // respondeu ainda — diferente de 'unread', que zera assim que o operador
    // ABRE a conversa (mesmo sem responder).
    if (q.filter === 'awaiting') where.lastMessageDirection = 'INBOUND';
    if (q.instanceId) where.instanceId = q.instanceId;
    // The service resolves 'me' to the caller's id before reaching the repo, so
    // here 'assignee' is either 'unassigned' (no assignee) or a concrete userId.
    if (q.assignee === 'unassigned') where.assignedUserId = null;
    else if (q.assignee) where.assignedUserId = q.assignee;
    // Provider filter (F4b): must run server-side, before the page cut, same
    // as the filters above — a client-side filter over an already-paginated
    // page hides matches beyond the first page. `provider` lives on the
    // joined Channel (instance), so this is a relation filter rather than a
    // scalar where — Prisma emits it as a join/EXISTS against Channel, which
    // doesn't hit Conversation's own [instanceId, archivedAt, lastMessageAt]
    // composite index for this predicate. Channel.provider is itself indexed
    // (@@index([provider, isActive])), and in practice this filter is either
    // combined with instanceId (already narrow) or used alone on a small
    // conversations table, so the extra join stays cheap. If provider-only
    // filtering on a large table ever shows up in slow-query logs, consider
    // denormalizing `provider` onto Conversation as an indexed scalar.
    if (q.provider) where.instance = { provider: q.provider };
    if (q.search) {
      where.OR = [
        { phoneE164: { contains: q.search } },
        { waName: { contains: q.search, mode: 'insensitive' } },
        { contact: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.conversation.findMany({
        // NULLS LAST explícito: no Postgres, `desc` ordena NULLS FIRST por
        // padrão, então QUALQUER conversa sem resumo (lastMessageAt NULL) ficava
        // grudada acima de todas as conversas reais — o topo da inbox do
        // operador reservado justamente para as linhas que não têm nada a
        // mostrar.
        where, orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: conversationSummaryInclude,
      }),
      this.prisma.conversation.count({ where }),
    ]);
    const items = rows.map(toConversationSummary);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async listMessages(conversationId: string, q: ListMessagesQuery): Promise<MessagesPage> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId }, orderBy: { createdAt: 'desc' }, take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { media: true },
    });
    const items: ChatMessage[] = rows.map((m: any) => this.toChatMessage(m)).reverse(); // chronological (oldest -> newest) for rendering
    const nextCursor = rows.length === q.limit ? rows[rows.length - 1].id : null;
    return { items, nextCursor };
  }

  findConversation(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id }, include: conversationSummaryInclude,
    });
  }

  /** Cheap existence check (id-only) for guards that don't need the joined row. */
  async conversationExists(id: string): Promise<boolean> {
    const row = await this.prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  }

  async assignConversation(id: string, userId: string | null): Promise<void> {
    await this.prisma.conversation.update({
      where: { id },
      data: { assignedUserId: userId, assignedAt: userId ? new Date() : null },
    });
  }

  private toChatMessage(m: any): ChatMessage {
    return {
      id: m.id, conversationId: m.conversationId, direction: m.direction, kind: m.kind, content: m.content,
      status: m.status, providerMessageId: m.providerMessageId, quotedWaMessageId: m.quotedWaMessageId, quotedPreview: m.quotedPreview,
      createdAt: m.createdAt.toISOString(), sentAt: m.sentAt?.toISOString() ?? null, deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null, receivedAt: m.receivedAt?.toISOString() ?? null,
      media: m.media ? { id: m.media.id, kind: m.media.kind, status: m.media.status, mimeType: m.media.mimeType, fileName: m.media.fileName, sizeBytes: m.media.sizeBytes, durationSec: m.media.durationSec, width: m.media.width, height: m.media.height } : null,
      transcript: m.transcript ?? null,
      botId: m.botId ?? null,
      errorCode: m.errorCode ?? null,
    };
  }

  getConversationForSend(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      // provider + remetente do canal: o envio de chat roteia por provider
      // (TWILIO → sendChatTextVia com o remetente do canal; senão Evolution).
      include: {
        instance: {
          select: {
            id: true,
            evolutionInstanceName: true,
            provider: true,
            phoneE164: true,
            twilioMessagingServiceSid: true,
            zernioAccountId: true,
          },
        },
      },
    });
  }

  async createOutboundMessage(args: {
    conversationId: string; instanceId: string; contactId: string | null;
    content: string; authorUserId: string | null; botId: string | null;
    quotedWaMessageId: string | null; quotedPreview: string | null;
  }): Promise<string> {
    const m = await this.prisma.message.create({
      data: {
        conversationId: args.conversationId, instanceId: args.instanceId, contactId: args.contactId,
        direction: 'OUTBOUND', kind: 'TEXT', content: args.content, status: 'QUEUED',
        authorUserId: args.authorUserId, botId: args.botId,
        quotedWaMessageId: args.quotedWaMessageId, quotedPreview: args.quotedPreview,
      },
      select: { id: true },
    });
    return m.id;
  }

  async setBotPaused(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { botPausedAt: new Date() } });
  }

  async clearBotPaused(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { botPausedAt: null } });
  }

  async setDifyConversationId(conversationId: string, difyConversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { difyConversationId } });
  }

  /**
   * Clear a single conversation's stored Dify conversation_id. Used when Dify
   * rejects a stale/unknown conversation_id (404 "Conversation Not Exists") so
   * the next inbound message starts a fresh Dify conversation instead of
   * looping resume → 404 → handoff.
   */
  async clearDifyConversationId(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { difyConversationId: null } });
  }

  async resetDifyConversationIdsForInstance(instanceId: string): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { instanceId, difyConversationId: { not: null } },
      data: { difyConversationId: null },
    });
  }

  async markChatSent(messageId: string, instanceId: string, providerMessageId: string, sentAt: Date): Promise<void> {
    await this.prisma.message.update({ where: { id: messageId }, data: { status: 'SENT', providerMessageId, sentAt } });
    await this.prisma.channel.update({ where: { id: instanceId }, data: { sentToday: { increment: 1 } } });
  }

  /**
   * `errorCode` é o código CRU do provedor (`gozap.timeout`,
   * `evolution.not_connected`…) — a mesma coluna que o caminho de campanha já
   * preenche (ver `campaigns.repository.ts`). Antes, o chat só gravava
   * `errorMessage` (já traduzido para PT-BR): quando o operador relatava uma
   * falha, não havia como saber qual foi o erro do provedor sem acesso ao log
   * da aplicação. `null` explícito (não omitido) quando o erro não carrega
   * código — mesmo padrão usado no resto do módulo de campanhas.
   */
  async markChatFailed(messageId: string, errorMessage: string, errorCode: string | null = null): Promise<void> {
    await this.prisma.message.update({ where: { id: messageId }, data: { status: 'FAILED', failedAt: new Date(), errorMessage: errorMessage.slice(0, 500), errorCode } });
  }

  /**
   * Liga uma Message JÁ ENVIADA por uma campanha à sua Conversation e avança o
   * resumo denormalizado da conversa.
   *
   * Sem isto, o envio de campanha gravava a Message solta: a thread do Inbox
   * filtra por `conversationId` e a lista lateral lê `lastMessageAt` /
   * `lastMessagePreview` (colunas da Conversation, não da Message) — daí a linha
   * sem preview e sem horário. É o ÚNICO ponto de escrita que liga o envio de
   * campanha à visão única de conversa; não existe um segundo modelo de conversa.
   *
   * Devolve o id da conversa (para o evento SSE do chamador).
   */
  async linkOutboundCampaignMessage(args: {
    messageId: string;
    instanceId: string;
    contactId: string | null;
    phoneE164: string;
    content: string;
    sentAt: Date;
  }): Promise<string> {
    // RESOLVE a conversa que o ingest já criou (por contato, por variante BR do
    // telefone ou pelo JID) em vez de FABRICAR `${digits}@s.whatsapp.net`: o
    // remoteJid é do provedor (forma legada de 8 dígitos, @lid do Evolution…) e
    // adivinhá-lo criaria uma SEGUNDA conversa para a mesma pessoa. Ver
    // resolve-conversation.ts.
    const conversation = await resolveConversationForOutbound(this.prisma as never, {
      instanceId: args.instanceId,
      contactId: args.contactId,
      phoneE164: args.phoneE164,
    });

    await this.prisma.message.update({
      where: { id: args.messageId },
      data: { conversationId: conversation.id },
    });

    // Guard de monotonicidade (mesma regra do ingest): um envio antigo (retry,
    // backfill) não pode puxar o resumo da conversa para trás por cima de uma
    // mensagem mais recente.
    const advanceSummary = !conversation.lastMessageAt || args.sentAt >= conversation.lastMessageAt;

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: advanceSummary
        ? {
            lastMessageAt: args.sentAt,
            lastMessagePreview: args.content.slice(0, 120),
            lastMessageDirection: 'OUTBOUND',
          }
        : {},
      // NUNCA toca lastInboundAt (só INBOUND abre a janela de 24h) nem
      // unreadCount (o operador não tem "não lida" da própria mensagem).
    });

    return conversation.id;
  }

  async touchConversationOutbound(conversationId: string, preview: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), lastMessagePreview: preview.slice(0, 120), lastMessageDirection: 'OUTBOUND' },
    });
  }

  async createOutboundMediaMessage(args: {
    conversationId: string; instanceId: string; contactId: string | null; authorUserId: string;
    kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'; content: string | null;
    mimeType: string; fileName: string | null; sizeBytes: number; storageKey: string;
  }): Promise<string> {
    const m = await this.prisma.message.create({
      data: {
        conversationId: args.conversationId, instanceId: args.instanceId, contactId: args.contactId,
        direction: 'OUTBOUND', kind: args.kind, content: args.content, status: 'QUEUED', authorUserId: args.authorUserId,
        media: { create: { kind: args.kind, status: 'READY', mimeType: args.mimeType, fileName: args.fileName, sizeBytes: args.sizeBytes, storageKey: args.storageKey } },
      },
      select: { id: true },
    });
    return m.id;
  }

  /**
   * One page of inbound provider-message keys for a conversation, newest-first.
   * Cursor-paginated (by message id) so callers can ack EVERY unread inbound
   * before zeroing unreadCount — a single capped page would leave older unread
   * messages unacked on WhatsApp while the local count reads zero.
   */
  async getUnreadInboundKeys(
    conversationId: string,
    remoteJid: string,
    limit: number,
    cursor?: string,
  ): Promise<{ keys: Array<{ remoteJid: string; fromMe: boolean; id: string }>; nextCursor: string | null }> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId, direction: 'INBOUND', providerMessageId: { not: null } },
      orderBy: { createdAt: 'desc' }, take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, providerMessageId: true },
    });
    const keys = rows
      .filter((r): r is { id: string; providerMessageId: string } => r.providerMessageId !== null)
      .map((r) => ({ remoteJid, fromMe: false, id: r.providerMessageId }));
    const nextCursor = rows.length === limit && rows.length > 0 ? rows[rows.length - 1].id : null;
    return { keys, nextCursor };
  }

  async resetUnread(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { unreadCount: 0 } });
  }

  async getMessageById(id: string): Promise<ChatMessage | null> {
    const m = await this.prisma.message.findUnique({ where: { id }, include: { media: true } });
    return m ? this.toChatMessage(m) : null;
  }
}
