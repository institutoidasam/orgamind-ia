/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ClsService } from 'nestjs-cls';
import { Prisma, type AuditEvent } from '@prisma/client';
import {
  AuditService,
  AUDIT_CLS_KEY,
  type AuditContext,
} from './audit.service';
import { AuditRepository } from './audit.repository';
import type { AuditChange } from './audit-change';
import type { PrismaService } from '../prisma/prisma.service';

// Serviço com o repositório real sobre um PrismaService falso: prova o que
// chega em `auditEvent.create` (do tx ou do prisma) sem mockar o repositório.
function buildTrailService(ctx: AuditContext) {
  const prismaCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    auditEvent: { create: prismaCreate },
  } as unknown as PrismaService;
  const cls = mockDeep<ClsService>();
  cls.get.mockImplementation((key: any) =>
    key === AUDIT_CLS_KEY ? ctx : undefined,
  );
  const service = new AuditService(new AuditRepository(prisma), cls);
  return { service, prismaCreate };
}

type CreateArg = { data: Prisma.AuditEventUncheckedCreateInput };
const firstData = (create: ReturnType<typeof vi.fn>) =>
  (create.mock.calls[0] as [CreateArg])[0].data;

const fakeTx = (create = vi.fn().mockResolvedValue({})) =>
  ({ auditEvent: { create } }) as unknown as Prisma.TransactionClient;

describe('AuditService.recordChange — máscara de telefone e e-mail', () => {
  const gravado = async (changes: AuditChange['changes']) => {
    const { service } = buildTrailService({});
    const create = vi.fn().mockResolvedValue({});
    await service.recordChange(fakeTx(create), {
      action: 'user.updated',
      entity: 'User',
      entityId: 'u1',
      category: 'PERSON',
      changes,
      actorId: 'admin',
    });
    return (firstData(create) as { changes: AuditChange['changes'] }).changes;
  };

  it('mascara telefone e e-mail crus antes de gravar', async () => {
    await expect(
      gravado([
        { field: 'phone', before: '+5592988881234', after: null },
        { field: 'email', before: 'ana@dominio', after: 'bia@dominio' },
      ]),
    ).resolves.toEqual([
      { field: 'phone', before: '•••• 1234', after: null },
      { field: 'email', before: 'a•••@dominio', after: 'b•••@dominio' },
    ]);
  });

  it('mantém valor já mascarado igual e não toca outros campos', async () => {
    const ja = [
      { field: 'phone', before: '•••• 1234', after: '••••' },
      { field: 'email', before: 'a•••@dominio', after: '•••' },
      { field: 'jobTitle', before: 'ana@dominio', after: '+5592988881234' },
    ];

    await expect(gravado(ja)).resolves.toEqual(ja);
  });

  it('valor não nulo que não é string vira a máscara vazia, nunca sai cru', async () => {
    const cru = [
      { field: 'phone', before: 5592988881234, after: null },
      { field: 'email', before: { value: 'ana@dominio' }, after: true },
    ] as unknown as AuditChange['changes'];

    await expect(gravado(cru)).resolves.toEqual([
      { field: 'phone', before: '••••', after: null },
      { field: 'email', before: '•••', after: '•••' },
    ]);
  });
});

describe('AuditService.recordChange', () => {
  const change: AuditChange = {
    action: 'user.updated',
    entity: 'User',
    entityId: 'u1',
    category: 'PERSON',
    subjectUserId: 'u1',
    reason: 'Correção de cadastro',
    changes: [{ field: 'jobTitle', before: 'Analista', after: 'Líder' }],
    actorId: 'admin-explicit',
  };

  it('grava no tx recebido, com actorId explícito (não o do CLS), ip e user-agent do CLS, reason, changes e subjectUserId', async () => {
    const { service, prismaCreate } = buildTrailService({
      actorId: 'cls-actor',
      ip: 'ip-do-cls',
      userAgent: 'Firefox',
    });
    const create = vi.fn().mockResolvedValue({});

    await service.recordChange(fakeTx(create), change);

    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-explicit',
        action: 'user.updated',
        entity: 'User',
        entityId: 'u1',
        category: 'PERSON',
        subjectUserId: 'u1',
        reason: 'Correção de cadastro',
        changes: change.changes,
        metadata: Prisma.JsonNull,
        ip: 'ip-do-cls',
        userAgent: 'Firefox',
      },
    });
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it('propaga erro do tx (a mudança não pode ficar sem trilha)', async () => {
    const { service } = buildTrailService({});
    const create = vi.fn().mockRejectedValue(new Error('trilha indisponível'));

    await expect(service.recordChange(fakeTx(create), change)).rejects.toThrow(
      'trilha indisponível',
    );
  });
});

describe('AuditService.log com categoria e pessoa', () => {
  it('continua engolindo erro e deriva category da ação', async () => {
    const { service, prismaCreate } = buildTrailService({ actorId: 'a1' });
    prismaCreate.mockRejectedValue(new Error('DB unavailable'));

    await expect(
      service.log('user.deleted', 'User', 'u1'),
    ).resolves.toBeUndefined();

    expect(firstData(prismaCreate)).toMatchObject({
      category: 'PERSON',
      actorId: 'a1',
    });
  });

  it('grava subjectUserId de opts e deixa opts.category sobrepor a derivada', async () => {
    const { service, prismaCreate } = buildTrailService({});

    await service.log('sector_people.moved', 'User', 'u1', undefined, {
      subjectUserId: 'u1',
      category: 'STRUCTURE',
    });

    expect(firstData(prismaCreate)).toMatchObject({
      subjectUserId: 'u1',
      category: 'STRUCTURE',
    });
  });
});

describe('AuditService', () => {
  let service: AuditService;
  let repo: MockProxy<AuditRepository>;
  let cls: MockProxy<ClsService>;

  beforeEach(() => {
    repo = mockDeep<AuditRepository>();
    cls = mockDeep<ClsService>();
    service = new AuditService(repo, cls);
  });

  it('writes audit event with action/entity/entityId and metadata', async () => {
    cls.get.mockReturnValue({});
    repo.create.mockResolvedValue({} as AuditEvent);

    await service.log('contact.update', 'Contact', 'c1', { name: 'X' });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact.update',
        entity: 'Contact',
        entityId: 'c1',
        metadata: { name: 'X' },
      }),
    );
  });

  it('reads actorId/ip/userAgent from CLS context', async () => {
    const ctx: AuditContext = {
      actorId: 'user-1',
      ip: 'ip-do-cls',
      userAgent: 'Mozilla/5.0',
      correlationId: 'req-123',
    };
    cls.get.mockImplementation((key: any) =>
      key === AUDIT_CLS_KEY ? ctx : undefined,
    );
    repo.create.mockResolvedValue({} as AuditEvent);

    await service.log('auth.login', 'User', 'user-1');

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        ip: 'ip-do-cls',
        userAgent: 'Mozilla/5.0',
      }),
    );
  });

  it('swallows repository errors silently (never throws)', async () => {
    cls.get.mockReturnValue({});
    repo.create.mockRejectedValue(new Error('DB unavailable'));

    await expect(
      service.log('campaign.run', 'Campaign', 'c1'),
    ).resolves.toBeUndefined();
  });

  it('treats CLS access errors as empty context (never throws)', async () => {
    cls.get.mockImplementation(() => {
      throw new Error('CLS not active');
    });
    repo.create.mockResolvedValue({} as AuditEvent);

    await service.log('campaign.cancel', 'Campaign', 'c1');

    // Normalization of nullish -> null is owned by the repository now, so the
    // service forwards the empty-context fields as undefined (it does not
    // pre-coalesce). The repo (covered by its own spec) turns these into null.
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: undefined,
        ip: undefined,
        userAgent: undefined,
      }),
    );
  });

  it('does NOT pre-coalesce — forwards undefined entityId/metadata to the repo', async () => {
    cls.get.mockReturnValue({});
    repo.create.mockResolvedValue({} as AuditEvent);

    await service.log('auth.login', 'User');

    const arg = repo.create.mock.calls[0][0];
    expect(arg.entityId).toBeUndefined();
    expect(arg.metadata).toBeUndefined();
  });
});
