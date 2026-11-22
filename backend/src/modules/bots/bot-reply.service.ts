import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { MEDIA_STORE, type MediaStore } from '../../shared/media/media-store.port';
import { ChatService } from '../chat/chat.service';
import { ChatRepository } from '../chat/chat.repository';
import {
  DifyClient,
  type DifyChatArgs,
  type DifyChatResult,
  type DifyFile,
} from './dify.client';
import { shouldReply } from './bot-reply.guard';
import type { Env } from '../../shared/config/env.schema';

const LOCK_TTL_MS = 120_000;
const RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const KIND_TO_DIFY: Record<string, DifyFile['type']> = { IMAGE: 'image', AUDIO: 'audio' };
// GT11: log do robô só com ids e o nome do erro, nunca mensagem/texto.
const errName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;

@Injectable()
export class BotReplyService {
  private readonly logger = new Logger(BotReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dify: DifyClient,
    private readonly chat: ChatService,
    private readonly chatRepo: ChatRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env>,
    @Inject(MEDIA_STORE) private readonly store: MediaStore,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async handle(conversationId: string, messageId: string): Promise<void> {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        media: { select: { storageKey: true, status: true, mimeType: true, fileName: true } },
        conversation: {
          select: {
            id: true, phoneE164: true, botPausedAt: true, difyConversationId: true,
            contact: { select: { optedOut: true } },
            instance: {
              select: {
                id: true, botId: true, provider: true,
                bot: { select: { id: true, isActive: true, difyApiKey: true, difyBaseUrl: true, fallbackMessage: true, inputs: true } },
              },
            },
          },
        },
      },
    });
    const conv = msg?.conversation;
    const bot = conv?.instance.bot;
    if (!msg || !conv || !bot) return;

    const allowed = shouldReply({
      // The conversation's own channel provider — already loaded above, no
      // redundant query — NOT the deploy's legacy global WHATSAPP_PROVIDER.
      // A deploy can run Evolution + Twilio channels side by side; only the
      // Evolution channel feeds Dify bot replies today.
      channelProvider: conv.instance.provider,
      hasBot: conv.instance.botId !== null,
      botIsActive: bot.isActive,
      contactOptedOut: conv.contact?.optedOut ?? false,
      botPausedAt: conv.botPausedAt,
      direction: msg.direction,
      kind: msg.kind,
    });
    if (!allowed) return;

    const baseUrl = bot.difyBaseUrl ?? this.config.get('DIFY_BASE_URL', { infer: true });
    if (!baseUrl) {
      this.logger.warn(`bot ${bot.id} has no Dify base URL (env DIFY_BASE_URL unset); skipping`);
      return;
    }

    // Serializa respostas da mesma conversa (Dify rejeita chamadas concorrentes
    // no mesmo conversation_id). Lock ocupado → lança p/ BullMQ tentar de novo.
    const lockKey = `bot:reply:lock:${conversationId}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.set(lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') throw new Error(`bot reply lock busy for ${conversationId}`);

    try {
      // Dify binds difyConversationId to the `user` it was created under. phoneE164 is
      // mutable (resolved later from an @lid altJid), so keying `user` off it would switch
      // the identity mid-conversation and make Dify 404 the stored conversation_id. Use the
      // conversation id — a stable identifier for the whole conversation's life.
      const user = conv.id;
      let files: DifyFile[];
      try {
        files = await this.buildFiles(msg, baseUrl, bot.difyApiKey, user);
      } catch (err) {
        // Mídia falhou antes do Dify: handoff imediato é seguro (ver buildFiles).
        await this.handleMediaFailure(
          conversationId,
          bot.id,
          bot.fallbackMessage,
          err,
        );
        return;
      }
      const query = (msg.content ?? msg.transcript ?? '').trim() || ' ';

      const result = await this.askDify({
        conversationId,
        botId: bot.id,
        fallbackMessage: bot.fallbackMessage,
        chatArgs: {
          baseUrl, apiKey: bot.difyApiKey, query, user,
          conversationId: conv.difyConversationId,
          inputs: (bot.inputs as Record<string, unknown> | null) ?? {},
          files,
        },
      });
      if (!result) return;
      const { answer, conversationId: difyConversationId } = result;

      if (!conv.difyConversationId && difyConversationId) {
        await this.chatRepo.setDifyConversationId(conversationId, difyConversationId);
      }
      await this.sendAnswer(conversationId, bot.id, answer);
    } finally {
      await this.releaseLock(lockKey, lockToken, conversationId);
    }
  }

  // K3-7(c)/(e): resposta vazia não sai; depois do Dify nada relança — o BullMQ
  // retentaria (Dify + envio de novo) e violaria "no máximo uma resposta".
  private async sendAnswer(
    conversationId: string,
    botId: string,
    answer: string,
  ): Promise<void> {
    if (answer.trim().length === 0) return;
    try {
      await this.chat.sendBotReply(conversationId, answer, botId);
    } catch (err) {
      await this.handleSendFailure(conversationId, botId, err);
    }
  }

  // Nunca lança: a trava expira pelo TTL, então falhar aqui não pode virar retentativa.
  private async releaseLock(
    lockKey: string,
    lockToken: string,
    conversationId: string,
  ): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
    } catch (err) {
      this.logger.warn(
        { conversationId, errName: errName(err) },
        'bot reply lock release failed; TTL will expire it',
      );
    }
  }

  // Chama o Dify. Em erro faz o handoff imediato e devolve null.
  private async askDify(req: {
    conversationId: string;
    botId: string;
    fallbackMessage: string | null;
    chatArgs: DifyChatArgs;
  }): Promise<DifyChatResult | null> {
    const { conversationId, botId, fallbackMessage, chatArgs } = req;
    try {
      return await this.dify.chat(chatArgs);
    } catch (err) {
      // If Dify rejects the stored conversation_id as unknown (404 "Conversation
      // Not Exists" — e.g. the Dify-side conversation was deleted, or the app/key
      // changed without a reset), clear it so the NEXT message starts a fresh Dify
      // conversation instead of looping resume → 404 → handoff.
      if (chatArgs.conversationId && this.isStaleConversationError(err)) {
        await this.chatRepo.clearDifyConversationId(conversationId);
      }
      // DELIBERATE immediate handoff: on a Dify error we pause the bot and hand off to
      // a human right away, rather than relying on BullMQ retries. This prevents duplicate
      // replies if a retry succeeds after a timeout where Dify already processed the message.
      await this.handleFailure(conversationId, botId, fallbackMessage, err);
      return null;
    }
  }

  // Falha de storage/upload acontece antes do Dify: nada foi processado, então o
  // handoff imediato é seguro. Relançar esgotaria as retentativas do BullMQ e
  // deixaria o cliente sem resposta, sem pausa e sem aviso.
  private async buildFiles(
    msg: { kind: string; media: { storageKey: string | null; status: string; mimeType: string | null; fileName: string | null } | null },
    baseUrl: string,
    apiKey: string,
    user: string,
  ): Promise<DifyFile[]> {
    const type = KIND_TO_DIFY[msg.kind];
    if (!type || !msg.media || msg.media.status !== 'READY' || !msg.media.storageKey) return [];
    const bytes = await this.store.getBuffer(msg.media.storageKey);
    const uploaded = await this.dify.uploadFile({
      baseUrl, apiKey, user, bytes,
      fileName: msg.media.fileName ?? `media-${type}`,
      mimeType: msg.media.mimeType ?? 'application/octet-stream',
    });
    return [{ type, transfer_method: 'local_file', upload_file_id: uploaded.id }];
  }

  /**
   * True when a Dify error indicates the supplied conversation_id no longer
   * exists on Dify's side (404 "Conversation Not Exists"), so reusing it will
   * keep failing until it is cleared.
   */
  private isStaleConversationError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const m = err.message.toLowerCase();
    return m.includes('conversation not exist') || (m.includes('404') && m.includes('conversation'));
  }

  private async handleFailure(
    conversationId: string,
    botId: string,
    fallbackMessage: string | null,
    err: unknown,
  ): Promise<void> {
    this.logger.warn({ err, conversationId }, 'Dify reply failed; pausing bot for handoff');
    await this.sendFallback(conversationId, botId, fallbackMessage);
    await this.pauseAndAudit(conversationId, botId, {
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
  }

  // GT11: a mensagem de erro de storage/upload pode trazer o caminho do disco, o
  // storageKey ou o nome do arquivo de quem enviou; log e auditoria só com o nome do erro.
  private async handleMediaFailure(
    conversationId: string,
    botId: string,
    fallbackMessage: string | null,
    err: unknown,
  ): Promise<void> {
    this.logger.warn(
      { conversationId, botId, errName: errName(err) },
      'bot media failed; pausing bot for handoff',
    );
    await this.sendFallback(conversationId, botId, fallbackMessage);
    await this.pauseAndAudit(conversationId, botId, {
      stage: 'media',
      errName: errName(err),
    });
  }

  private async sendFallback(
    conversationId: string,
    botId: string,
    fallbackMessage: string | null,
  ): Promise<void> {
    if (!fallbackMessage || fallbackMessage.trim().length === 0) return;
    try {
      await this.chat.sendBotReply(conversationId, fallbackMessage, botId);
    } catch {
      // best-effort
    }
  }

  // O envio da resposta falhou: pode ter saído, então só pausa e audita (sem
  // contingência) e nunca relança.
  private async handleSendFailure(
    conversationId: string,
    botId: string,
    err: unknown,
  ): Promise<void> {
    this.logger.warn(
      { conversationId, botId, errName: errName(err) },
      'bot reply send failed; pausing bot',
    );
    await this.pauseAndAudit(conversationId, botId, { stage: 'send' });
  }

  // Pausa e trilha de `bot.reply_failed`, cada uma isolada: nunca lança, pois
  // depois de o envio começar uma exceção viraria retentativa (resposta duplicada).
  private async pauseAndAudit(
    conversationId: string,
    botId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.chatRepo.setBotPaused(conversationId);
    } catch (err) {
      this.logger.warn(
        { conversationId, botId, errName: errName(err) },
        'bot pause failed after reply failure',
      );
    }
    try {
      await this.audit.log('bot.reply_failed', 'Conversation', conversationId, {
        botId,
        ...details,
      });
    } catch (err) {
      this.logger.warn(
        { conversationId, botId, errName: errName(err) },
        'bot.reply_failed audit failed',
      );
    }
  }
}
