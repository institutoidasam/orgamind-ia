import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { BotsRepository } from './bots.repository';
import { DifyConsoleClient } from './dify-console.client';
import { ChatRepository } from '../chat/chat.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { BotsService } from './bots.service';
import { BotAppNotFoundError } from './errors/bot.errors';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';

function make() {
  const repo = mockDeep<BotsRepository>();
  const console = mockDeep<DifyConsoleClient>();
  const chatRepo = mockDeep<ChatRepository>();
  const audit = mockDeep<AuditService>();
  const prisma = mockDeep<PrismaService>();
  const svc = new BotsService(repo, console, chatRepo, audit, prisma as unknown as PrismaService);
  return { svc, repo, console, chatRepo, audit, prisma };
}

describe('BotsService.assignBotToInstance', () => {
  it('upserts the bot, sets instance.botId, resets dify context', async () => {
    const { svc, repo, console, chatRepo, prisma } = make();
    prisma.channel.findUnique.mockResolvedValue({ id: 'inst1' } as any);
    console.listChatApps.mockResolvedValue([{ id: 'a1', name: 'Chat', mode: 'chat' }]);
    console.getOrCreateAppKey.mockResolvedValue('app-X');
    repo.upsertByDifyApp.mockResolvedValue({ id: 'b1', difyAppId: 'a1', name: 'Chat' } as any);
    const out = await svc.assignBotToInstance('inst1', 'a1');
    expect(console.getOrCreateAppKey).toHaveBeenCalledWith('a1');
    expect(repo.upsertByDifyApp).toHaveBeenCalledWith({ difyAppId: 'a1', name: 'Chat', mode: 'chat', difyApiKey: 'app-X' });
    expect(prisma.channel.update).toHaveBeenCalledWith({ where: { id: 'inst1' }, data: { botId: 'b1' } });
    expect(chatRepo.resetDifyConversationIdsForInstance).toHaveBeenCalledWith('inst1');
    expect(out).toEqual({ instanceId: 'inst1', botDifyAppId: 'a1', botName: 'Chat' });
  });

  it('rejects an unknown app id', async () => {
    const { svc, console, prisma } = make();
    prisma.channel.findUnique.mockResolvedValue({ id: 'inst1' } as any);
    console.listChatApps.mockResolvedValue([{ id: 'a1', name: 'Chat', mode: 'chat' }]);
    await expect(svc.assignBotToInstance('inst1', 'nope')).rejects.toBeInstanceOf(BotAppNotFoundError);
  });

  it('unassigns when difyAppId is null', async () => {
    const { svc, prisma, chatRepo, console } = make();
    prisma.channel.findUnique.mockResolvedValue({ id: 'inst1' } as any);
    const out = await svc.assignBotToInstance('inst1', null);
    expect(prisma.channel.update).toHaveBeenCalledWith({ where: { id: 'inst1' }, data: { botId: null } });
    expect(chatRepo.resetDifyConversationIdsForInstance).toHaveBeenCalledWith('inst1');
    expect(console.getOrCreateAppKey).not.toHaveBeenCalled();
    expect(out).toEqual({ instanceId: 'inst1', botDifyAppId: null, botName: null });
  });

  it('throws 404 and does not update when assigning to a missing instance', async () => {
    const { svc, prisma, console } = make();
    prisma.channel.findUnique.mockResolvedValue(null as any);
    console.listChatApps.mockResolvedValue([{ id: 'a1', name: 'Chat', mode: 'chat' }]);
    await expect(svc.assignBotToInstance('missing', 'a1')).rejects.toBeInstanceOf(InstanceNotFoundError);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('throws 404 and does not update when unassigning a missing instance', async () => {
    const { svc, prisma } = make();
    prisma.channel.findUnique.mockResolvedValue(null as any);
    await expect(svc.assignBotToInstance('missing', null)).rejects.toBeInstanceOf(InstanceNotFoundError);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
});

describe('BotsService.listDifyChatApps', () => {
  it('caches within the TTL window', async () => {
    const { svc, console } = make();
    console.listChatApps.mockResolvedValue([{ id: 'a1', name: 'Chat', mode: 'chat' }]);
    await svc.listDifyChatApps();
    await svc.listDifyChatApps();
    expect(console.listChatApps).toHaveBeenCalledTimes(1);
  });
});
