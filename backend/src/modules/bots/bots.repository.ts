import { Injectable } from '@nestjs/common';
import type { Bot } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

// difyApiKey é segredo — nunca exposto em leituras públicas.
export type SafeBot = Omit<Bot, 'difyApiKey'>;

@Injectable()
export class BotsRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsertByDifyApp(data: {
    difyAppId: string; name: string; mode: string; difyApiKey: string;
  }): Promise<SafeBot> {
    const now = new Date();
    return this.prisma.bot.upsert({
      where: { difyAppId: data.difyAppId },
      create: {
        difyAppId: data.difyAppId, name: data.name, mode: data.mode,
        difyApiKey: data.difyApiKey, lastSyncedAt: now,
      },
      update: {
        name: data.name, mode: data.mode, difyApiKey: data.difyApiKey, isActive: true, lastSyncedAt: now,
      },
      omit: { difyApiKey: true },
    });
  }
}
