import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { BotsRepository } from './bots.repository';
import { DifyConsoleClient, type DifyApp } from './dify-console.client';
import { ChatRepository } from '../chat/chat.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { BotAppNotFoundError } from './errors/bot.errors';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';

const APPS_CACHE_TTL_MS = 60_000;

export type BotAssignment = { instanceId: string; botDifyAppId: string | null; botName: string | null };

@Injectable()
export class BotsService {
  private appsCache: { at: number; apps: DifyApp[] } | null = null;

  constructor(
    private readonly repo: BotsRepository,
    private readonly difyConsole: DifyConsoleClient,
    private readonly chatRepo: ChatRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async listDifyChatApps(): Promise<DifyApp[]> {
    const now = Date.now();
    if (this.appsCache && now - this.appsCache.at < APPS_CACHE_TTL_MS) return this.appsCache.apps;
    const apps = await this.difyConsole.listChatApps();
    this.appsCache = { at: now, apps };
    return apps;
  }

  async assignBotToInstance(instanceId: string, difyAppId: string | null): Promise<BotAssignment> {
    const inst = await this.prisma.channel.findUnique({ where: { id: instanceId }, select: { id: true } });
    if (!inst) throw new InstanceNotFoundError(instanceId);
    if (difyAppId === null) {
      await this.prisma.channel.update({ where: { id: instanceId }, data: { botId: null } });
      await this.chatRepo.resetDifyConversationIdsForInstance(instanceId);
      await this.audit.log('bot.unassign', 'WhatsappInstance', instanceId, {});
      return { instanceId, botDifyAppId: null, botName: null };
    }
    const apps = await this.listDifyChatApps();
    const app = apps.find((a) => a.id === difyAppId);
    if (!app) throw new BotAppNotFoundError(difyAppId);
    const apiKey = await this.difyConsole.getOrCreateAppKey(difyAppId);
    const bot = await this.repo.upsertByDifyApp({ difyAppId, name: app.name, mode: app.mode, difyApiKey: apiKey });
    await this.prisma.channel.update({ where: { id: instanceId }, data: { botId: bot.id } });
    await this.chatRepo.resetDifyConversationIdsForInstance(instanceId);
    await this.audit.log('bot.assign', 'WhatsappInstance', instanceId, { difyAppId, botId: bot.id });
    return { instanceId, botDifyAppId: difyAppId, botName: app.name };
  }
}
