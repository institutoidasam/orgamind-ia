import type { Prisma, Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { InternalSectorsService } from './internal-sectors.service';

const ACTOR = 'admin-1';
const TX = { marker: 'tx' } as unknown as Prisma.TransactionClient;
const ANA = { id: 'u-ana', name: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', name: 'Bruno Lima' };

const sector = {
  id: 's1',
  name: 'Compras',
  code: 'COM',
  description: null,
  isActive: true,
  managerId: null,
  manager: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  channel: null,
  _count: { members: 2 },
};

const channelRow = {
  id: 'ch1',
  name: 'Compras Zap',
  phoneE164: '+5592999990001',
  provider: 'EVOLUTION',
  isActive: true,
};

function trailHarness(before: object, after: object) {
  const audit = { recordChange: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
    findValidManager: vi.fn().mockResolvedValue({ id: ANA.id }),
    createWithAudit: vi.fn(
      async (_data: unknown, trail: (...args: unknown[]) => Promise<void>) => {
        await trail(TX, after);
        return after;
      },
    ),
    updateWithAudit: vi.fn(
      async (
        _id: string,
        _data: unknown,
        trail: (...args: unknown[]) => Promise<void>,
      ) => {
        await trail(TX, before, after);
        return after;
      },
    ),
  };
  const service = new InternalSectorsService(repo as never, audit as never);
  return { audit, repo, service };
}
const withManager = (manager: object | null) => ({ ...sector, manager });

const SUPERVISOR_ID = 'sup-1';
const ADMIN_ONLY = { status: 403, code: 'sector.manager_admin_only' };
const withAna = { ...sector, managerId: ANA.id, manager: ANA };

/** Setor lido do banco já tem a Ana como gestora; `after` é o que a gravação devolve. */
function managedHarness(after: object) {
  const h = trailHarness(withAna, after);
  h.repo.find.mockResolvedValue({ ...withAna, members: [] });
  return h;
}
const createdData = (h: ReturnType<typeof trailHarness>) =>
  h.repo.createWithAudit.mock.calls[0][0] as Prisma.SectorCreateInput;
const updatedData = (h: ReturnType<typeof trailHarness>) =>
  h.repo.updateWithAudit.mock.calls[0][1] as Prisma.SectorUpdateInput;

const PHONE_NAME = '+5592999998888';
const MEMBER_ROWS = [
  { id: 'u-fone', name: PHONE_NAME, email: 'a@test.local', role: 'OPERATOR' },
  { id: 'u-ana', name: 'Ana Souza', email: 'b@test.local', role: 'OPERATOR' },
];

function membersHarness(role: Role, change: PermissionChange = {}) {
  const repo = {
    find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
    findMembers: vi.fn().mockResolvedValue(MEMBER_ROWS),
    effectivePermissions: vi
      .fn()
      .mockResolvedValue(permissionsWith(role, change)),
  };
  const service = new InternalSectorsService(repo as never, {} as never);
  return { repo, service };
}

describe('InternalSectorsService.members — nome sem o telefone completo (DB8)', () => {
  it.each([
    ['VIEWER', 'VIEWER', {}],
    [
      'SUPERVISOR sem a chave',
      'SUPERVISOR',
      { revoke: ['telefone.ver_completo'] },
    ],
  ] as const)(
    '%s recebe o nome-telefone mascarado, sem o número na resposta',
    async (_label, role, change) => {
      const { repo, service } = membersHarness(role, change);

      const result = await service.members('s1', undefined, role);

      expect(result.items.map((m) => m.name)).toEqual([
        '•••• 8888',
        'Ana Souza',
      ]);
      expect(JSON.stringify(result)).not.toContain('99999');
      expect(repo.effectivePermissions).toHaveBeenCalledWith(role);
      expect(repo.findMembers).toHaveBeenCalledWith('s1', undefined);
    },
  );

  it.each(['ADMIN', 'SUPERVISOR'] as const)(
    '%s com a chave vê o nome real; nome normal nunca muda',
    async (role) => {
      const { service } = membersHarness(role);

      const result = await service.members('s1', true, role);

      expect(result.items).toEqual(MEMBER_ROWS);
    },
  );
});

describe('InternalSectorsService.get — nome dos membros sem o telefone completo (DB8)', () => {
  const memberDetail = (role: Role, change: PermissionChange = {}) => {
    const h = membersHarness(role, change);
    h.repo.find.mockResolvedValue({ ...sector, members: MEMBER_ROWS });
    return h;
  };

  it('SUPERVISOR com estrutura.manter e sem telefone.ver_completo recebe o nome mascarado', async () => {
    const { repo, service } = memberDetail('SUPERVISOR', {
      grant: ['estrutura.manter'],
      revoke: ['telefone.ver_completo'],
    });

    const detail = await service.get('s1', 'SUPERVISOR');

    expect(detail.members.map((m) => m.name)).toEqual([
      '•••• 8888',
      'Ana Souza',
    ]);
    expect(JSON.stringify(detail)).not.toContain('99999');
    expect(repo.effectivePermissions).toHaveBeenCalledWith('SUPERVISOR');
  });

  it('ADMIN recebe o nome real', async () => {
    const { service } = memberDetail('ADMIN');

    const detail = await service.get('s1', 'ADMIN');

    expect(detail.members).toEqual(MEMBER_ROWS);
  });
});

describe('InternalSectorsService — gestor só pelo ADMIN: criação (DB20)', () => {
  it('SUPERVISOR com a chave cria setor sem managerId', async () => {
    const h = trailHarness(sector, sector);

    await h.service.create(
      { name: 'Compras', code: 'COM' },
      SUPERVISOR_ID,
      'SUPERVISOR',
    );

    expect(h.repo.createWithAudit).toHaveBeenCalledTimes(1);
    expect(createdData(h)).not.toHaveProperty('manager');
    expect(h.repo.findValidManager).not.toHaveBeenCalled();
  });

  it('SUPERVISOR cria setor com managerId null → cria sem gestor', async () => {
    const h = trailHarness(sector, sector);

    await h.service.create(
      { name: 'Compras', code: 'COM', managerId: null },
      SUPERVISOR_ID,
      'SUPERVISOR',
    );

    expect(h.repo.createWithAudit).toHaveBeenCalledTimes(1);
    expect(createdData(h)).not.toHaveProperty('manager');
  });

  it('SUPERVISOR cria setor com managerId → 403 e nada é gravado', async () => {
    const h = trailHarness(sector, sector);

    await expect(
      h.service.create(
        { name: 'Compras', code: 'COM', managerId: ANA.id },
        SUPERVISOR_ID,
        'SUPERVISOR',
      ),
    ).rejects.toMatchObject(ADMIN_ONLY);

    expect(h.repo.findValidManager).not.toHaveBeenCalled();
    expect(h.repo.createWithAudit).not.toHaveBeenCalled();
    expect(h.audit.recordChange).not.toHaveBeenCalled();
  });
});

describe('InternalSectorsService — gestor só pelo ADMIN: edição (DB20)', () => {
  it('SUPERVISOR edita o nome reenviando o managerId atual → passa e não grava manager', async () => {
    const h = managedHarness({ ...withAna, name: 'Compras 2' });

    await h.service.update(
      's1',
      { name: 'Compras 2', managerId: ANA.id },
      SUPERVISOR_ID,
      'SUPERVISOR',
    );

    expect(updatedData(h)).toEqual({ name: 'Compras 2' });
    expect(h.repo.findValidManager).not.toHaveBeenCalled();
    expect(h.audit.recordChange).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        action: 'sector.updated',
        actorId: SUPERVISOR_ID,
        changes: [{ field: 'name', before: 'Compras', after: 'Compras 2' }],
      }),
    );
  });

  it('SUPERVISOR troca ou limpa o managerId → 403 e nada é gravado', async () => {
    for (const managerId of [BRUNO.id, null]) {
      const h = managedHarness(withAna);

      await expect(
        h.service.update('s1', { managerId }, SUPERVISOR_ID, 'SUPERVISOR'),
      ).rejects.toMatchObject(ADMIN_ONLY);

      expect(h.repo.findValidManager).not.toHaveBeenCalled();
      expect(h.repo.updateWithAudit).not.toHaveBeenCalled();
      expect(h.audit.recordChange).not.toHaveBeenCalled();
    }
  });
});

describe('InternalSectorsService — gestor só pelo ADMIN: o ADMIN segue igual (DB20, GB1)', () => {
  it('ADMIN cria e troca o gestor como hoje', async () => {
    const created = trailHarness(sector, sector);
    const changed = managedHarness(withAna);

    await created.service.create(
      { name: 'Compras', code: 'COM', managerId: ANA.id },
      ACTOR,
      'ADMIN',
    );
    await changed.service.update('s1', { managerId: BRUNO.id }, ACTOR, 'ADMIN');

    expect(createdData(created).manager).toEqual({ connect: { id: ANA.id } });
    expect(updatedData(changed).manager).toEqual({
      connect: { id: BRUNO.id },
    });
    expect(changed.repo.findValidManager).toHaveBeenCalledWith(BRUNO.id);
  });
});

describe('InternalSectorsService — trilha de setor na criação e na edição (A5, GC1)', () => {
  it('create grava sector.created no tx, STRUCTURE, com o ator e o gestor só { id, name }', async () => {
    const created = withManager({ ...ANA, email: 'ana@gbr.com.br' });
    const h = trailHarness(sector, created);

    await h.service.create(
      { name: 'Compras', code: 'COM', managerId: ANA.id },
      ACTOR,
      'ADMIN',
    );

    expect(h.audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'sector.created',
      entity: 'Sector',
      entityId: 's1',
      category: 'STRUCTURE',
      actorId: ACTOR,
      changes: [
        { field: 'name', before: null, after: 'Compras' },
        { field: 'manager', before: null, after: ANA },
        { field: 'isActive', before: null, after: true },
      ],
    });
    expect(JSON.stringify(h.audit.recordChange.mock.calls)).not.toContain(
      'ana@gbr',
    );
  });

  it('update grava sector.updated no tx só com o campo alterado e o ator explícito', async () => {
    const h = trailHarness(withManager(ANA), withManager(BRUNO));

    await h.service.update('s1', { managerId: BRUNO.id }, ACTOR, 'ADMIN');

    expect(h.audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'sector.updated',
      entity: 'Sector',
      entityId: 's1',
      category: 'STRUCTURE',
      actorId: ACTOR,
      changes: [{ field: 'manager', before: ANA, after: BRUNO }],
    });
  });
});

describe('InternalSectorsService — trilha de setor sem alteração e com falha (A5, GC1)', () => {
  it('update sem nenhum campo auditado alterado não grava evento vazio', async () => {
    const h = trailHarness(sector, { ...sector, description: 'Nova' });

    await h.service.update('s1', { description: 'Nova' }, ACTOR, 'ADMIN');

    expect(h.audit.recordChange).not.toHaveBeenCalled();
  });

  it('falha da trilha propaga e não vira conflito de setor', async () => {
    const failure = new Error('audit offline');
    const h = trailHarness({ ...sector, isActive: false }, sector);
    h.audit.recordChange.mockRejectedValue(failure);

    await expect(
      h.service.create({ name: 'Compras', code: 'COM' }, ACTOR, 'ADMIN'),
    ).rejects.toBe(failure);
    await expect(
      h.service.update('s1', { isActive: true }, ACTOR, 'ADMIN'),
    ).rejects.toBe(failure);
  });
});

describe('InternalSectorsService — membros e criação', () => {
  it('returns only active non-viewer members for eligible sector recipients', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
      findMembers: vi
        .fn()
        .mockResolvedValue([
          { id: 'u1', name: 'Ana Souza', role: 'OPERATOR', isActive: true },
        ]),
      effectivePermissions: vi
        .fn()
        .mockResolvedValue(permissionsWith('OPERATOR')),
    };
    const service = new InternalSectorsService(repo as never, {} as never);
    await expect(service.members('s1', true, 'OPERATOR')).resolves.toEqual({
      items: [
        { id: 'u1', name: 'Ana Souza', role: 'OPERATOR', isActive: true },
      ],
    });
    expect(repo.findMembers).toHaveBeenCalledWith('s1', true);
  });

  it('maps create results to the public summary shape', async () => {
    const repo = {
      findValidManager: vi.fn(),
      createWithAudit: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never, {} as never);
    await expect(
      service.create({ name: 'Compras', code: 'COM' }, ACTOR, 'ADMIN'),
    ).resolves.toMatchObject({ id: 's1', memberCount: 2, channel: null });
  });
});

describe('InternalSectorsService — edição e falha de persistência', () => {
  it('disconnects the manager on an explicit null update', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
      findValidManager: vi.fn(),
      updateWithAudit: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never, {} as never);

    await service.update('s1', { managerId: null }, ACTOR, 'ADMIN');

    expect(repo.findValidManager).not.toHaveBeenCalled();
    expect(repo.updateWithAudit).toHaveBeenCalledWith(
      's1',
      { manager: { disconnect: true } },
      expect.any(Function),
    );
  });

  it('does not hide an unexpected persistence failure as a sector conflict', async () => {
    const failure = new Error('database offline');
    const repo = {
      findValidManager: vi.fn(),
      createWithAudit: vi.fn().mockRejectedValue(failure),
    };
    const service = new InternalSectorsService(repo as never, {} as never);

    await expect(
      service.create({ name: 'Compras', code: 'COM' }, ACTOR, 'ADMIN'),
    ).rejects.toBe(failure);
  });
});

describe('InternalSectorsService — número efetivo do setor (C1)', () => {
  it.each([
    [
      'canal EVOLUTION ativo',
      channelRow,
      { id: 'ch1', name: 'Compras Zap', phoneE164: '+5592999990001' },
    ],
    ['canal inativo', { ...channelRow, isActive: false }, null],
    [
      'canal GOZAP ativo (provedor desligado)',
      { ...channelRow, provider: 'GOZAP' },
      null,
    ],
    ['canal TWILIO', { ...channelRow, provider: 'TWILIO' }, null],
    ['sem canal', null, null],
  ])(
    'setor com %s responde channel efetivo, sem numbers/numberCount',
    async (_label, channel, expected) => {
      const repo = {
        list: vi.fn().mockResolvedValue([[{ ...sector, channel }], 1]),
        find: vi.fn().mockResolvedValue({ ...sector, channel, members: [] }),
        effectivePermissions: vi
          .fn()
          .mockResolvedValue(permissionsWith('ADMIN')),
      };
      const service = new InternalSectorsService(repo as never, {} as never);

      const listed = await service.list(1, 25);
      const detail = await service.get('s1', 'ADMIN');

      expect(listed.items[0].channel).toEqual(expected);
      expect(detail.channel).toEqual(expected);
      for (const response of [listed.items[0], detail]) {
        expect(response).not.toHaveProperty('numberCount');
        expect(response).not.toHaveProperty('numbers');
      }
    },
  );
});
