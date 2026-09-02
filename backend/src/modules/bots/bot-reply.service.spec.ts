import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { BotReplyService } from './bot-reply.service';
import { DifyClient } from './dify.client';
import { ChatService } from '../chat/chat.service';
import { ChatRepository } from '../chat/chat.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import type { Env } from '../../shared/config/env.schema';

type Redisish = { set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn> };

function make() {
  const prisma = mockDeep<PrismaService>();
  const dify = mockDeep<DifyClient>();
  const chat = mockDeep<ChatService>();
  const chatRepo = mockDeep<ChatRepository>();
  const audit = mockDeep<AuditService>();
  const store = mockDeep<MediaStore>();
  const redis: Redisish = { set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1), eval: vi.fn().mockResolvedValue(1) };
  const config = { get: vi.fn().mockReturnValue('https://env.dify/v1') } as unknown as ConfigService<Env>;
  const svc = new BotReplyService(prisma, dify, chat, chatRepo, audit, config, store as never, redis as never);
  return { svc, prisma, dify, chat, chatRepo, audit, store, redis, config };
}

const textCtx = {
  id: 'm1', conversationId: 'c1', direction: 'INBOUND', kind: 'TEXT',
  content: 'oi', transcript: null, media: null,
  conversation: {
    id: 'c1', phoneE164: '+5592', botPausedAt: null, difyConversationId: null,
    instance: { id: 'i1', botId: 'b1', provider: 'EVOLUTION', bot: { id: 'b1', isActive: true, difyApiKey: 'k', difyBaseUrl: null, fallbackMessage: null, inputs: null } },
    contact: { optedOut: false },
  },
} as never;

const staleConvCtx = {
  ...(textCtx as Record<string, unknown>),
  conversation: {
    id: 'c1', phoneE164: '+5592', botPausedAt: null, difyConversationId: 'stale-dc',
    instance: { id: 'i1', botId: 'b1', provider: 'EVOLUTION', bot: { id: 'b1', isActive: true, difyApiKey: 'k', difyBaseUrl: null, fallbackMessage: null, inputs: null } },
    contact: { optedOut: false },
  },
} as never;

describe('BotReplyService.handle', () => {
  it('clears a stale difyConversationId when Dify 404s "Conversation Not Exists", then hands off', async () => {
    const { svc, prisma, dify, chatRepo } = make();
    prisma.message.findUnique.mockResolvedValue(staleConvCtx);
    dify.chat.mockRejectedValue(new Error('Dify chat failed: 404 {"code":"not_found","message":"Conversation Not Exists"}'));

    await svc.handle('c1', 'm1');

    expect(chatRepo.clearDifyConversationId).toHaveBeenCalledWith('c1');
    expect(chatRepo.setBotPaused).toHaveBeenCalledWith('c1');
  });

  it('does NOT clear difyConversationId on an unrelated Dify error', async () => {
    const { svc, prisma, dify, chatRepo } = make();
    prisma.message.findUnique.mockResolvedValue(staleConvCtx);
    dify.chat.mockRejectedValue(new Error('Dify chat failed: 500 upstream boom'));

    await svc.handle('c1', 'm1');

    expect(chatRepo.clearDifyConversationId).not.toHaveBeenCalled();
    expect(chatRepo.setBotPaused).toHaveBeenCalledWith('c1');
  });

  it('calls Dify with phone as user, persists conversation_id, sends the answer', async () => {
    const { svc, prisma, dify, chat, chatRepo, redis } = make();
    prisma.message.findUnique.mockResolvedValue(textCtx);
    dify.chat.mockResolvedValue({ answer: 'olá!', conversationId: 'dify-c-9', messageId: 'dify-m' });

    await svc.handle('c1', 'm1');

    expect(dify.chat).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://env.dify/v1', apiKey: 'k', query: 'oi', user: 'c1', conversationId: null, files: [],
    }));
    expect(chatRepo.setDifyConversationId).toHaveBeenCalledWith('c1', 'dify-c-9');
    expect(chat.sendBotReply).toHaveBeenCalledWith('c1', 'olá!', 'b1');

    // Fenced lock release: eval must be called with the same token that set was called with
    const lockToken = redis.set.mock.calls[0][1] as string;
    const RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    expect(redis.eval).toHaveBeenCalledWith(RELEASE_LOCK_LUA, 1, 'bot:reply:lock:c1', lockToken);
  });

  it('sends conv.id as the Dify user (stable) even after phoneE164 is resolved, keeping difyConversationId valid', async () => {
    // An @lid contact's first message had phoneE164=null → Dify conversation created under conv.id.
    // A later message resolves phoneE164. The user key must NOT switch to the phone, otherwise
    // Dify rejects the stored conversation_id (created under conv.id) with 404.
    const { svc, prisma, dify } = make();
    prisma.message.findUnique.mockResolvedValue({
      ...(textCtx as object),
      conversation: {
        ...(textCtx as { conversation: object }).conversation,
        phoneE164: '+5592988887777',
        difyConversationId: 'dify-created-under-conv-id',
      },
    } as never);
    dify.chat.mockResolvedValue({ answer: 'ok', conversationId: 'dify-created-under-conv-id', messageId: 'm' });

    await svc.handle('c1', 'm1');

    expect(dify.chat).toHaveBeenCalledWith(expect.objectContaining({
      user: 'c1',
      conversationId: 'dify-created-under-conv-id',
    }));
  });

  it('skips entirely when guard fails (bot paused)', async () => {
    const { svc, prisma, dify, chat } = make();
    prisma.message.findUnique.mockResolvedValue({
      ...(textCtx as object),
      conversation: { ...(textCtx as { conversation: object }).conversation, botPausedAt: new Date() },
    } as never);
    await svc.handle('c1', 'm1');
    expect(dify.chat).not.toHaveBeenCalled();
    expect(chat.sendBotReply).not.toHaveBeenCalled();
  });

  it('skips entirely when the conversation channel is not Evolution (e.g. TWILIO)', async () => {
    // The guard now decides on the CONVERSATION's channel provider (loaded via
    // conv.instance.provider), not the deploy's legacy global WHATSAPP_PROVIDER —
    // a Twilio channel must never trigger a Dify reply.
    const { svc, prisma, dify, chat } = make();
    prisma.message.findUnique.mockResolvedValue({
      ...(textCtx as object),
      conversation: {
        ...(textCtx as { conversation: { instance: object } }).conversation,
        instance: {
          ...(textCtx as { conversation: { instance: object } }).conversation.instance,
          provider: 'TWILIO',
        },
      },
    } as never);
    await svc.handle('c1', 'm1');
    expect(dify.chat).not.toHaveBeenCalled();
    expect(chat.sendBotReply).not.toHaveBeenCalled();
  });

  it('on Dify failure: sends fallback, pauses the bot, audits', async () => {
    const { svc, prisma, dify, chat, chatRepo, audit } = make();
    prisma.message.findUnique.mockResolvedValue({
      ...(textCtx as object),
      conversation: {
        ...(textCtx as { conversation: { instance: { bot: object } } }).conversation,
        instance: { id: 'i1', botId: 'b1', provider: 'EVOLUTION', bot: { id: 'b1', isActive: true, difyApiKey: 'k', difyBaseUrl: null, fallbackMessage: 'Já te respondo!', inputs: null } },
      },
    } as never);
    dify.chat.mockRejectedValue(new Error('dify 500'));

    await svc.handle('c1', 'm1');

    expect(chat.sendBotReply).toHaveBeenCalledWith('c1', 'Já te respondo!', 'b1');
    expect(chatRepo.setBotPaused).toHaveBeenCalledWith('c1');
    expect(audit.log).toHaveBeenCalledWith('bot.reply_failed', 'Conversation', 'c1', expect.any(Object));
  });

  it('uploads media for IMAGE and passes a files entry to Dify', async () => {
    const { svc, prisma, dify, store } = make();
    prisma.message.findUnique.mockResolvedValue({
      ...(textCtx as object),
      kind: 'IMAGE', content: 'olha isso',
      media: { storageKey: 'conv/c1/m1.jpg', status: 'READY', mimeType: 'image/jpeg', fileName: 'm1.jpg' },
    } as never);
    store.getBuffer.mockResolvedValue(Buffer.from('img'));
    dify.uploadFile.mockResolvedValue({ id: 'file-1' });
    dify.chat.mockResolvedValue({ answer: 'vi a foto', conversationId: 'dc', messageId: 'dm' });

    await svc.handle('c1', 'm1');

    expect(store.getBuffer).toHaveBeenCalledWith('conv/c1/m1.jpg');
    expect(dify.uploadFile).toHaveBeenCalled();
    expect(dify.chat).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'file-1' }],
    }));
  });
});
