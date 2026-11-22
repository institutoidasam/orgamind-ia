import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BotReplyService } from './bot-reply.service';
import { DifyClient } from './dify.client';
import { ChatService } from '../chat/chat.service';
import { ChatRepository } from '../chat/chat.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import type { Env } from '../../shared/config/env.schema';

type Over = { botPausedAt?: Date | null; fallback?: string | null };

function inboundMessage(over: Over) {
  const bot = {
    id: 'b1',
    isActive: true,
    difyApiKey: 'k',
    difyBaseUrl: null,
    fallbackMessage: over.fallback ?? null,
    inputs: null,
  };
  return {
    id: 'm1',
    conversationId: 'c1',
    direction: 'INBOUND',
    kind: 'TEXT',
    content: 'oi',
    transcript: null,
    media: null,
    conversation: {
      id: 'c1',
      phoneE164: '+5592991110001',
      botPausedAt: over.botPausedAt ?? null,
      difyConversationId: null,
      instance: { id: 'i1', botId: 'b1', provider: 'EVOLUTION', bot },
      contact: { optedOut: false },
    },
  };
}

function arrange(over: Over = {}) {
  const prisma = mockDeep<PrismaService>();
  const dify = mockDeep<DifyClient>();
  const chat = mockDeep<ChatService>();
  const chatRepo = mockDeep<ChatRepository>();
  const audit = mockDeep<AuditService>();
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
  };
  const config = {
    get: vi.fn().mockReturnValue('https://env.dify/v1'),
  } as unknown as ConfigService<Env>;
  const store = mockDeep<MediaStore>();
  const svc = new BotReplyService(
    prisma,
    dify,
    chat,
    chatRepo,
    audit,
    config,
    store,
    redis as never,
  );
  prisma.message.findUnique.mockResolvedValue(inboundMessage(over) as never);
  dify.chat.mockResolvedValue({
    answer: 'olá!',
    conversationId: 'dc1',
    messageId: 'dm1',
  });
  return { svc, dify, chat, chatRepo, audit, redis };
}

afterEach(() => vi.restoreAllMocks());

describe('BotReplyService K3-7 — pausa e resposta vazia', () => {
  it('K3-7(a): conversa em pausa — Dify não é chamado', async () => {
    const { svc, dify, chat } = arrange({ botPausedAt: new Date() });
    await svc.handle('c1', 'm1');
    expect(dify.chat.mock.calls).toHaveLength(0);
    expect(chat.sendBotReply.mock.calls).toHaveLength(0);
  });

  it.each(['', '  \n '])(
    'K3-7(e): resposta vazia ou só espaços (%j) — não envia nem pausa',
    async (answer) => {
      const { svc, dify, chat, chatRepo } = arrange();
      dify.chat.mockResolvedValue({
        answer,
        conversationId: 'dc1',
        messageId: 'dm1',
      });
      await svc.handle('c1', 'm1');
      expect(chat.sendBotReply.mock.calls).toHaveLength(0);
      expect(chatRepo.setBotPaused.mock.calls).toHaveLength(0);
    },
  );
});

describe('BotReplyService K3-7(e) — Dify falha', () => {
  it('sem contingência — só pausa e audita', async () => {
    const { svc, dify, chat, chatRepo, audit } = arrange();
    dify.chat.mockRejectedValue(new Error('dify 500'));
    await svc.handle('c1', 'm1');
    expect(chat.sendBotReply.mock.calls).toHaveLength(0);
    expect(chatRepo.setBotPaused.mock.calls).toEqual([['c1']]);
    expect(audit.log.mock.calls[0].slice(0, 3)).toEqual([
      'bot.reply_failed',
      'Conversation',
      'c1',
    ]);
  });

  it('contingência que lança — pausa, um envio, não relança', async () => {
    const { svc, dify, chat, chatRepo } = arrange({
      fallback: 'Já te respondo!',
    });
    dify.chat.mockRejectedValue(new Error('dify 500'));
    chat.sendBotReply.mockRejectedValue(new Error('provedor fora'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chat.sendBotReply.mock.calls).toEqual([
      ['c1', 'Já te respondo!', 'b1'],
    ]);
    expect(chatRepo.setBotPaused.mock.calls).toEqual([['c1']]);
  });

  it('contingência enviada e setBotPaused falha — não relança (nada de reenvio)', async () => {
    const { svc, dify, chat, chatRepo, audit } = arrange({
      fallback: 'Já te respondo!',
    });
    dify.chat.mockRejectedValue(new Error('dify 500'));
    chatRepo.setBotPaused.mockRejectedValue(new Error('banco caiu'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chat.sendBotReply.mock.calls).toHaveLength(1);
    expect(audit.log.mock.calls).toHaveLength(1);
  });
});

describe('BotReplyService K3-7(c) — falha ao enviar depois do Dify', () => {
  it('sendBotReply lança — pausa, audita stage send, sem contingência, um envio, log sem texto', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { svc, dify, chat, chatRepo, audit } = arrange({
      fallback: 'Já te respondo!',
    });
    chat.sendBotReply.mockRejectedValue(new Error('segredo do provedor'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chat.sendBotReply.mock.calls).toEqual([['c1', 'olá!', 'b1']]);
    expect(dify.chat.mock.calls).toHaveLength(1);
    expect(chatRepo.setBotPaused.mock.calls).toEqual([['c1']]);
    expect(audit.log.mock.calls).toEqual([
      [
        'bot.reply_failed',
        'Conversation',
        'c1',
        { botId: 'b1', stage: 'send' },
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('segredo');
  });

  it('sendBotReply e setBotPaused falham — não relança, um envio, sem nova chamada ao Dify', async () => {
    const { svc, dify, chat, chatRepo } = arrange();
    chat.sendBotReply.mockRejectedValue(new Error('envio'));
    chatRepo.setBotPaused.mockRejectedValue(new Error('banco caiu'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chat.sendBotReply.mock.calls).toHaveLength(1);
    expect(dify.chat.mock.calls).toHaveLength(1);
  });

  it('sendBotReply e audit falham — não relança', async () => {
    const { svc, chat, chatRepo, audit } = arrange();
    chat.sendBotReply.mockRejectedValue(new Error('envio'));
    audit.log.mockRejectedValue(new Error('auditoria fora'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chatRepo.setBotPaused.mock.calls).toEqual([['c1']]);
  });

  it('liberar a trava falha — não relança', async () => {
    const { svc, chat, redis } = arrange();
    redis.eval.mockRejectedValue(new Error('redis caiu'));
    await expect(svc.handle('c1', 'm1')).resolves.toBeUndefined();
    expect(chat.sendBotReply.mock.calls).toHaveLength(1);
    expect(redis.eval.mock.calls).toHaveLength(1);
  });
});

describe('BotReplyService K3-7(c) — falha antes do Dify ou do envio', () => {
  it('trava ocupada — relança para retentativa, sem Dify nem envio', async () => {
    const { svc, dify, chat, redis } = arrange();
    redis.set.mockResolvedValue(null);
    await expect(svc.handle('c1', 'm1')).rejects.toThrow('lock busy');
    expect(dify.chat.mock.calls).toHaveLength(0);
    expect(chat.sendBotReply.mock.calls).toHaveLength(0);
  });

  it('setDifyConversationId lança — relança (nada saiu), sem envio, trava liberada', async () => {
    const { svc, chat, chatRepo, redis } = arrange();
    chatRepo.setDifyConversationId.mockRejectedValue(new Error('banco caiu'));
    await expect(svc.handle('c1', 'm1')).rejects.toThrow('banco caiu');
    expect(chat.sendBotReply.mock.calls).toHaveLength(0);
    expect(redis.eval.mock.calls).toHaveLength(1);
  });
});
