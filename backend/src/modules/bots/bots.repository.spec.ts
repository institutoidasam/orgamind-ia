import { describe, it, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { BotsRepository } from './bots.repository';

describe('BotsRepository.upsertByDifyApp', () => {
  it('upserts keyed by difyAppId, omitting the secret, stamping lastSyncedAt', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.bot.upsert.mockResolvedValue({ id: 'b1', difyAppId: 'a1', name: 'Chat' } as any);
    const repo = new BotsRepository(prisma as unknown as PrismaService);
    const out = await repo.upsertByDifyApp({ difyAppId: 'a1', name: 'Chat', mode: 'chat', difyApiKey: 'app-X' });
    expect(out).toMatchObject({ id: 'b1', difyAppId: 'a1' });
    const arg = prisma.bot.upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ difyAppId: 'a1' });
    expect(arg.create.difyApiKey).toBe('app-X');
    expect(arg.create.lastSyncedAt).toBeInstanceOf(Date);
    expect(arg.update.name).toBe('Chat');
    expect(arg.update.mode).toBe('chat');
    expect(arg.update.difyApiKey).toBe('app-X');
    expect(arg.update.isActive).toBe(true);
    expect(arg.update.lastSyncedAt).toBeInstanceOf(Date);
    expect(arg.omit).toEqual({ difyApiKey: true });
  });
});
