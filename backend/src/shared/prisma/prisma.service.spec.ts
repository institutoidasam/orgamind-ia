import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let svc: PrismaService;

  beforeEach(() => {
    svc = new PrismaService();
  });

  it('onModuleInit calls $connect', async () => {
    const spy = vi
      .spyOn(svc as any, '$connect')
      .mockResolvedValue(undefined as any);
    await svc.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy calls $disconnect', async () => {
    const spy = vi
      .spyOn(svc as any, '$disconnect')
      .mockResolvedValue(undefined as any);
    await svc.onModuleDestroy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from $connect', async () => {
    vi.spyOn(svc as any, '$connect').mockRejectedValue(new Error('boom'));
    await expect(svc.onModuleInit()).rejects.toThrow('boom');
  });
});
