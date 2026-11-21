import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LevelAdmin } from '../../schemas/contracts/level.schema';
import { UpdateLevelDto } from './dto/update-level.dto';
import { LevelsService } from './levels.service';

const ACTOR = 'user_admin';

type Trail = (tx: never, before: unknown, after: unknown) => Promise<void>;
type OrderTrail = (
  tx: never,
  before: string[],
  after: string[],
) => Promise<void>;

function level(id: string, name: string, sortOrder: number, userCount = 0) {
  return {
    id,
    name,
    sortOrder,
    userCount,
    activePeople: userCount,
    inactivePeople: 0,
    isActive: true,
  };
}

const COORDINATOR = level('level_coordinator', 'Coordenador', 1);
const LEADER = level('level_leader', 'Líder', 2);
const EMPLOYEE = level('level_employee', 'Funcionário', 3, 5);
const OPERATOR = level('level_operator', 'Operador', 4);
const ALL = [COORDINATOR, LEADER, EMPLOYEE, OPERATOR];
const NAMES = 'Coordenador > Líder > Funcionário > Operador';
const REVERSED_NAMES = 'Operador > Funcionário > Líder > Coordenador';

const TX = {} as never;

// Repositório em memória: a comparação sem caixa é do repositório (integração);
// aqui ela não apara espaços, para provar que o serviço apara antes de consultar.
// Os métodos `*WithAudit` chamam a trilha com um `tx` falso, como o repositório real faz.
function harness(rows: LevelAdmin[] = ALL) {
  const byId = (id: string) => rows.find((r) => r.id === id);
  const repo = {
    list: vi.fn().mockResolvedValue(rows),
    findById: vi.fn((id: string) => Promise.resolve(byId(id) ?? null)),
    findByNameInsensitive: vi.fn((name: string, exceptId?: string) =>
      Promise.resolve(
        rows.find(
          (r) =>
            r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
        ) ?? null,
      ),
    ),
    maxSortOrder: vi.fn().mockResolvedValue(4),
    createWithAudit: vi.fn(async (data: object, trail: Trail) => {
      const row = { ...level('level_new', '', 0), ...data };
      await trail(TX, null, row);
      return row;
    }),
    updateWithAudit: vi.fn(async (id: string, data: object, trail: Trail) => {
      const before = byId(id) as LevelAdmin;
      const row = { ...before, ...data };
      await trail(TX, before, row);
      return row;
    }),
    reorderWithAudit: vi.fn(async (ids: string[], trail: OrderTrail) => {
      const names = (list: readonly string[]) =>
        list.map((id) => byId(id)?.name ?? id);
      await trail(TX, names(rows.map((r) => r.id)), names(ids));
    }),
  };
  const audit = { recordChange: vi.fn().mockResolvedValue(undefined) };
  return {
    repo,
    audit,
    service: new LevelsService(repo as never, audit as never),
  };
}

describe('LevelsService.create', () => {
  it('entra no fim (sortOrder 5), ativo e sem ninguém', async () => {
    const { repo, service } = harness();

    const created = await service.create(ACTOR, { name: ' Estagiário ' });

    expect(repo.createWithAudit).toHaveBeenCalledWith(
      { name: 'Estagiário', sortOrder: 5 },
      expect.any(Function),
    );
    expect(created).toEqual({
      id: 'level_new',
      name: 'Estagiário',
      sortOrder: 5,
      isActive: true,
      userCount: 0,
      activePeople: 0,
      inactivePeople: 0,
    });
  });

  it('trilha level.create com os valores iniciais, categoria STRUCTURE', async () => {
    const { audit, service } = harness();

    await service.create(ACTOR, { name: 'Estagiário' });

    expect(audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'level.create',
      actorId: ACTOR,
      entity: 'StaffLevel',
      entityId: 'level_new',
      category: 'STRUCTURE',
      changes: [
        { field: 'name', before: null, after: 'Estagiário' },
        { field: 'isActive', before: null, after: true },
      ],
    });
  });
});

describe('LevelsService.create', () => {
  it.each(['funcionário', ' Funcionário '])(
    'nome repetido %j → 409 levels.name_taken',
    async (name) => {
      const { repo, service } = harness();
      await expect(service.create(ACTOR, { name })).rejects.toMatchObject({
        status: 409,
        code: 'levels.name_taken',
      });
      expect(repo.createWithAudit).not.toHaveBeenCalled();
    },
  );

  it('corrida no nome único do banco (P2002) → 409 levels.name_taken', async () => {
    const { repo, service } = harness();
    repo.createWithAudit.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(ACTOR, { name: 'Gerente' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'levels.name_taken',
    });
  });
});

describe('LevelsService.update', () => {
  it('renomear Funcionário para Colaborador devolve o novo nome', async () => {
    const { repo, service } = harness();

    const updated = await service.update(ACTOR, 'level_employee', {
      name: ' Colaborador ',
    });

    expect(repo.updateWithAudit).toHaveBeenCalledWith(
      'level_employee',
      { name: 'Colaborador' },
      expect.any(Function),
      undefined,
    );
    expect(updated).toMatchObject({
      id: 'level_employee',
      name: 'Colaborador',
    });
  });

  it('trilha level.update com antes e depois, categoria STRUCTURE', async () => {
    const { audit, service } = harness();

    await service.update(ACTOR, 'level_employee', { name: 'Colaborador' });

    expect(audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'level.update',
      actorId: ACTOR,
      entity: 'StaffLevel',
      entityId: 'level_employee',
      category: 'STRUCTURE',
      changes: [{ field: 'name', before: 'Funcionário', after: 'Colaborador' }],
    });
  });
});

describe('LevelsService.update', () => {
  it('desativar entrega o guard da desativação ao repositório; reativar não', async () => {
    const { repo, service } = harness();

    const updated = await service.update(ACTOR, 'level_employee', {
      isActive: false,
    });
    await service.update(ACTOR, 'level_employee', { isActive: true });

    expect(repo.updateWithAudit).toHaveBeenNthCalledWith(
      1,
      'level_employee',
      { isActive: false },
      expect.any(Function),
      expect.any(Function),
    );
    expect(repo.updateWithAudit).toHaveBeenNthCalledWith(
      2,
      'level_employee',
      { isActive: true },
      expect.any(Function),
      undefined,
    );
    expect(updated).toMatchObject({ isActive: false, userCount: 5 });
  });

  it('id inexistente → 404 levels.not_found', async () => {
    const { repo, service } = harness();
    await expect(
      service.update(ACTOR, 'level_missing', { name: 'Gerente' }),
    ).rejects.toMatchObject({ status: 404, code: 'levels.not_found' });
    expect(repo.updateWithAudit).not.toHaveBeenCalled();
  });

  it('PATCH sem campo nenhum → 400 (o pipe recusa o corpo vazio)', () => {
    expect(UpdateLevelDto.schema.safeParse({}).success).toBe(false);
    expect(UpdateLevelDto.schema.safeParse({ isActive: false }).success).toBe(
      true,
    );
  });
});

describe('LevelsService.reorder', () => {
  it.each([
    [
      'id repetido',
      [
        'level_coordinator',
        'level_coordinator',
        'level_leader',
        'level_employee',
      ],
    ],
    ['faltando um', ['level_coordinator', 'level_leader', 'level_employee']],
    [
      'id estranho',
      ['level_coordinator', 'level_leader', 'level_employee', 'level_other'],
    ],
  ])('ordem inválida (%s) → 422 levels.invalid_order', async (_case, ids) => {
    const { repo, audit, service } = harness();
    await expect(service.reorder(ACTOR, ids)).rejects.toMatchObject({
      status: 422,
      code: 'levels.invalid_order',
    });
    expect(repo.reorderWithAudit).not.toHaveBeenCalled();
    expect(audit.recordChange).not.toHaveBeenCalled();
  });

  it('ordem completa grava 1..n e devolve a lista', async () => {
    const { repo, audit, service } = harness();
    const ids = [...ALL.map((l) => l.id)].reverse();

    const result = await service.reorder(ACTOR, ids);

    expect(repo.reorderWithAudit).toHaveBeenCalledWith(
      ids,
      expect.any(Function),
    );
    expect(audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'level.reorder',
      actorId: ACTOR,
      entity: 'StaffLevel',
      entityId: null,
      category: 'STRUCTURE',
      changes: [{ field: 'order', before: NAMES, after: REVERSED_NAMES }],
    });
    expect(result.items).toHaveLength(4);
  });
});
