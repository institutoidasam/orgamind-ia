import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ClsService } from 'nestjs-cls';
import { AuditService, AUDIT_CLS_KEY, type AuditContext } from './audit.service';
import { AuditRepository } from './audit.repository';

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
    cls.get.mockReturnValue({} as AuditContext);
    repo.create.mockResolvedValue({} as any);

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
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      correlationId: 'req-123',
    };
    cls.get.mockImplementation((key: any) =>
      key === AUDIT_CLS_KEY ? (ctx as any) : undefined,
    );
    repo.create.mockResolvedValue({} as any);

    await service.log('auth.login', 'User', 'user-1');

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
      }),
    );
  });

  it('swallows repository errors silently (never throws)', async () => {
    cls.get.mockReturnValue({} as AuditContext);
    repo.create.mockRejectedValue(new Error('DB unavailable'));

    await expect(
      service.log('campaign.run', 'Campaign', 'c1'),
    ).resolves.toBeUndefined();
  });

  it('treats CLS access errors as empty context (never throws)', async () => {
    cls.get.mockImplementation(() => {
      throw new Error('CLS not active');
    });
    repo.create.mockResolvedValue({} as any);

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
    cls.get.mockReturnValue({} as AuditContext);
    repo.create.mockResolvedValue({} as any);

    await service.log('auth.login', 'User');

    const arg = repo.create.mock.calls[0][0];
    expect(arg.entityId).toBeUndefined();
    expect(arg.metadata).toBeUndefined();
  });
});
