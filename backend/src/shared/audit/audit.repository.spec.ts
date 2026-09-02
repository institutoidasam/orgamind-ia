import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { AuditRepository } from './audit.repository';
import { PrismaService } from '../prisma/prisma.service';

describe('AuditRepository', () => {
  let repo: AuditRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new AuditRepository(prisma);
  });

  it('writes through to prisma.auditEvent.create with full payload', async () => {
    prisma.auditEvent.create.mockResolvedValue({} as any);
    await repo.create({
      actorId: 'u1',
      action: 'campaign.run',
      entity: 'Campaign',
      entityId: 'c1',
      metadata: { recipients: 10 },
      ip: '10.0.0.1',
      userAgent: 'Chrome',
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorId: 'u1',
        action: 'campaign.run',
        entity: 'Campaign',
        entityId: 'c1',
        metadata: { recipients: 10 },
        ip: '10.0.0.1',
        userAgent: 'Chrome',
      },
    });
  });

  it('coerces missing optional fields to null', async () => {
    prisma.auditEvent.create.mockResolvedValue({} as any);
    await repo.create({ action: 'auth.login', entity: 'User' });
    const arg = prisma.auditEvent.create.mock.calls[0][0] as any;
    expect(arg.data.actorId).toBeNull();
    expect(arg.data.entityId).toBeNull();
    expect(arg.data.ip).toBeNull();
    expect(arg.data.userAgent).toBeNull();
  });

  it('uses Prisma.JsonNull when metadata is null/missing', async () => {
    prisma.auditEvent.create.mockResolvedValue({} as any);
    await repo.create({ action: 'a', entity: 'E' });
    const arg = prisma.auditEvent.create.mock.calls[0][0] as any;
    expect(arg.data.metadata).toBe(Prisma.JsonNull);

    prisma.auditEvent.create.mockClear();
    await repo.create({ action: 'a', entity: 'E', metadata: null });
    const arg2 = prisma.auditEvent.create.mock.calls[0][0] as any;
    expect(arg2.data.metadata).toBe(Prisma.JsonNull);
  });
});
