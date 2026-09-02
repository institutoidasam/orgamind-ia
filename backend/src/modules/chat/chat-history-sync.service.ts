import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { QUEUE_NAMES, type ChatMediaDownloadJob } from '../queue/queue.constants';
import { MessageDirection, MessageKind, MessageStatus, MediaStatus } from '@prisma/client';
import { resolveContactByAnyBrForm } from './resolve-conversation';

const DEFAULT_MAX_PAGES = 5; // 5 * 50 = 250 most-recent messages per chat (bounded import)

@Injectable()
export class ChatHistorySyncService {
  private readonly logger = new Logger(ChatHistorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    @InjectQueue(QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD) private readonly mediaQueue: Queue<ChatMediaDownloadJob>,
  ) {}

  async syncInstance(instanceId: string, maxPagesPerChat = DEFAULT_MAX_PAGES): Promise<{ chats: number; messages: number }> {
    const inst = await this.prisma.channel.findUnique({ where: { id: instanceId }, select: { evolutionInstanceName: true, provider: true } });
    // Non-Evolution channels (Twilio/Zernio/Meta/GoZap) have no chat history to
    // pull from Evolution's findChats/findMessages — nothing to sync.
    //
    // C18 — o early-return silencioso era uma MENTIRA operacional: o operador de
    // um canal GOZAP disparava POST /chat/sync, a API respondia
    // `{enqueued:true}`, isto devolvia `{chats:0,messages:0}` sem erro e sem
    // aviso, e ele concluía que tinha sincronizado. Não há caminho de
    // recuperação para esses canais — a rede de segurança é o webhook chegar
    // inteiro —, então o mínimo é deixar rastro de que o pedido não fez nada.
    if (!inst || !inst.evolutionInstanceName) {
      this.logger.warn(
        { instanceId, provider: inst?.provider ?? null },
        'sync de histórico ignorado: só canal EVOLUTION tem histórico para importar — o pedido NÃO trouxe nada (não confunda com "não havia nada novo")',
      );
      return { chats: 0, messages: 0 };
    }
    const evoName = inst.evolutionInstanceName;
    const chats = await this.wa.findChats(evoName);
    // WhatsApp lists a contact under BOTH <lid>@lid and <phone>@s.whatsapp.net
    // once it has recent activity. Prefer the phone-addressed chat: a @lid chat
    // whose resolved phone already has a native @s.whatsapp.net chat is skipped
    // (avoids duplicate conversations for the same person).
    const phoneChatDigits = new Set(
      chats
        .filter((c) => c.remoteJid.endsWith('@s.whatsapp.net'))
        .map((c) => c.remoteJid.split('@')[0].replace(/\D/g, '')),
    );

    let chatCount = 0;
    let msgCount = 0;
    for (const chat of chats) {
      // 1:1 only. Keep classic phone JIDs (@s.whatsapp.net) AND the newer LID
      // addressing (@lid) that WhatsApp now uses for many contacts — skip only
      // groups / broadcasts / newsletters / status.
      const jid = chat.remoteJid;
      if (
        jid.endsWith('@g.us') ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter') ||
        jid === 'status@broadcast'
      )
        continue;
      if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
      // Dedup: a @lid chat that resolves to a phone already covered by a native
      // phone-addressed chat is the same contact — skip the @lid duplicate.
      if (jid.endsWith('@lid') && chat.altJid && chat.altJid.endsWith('@s.whatsapp.net')) {
        const altDigits = chat.altJid.split('@')[0].replace(/\D/g, '');
        if (phoneChatDigits.has(altDigits)) continue;
      }
      chatCount += 1;
      // One bad chat (transient Evolution error, malformed record) must not
      // abort the whole instance import. Log and move on — the import is
      // idempotent, so a re-run resumes cleanly.
      try {
        // Resolve the real number: a @lid's digits are an opaque LID, never a
        // phone — use the alt JID (remoteJidAlt) when present, else leave null
        // (unresolved) rather than storing a fake phone.
        const phoneSource =
          chat.altJid && chat.altJid.endsWith('@s.whatsapp.net')
            ? chat.altJid
            : jid.endsWith('@s.whatsapp.net')
              ? chat.remoteJid
              : null;
        const phoneE164 = phoneSource
          ? `+${phoneSource.split('@')[0].replace(/\D/g, '')}`
          : null;
        // Match the contact across both Brazilian 9th-digit forms (like the live
        // ingest path): Evolution may echo the legacy 8-digit JID while the
        // contact is saved with the extra 9 (or vice-versa). An exact match
        // would miss it and the imported thread would show "Número desconhecido".
        //
        // I13 — e com o MESMO desempate do resto do sistema. Um `findFirst` sem
        // `orderBy` devolve o gêmeo que o ÍNDICE entrega primeiro (o de 12 díg.),
        // que é o OPOSTO do que a audiência da campanha enxerga; o histórico
        // importado ficaria pendurado na linha errada do mesmo titular.
        const contact = phoneE164
          ? (await resolveContactByAnyBrForm(this.prisma, phoneE164)).contact
          : null;
        const conversation = await this.prisma.conversation.upsert({
          where: { instanceId_remoteJid: { instanceId, remoteJid: chat.remoteJid } },
          // Update phoneE164 too: a re-sync may now resolve the real number/name
          // that wasn't available on the first pass. Guard with `?? undefined`
          // (like the live path) so an unresolved re-sync never clobbers a
          // previously-resolved number back to null.
          update: { phoneE164: phoneE164 ?? undefined, waName: chat.name ?? undefined, profilePicUrl: chat.profilePicUrl ?? undefined, contactId: contact?.id ?? undefined },
          create: { instanceId, remoteJid: chat.remoteJid, phoneE164, contactId: contact?.id ?? null, waName: chat.name, profilePicUrl: chat.profilePicUrl, unreadCount: chat.unreadCount },
          select: { id: true, lastMessageAt: true },
        });

        msgCount += await this.importChat({
          conversationId: conversation.id, instanceId, evoName,
          contactId: contact?.id ?? null, remoteJid: chat.remoteJid, maxPagesPerChat,
          currentLastMessageAt: conversation.lastMessageAt,
        });
        // Note: unlike the live ingest path, the bulk import does NOT publish
        // per-message SSE events nor increment unreadCount (would mean thousands
        // of pushes and would clobber counts on re-run). unreadCount is only set
        // from Evolution's reported value on conversation create above.
      } catch (err) {
        this.logger.warn({ err, instanceId, remoteJid: chat.remoteJid }, 'chat history import failed for chat, skipping');
      }
    }
    this.logger.log({ instanceId, chats: chatCount, messages: msgCount }, 'chat history sync done');
    return { chats: chatCount, messages: msgCount };
  }

  private async importChat(args: {
    conversationId: string; instanceId: string; evoName: string; contactId: string | null;
    remoteJid: string; maxPagesPerChat: number; currentLastMessageAt: Date | null;
  }): Promise<number> {
    const { conversationId, instanceId, evoName, contactId, remoteJid, maxPagesPerChat, currentLastMessageAt } = args;
    let count = 0;
    let page = 1;
    let lastAt: Date | null = null;
    let lastPreview: string | null = null;
    let lastDir: MessageDirection | null = null;
    while (page <= maxPagesPerChat) {
      const res = await this.wa.findMessages(evoName, remoteJid, page, 50);
      const parsed = res.records
        .map((record) => this.wa.parseInboundChatMessages({ data: record })[0])
        .filter((m): m is NonNullable<typeof m> => !!m && !m.isGroup);
      const ids = parsed.map((m) => m.providerMessageId);
      // Batch existence check: one query per page instead of one per message (kills N+1).
      const existing = new Set(
        ids.length
          ? (await this.prisma.message.findMany({ where: { providerMessageId: { in: ids } }, select: { providerMessageId: true } })).map((r) => r.providerMessageId)
          : [],
      );
      for (const m of parsed) {
        if (existing.has(m.providerMessageId)) continue;
        const created = await this.prisma.message.create({
          data: {
            conversationId, instanceId, contactId,
            direction: m.fromMe ? MessageDirection.OUTBOUND : MessageDirection.INBOUND,
            kind: m.kind as MessageKind, content: m.text?.slice(0, 65536) ?? null,
            status: m.fromMe ? MessageStatus.SENT : MessageStatus.RECEIVED,
            providerMessageId: m.providerMessageId, quotedWaMessageId: m.quotedWaMessageId ?? null, quotedPreview: m.quotedPreview?.slice(0, 4096) ?? null,
            receivedAt: m.fromMe ? null : m.receivedAt, sentAt: m.fromMe ? m.receivedAt : null, createdAt: m.receivedAt,
            ...(m.media && m.kind !== 'TEXT'
              ? { media: { create: { kind: m.kind as MessageKind, status: MediaStatus.PENDING, mimeType: m.media.mimeType ?? null, fileName: m.media.fileName ?? null, sizeBytes: m.media.sizeBytes ?? null, durationSec: m.media.durationSec ?? null, width: m.media.width ?? null, height: m.media.height ?? null } } }
              : {}),
          },
          select: { id: true, media: { select: { id: true } } },
        });
        count += 1;
        // Track the NEWEST imported message (pages are not guaranteed strictly
        // ordered), so the preview/timestamp reflect the latest, not the last-iterated.
        if (!lastAt || m.receivedAt > lastAt) {
          lastAt = m.receivedAt; lastPreview = m.text ?? `[${m.kind.toLowerCase()}]`; lastDir = m.fromMe ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
        }
        if (m.media && m.kind !== 'TEXT' && created.media) {
          await this.mediaQueue.add('download', {
            messageMediaId: created.media.id, messageId: created.id, conversationId,
            instanceId, evolutionInstanceName: evoName, providerMessageId: m.providerMessageId,
            remoteJid: m.remoteJid, kind: m.kind, mimeType: m.media.mimeType ?? null, fromMe: m.fromMe,
          });
        }
      }
      if (res.currentPage >= res.pages || res.records.length === 0) break;
      if (page >= maxPagesPerChat) {
        // Hit the per-chat page cap with more pages available — surface the
        // truncation so it doesn't look like a complete import.
        this.logger.warn({ instanceId, remoteJid, importedPages: page, totalPages: res.pages }, 'chat history import truncated at page cap');
        break;
      }
      page += 1;
    }
    // Only advance the conversation summary when the newest imported message is
    // newer than what's already stored: importing older history must never drag
    // lastMessageAt/preview below a message the live webhook path already recorded
    // (the newest live message is in `existing` and skipped above).
    if (lastAt && (!currentLastMessageAt || lastAt > currentLastMessageAt)) {
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: lastAt, lastMessagePreview: lastPreview?.slice(0, 120) ?? null, lastMessageDirection: lastDir } });
    }
    return count;
  }
}
