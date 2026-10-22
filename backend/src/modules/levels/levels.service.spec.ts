import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LevelAdmin } from '../../schemas/contracts/level.schema';
import { UpdateLevelDto } from './dto/update-level.dto';
import { LevelsService } from './levels.service';

const ACTOR = 'user_admin';

function level(id: string, name: string, sortOrder: number, userCount = 0) {
  return { id, name, sortOrder, userCount, isActive: true };
}

const COORDINATOR = level('level_coordinator', 'Coordenador', 1);
const LEADER = level('level_leader', 'Líder', 2);
const EMPLOYEE = level('level_employee', 'Funcionário', 3, 5);
const OPERATOR = level('level_operator', 'Operador', 4);
const ALL = [COORDINATOR, LEADER, EMPLOYEE, OPERATOR];

// Repositório em memória: a comparação sem caixa é do repositório (integração);
// aqui ela não apara espaços, para provar que o serviço apara antes de consultar.
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
    create: vi.fn((data: object) =>
      Promise.resolve({
        id: 'level_new',
        isActive: true,
        userCount: 0,
        ...data,
      }),
    ),
    update: vi.fn((id: string, data: object) =>
      Promise.resolve({ ...byId(id), ...data }),
    ),
    setOrder: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
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

    expect(repo.create).toHaveBeenCalledWith({
      name: 'Estagiário',
      sortOrder: 5,
    });
    expect(created).toEqual({
      id: 'level_new',
      name: 'Estagiário',
      sortOrder: 5,
      isActive: true,
      userCount: 0,
    });
  });

  it('auditoria level.create com actorId e levelId, sem nome', async () => {
    const { audit, service } = harness();

    await service.create(ACTOR, { name: 'Estagiário' });

    expect(audit.log).toHaveBeenCalledWith(
      'level.create',
      'StaffLevel',
      'level_new',
      {
        actorId: ACTOR,
        levelId: 'level_new',
      },
    );
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
      expect(repo.create).not.toHaveBeenCalled();
    },
  );

  it('corrida no nome único do banco (P2002) → 409 levels.name_taken', async () => {
    const { repo, service } = harness();
    repo.create.mockRejectedValue(
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

    expect(repo.update).toHaveBeenCalledWith('level_employee', {
      name: 'Colaborador',
    });
    expect(updated).toMatchObject({
      id: 'level_employee',
      name: 'Colaborador',
    });
  });

  it('auditoria level.update com actorId e levelId, sem nome', async () => {
    const { audit, service } = harness();

    await service.update(ACTOR, 'level_employee', { name: 'Colaborador' });

    expect(audit.log).toHaveBeenCalledWith(
      'level.update',
      'StaffLevel',
      'level_employee',
      {
        actorId: ACTOR,
        levelId: 'level_employee',
      },
    );
  });
});

describe('LevelsService.update', () => {
  it('desativar nível em uso é aceito (as pessoas ficam com ele)', async () => {
    const { repo, service } = harness();

    const updated = await service.update(ACTOR, 'level_employee', {
      isActive: false,
    });

    expect(repo.update).toHaveBeenCalledWith('level_employee', {
      isActive: false,
    });
    expect(updated).toMatchObject({ isActive: false, userCount: 5 });
  });

  it('id inexistente → 404 levels.not_found', async () => {
    const { repo, service } = harness();
    await expect(
      service.update(ACTOR, 'level_missing', { name: 'Gerente' }),
    ).rejects.toMatchObject({ status: 404, code: 'levels.not_found' });
    expect(repo.update).not.toHaveBeenCalled();
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
    expect(repo.setOrder).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('ordem completa grava 1..n e devolve a lista', async () => {
    const { repo, audit, service } = harness();
    const ids = [...ALL.map((l) => l.id)].reverse();

    const result = await service.reorder(ACTOR, ids);

    expect(repo.setOrder).toHaveBeenCalledWith(ids);
    expect(audit.log).toHaveBeenCalledWith(
      'level.reorder',
      'StaffLevel',
      undefined,
      {
        actorId: ACTOR,
      },
    );
    expect(result.items).toHaveLength(4);
  });
});
