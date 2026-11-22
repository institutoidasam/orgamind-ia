import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AuditRepository } from './audit.repository';
import type { PrismaService } from '../prisma/prisma.service';

type CreateArg = { data: Prisma.AuditEventUncheckedCreateInput };

function fakeClient() {
  const create = vi.fn().mockResolvedValue({});
  return {
    create,
    client: { auditEvent: { create } } as unknown as Prisma.TransactionClient,
  };
}

let repo: AuditRepository;
let prisma: ReturnType<typeof fakeClient>;

beforeEach(() => {
  prisma = fakeClient();
  repo = new AuditRepository(prisma.client as unknown as PrismaService);
});

describe('AuditRepository — createIn', () => {
  it('createIn writes the full payload through the client it receives (not the injected prisma)', async () => {
    const tx = fakeClient();
    await repo.createIn(tx.client, {
      actorId: 'u1',
      action: 'user.updated',
      entity: 'User',
      entityId: 'u1',
      metadata: { recipients: 10 },
      ip: 'ip-do-cls',
      userAgent: 'Chrome',
      subjectUserId: 'u1',
      category: 'PERSON',
      reason: 'Correção de cadastro',
      changes: [{ field: 'jobTitle', before: 'Analista', after: 'Líder' }],
    });
    expect(tx.create).toHaveBeenCalledWith({
      data: {
        actorId: 'u1',
        action: 'user.updated',
        entity: 'User',
        entityId: 'u1',
        metadata: { recipients: 10 },
        ip: 'ip-do-cls',
        userAgent: 'Chrome',
        subjectUserId: 'u1',
        category: 'PERSON',
        reason: 'Correção de cadastro',
        changes: [{ field: 'jobTitle', before: 'Analista', after: 'Líder' }],
      },
    });
    expect(prisma.create).not.toHaveBeenCalled();
  });
});

describe('AuditRepository — create', () => {
  it('create delegates to the injected prisma and coerces missing optional fields to null', async () => {
    await repo.create({ action: 'auth.login', entity: 'User' });
    const [arg] = prisma.create.mock.calls[0] as [CreateArg];
    expect(arg.data.actorId).toBeNull();
    expect(arg.data.entityId).toBeNull();
    expect(arg.data.ip).toBeNull();
    expect(arg.data.userAgent).toBeNull();
    expect(arg.data.subjectUserId).toBeNull();
    expect(arg.data.category).toBeNull();
    expect(arg.data.reason).toBeNull();
    expect(arg.data.changes).toBe(Prisma.JsonNull);
  });

  it('uses Prisma.JsonNull when metadata is null/missing', async () => {
    await repo.create({ action: 'a', entity: 'E' });
    const [arg] = prisma.create.mock.calls[0] as [CreateArg];
    expect(arg.data.metadata).toBe(Prisma.JsonNull);

    prisma.create.mockClear();
    await repo.create({ action: 'a', entity: 'E', metadata: null });
    const [arg2] = prisma.create.mock.calls[0] as [CreateArg];
    expect(arg2.data.metadata).toBe(Prisma.JsonNull);
  });
});
