import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  assertCanWrite,
  canSeeBatch,
  loadImportActor,
  phoneFullFor,
  toImportActor,
  type ImportActor,
} from './import-actor';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

const prisma = {} as PrismaService;

function teamActor(
  role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR',
  change: Parameters<typeof actorWith>[1] = {},
  extra: Partial<TeamActor> = {},
): TeamActor {
  return { ...actorWith(role, change), managedSectorIds: [], ...extra };
}

function gestor(over: Partial<ImportActor> = {}): ImportActor {
  return {
    ...toImportActor(teamActor('SUPERVISOR', {}, { managedSectorIds: ['s1'] })),
    ...over,
  };
}

function denial(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as { code: string; status: number; detail?: string };
  }
  return null;
}

describe('toImportActor', () => {
  it('ADMIN sem alcance e com todas as chaves; gestor com setores e chaves', () => {
    const admin = toImportActor(
      teamActor('ADMIN', { id: 'adm' }, { managedSectorIds: ['s9'] }),
    );
    expect(admin).toMatchObject({
      id: 'adm',
      isAdmin: true,
      fullPhone: true,
      canEditPeople: true,
      reach: null,
    });
    expect(admin.policy).toMatchObject({ id: 'adm', role: 'ADMIN' });

    const manager = toImportActor(
      teamActor(
        'SUPERVISOR',
        { id: 'ger', grant: ['pessoas.importar'] },
        { managedSectorIds: ['s1', 's2'] },
      ),
    );
    expect(manager).toMatchObject({
      id: 'ger',
      isAdmin: false,
      fullPhone: true,
      canEditPeople: true,
      reach: ['s1', 's2'],
    });
    expect(manager.policy.permissions).toContain('pessoas.importar');
  });

  it('as chaves vêm do ator lido agora: sem telefone.ver_completo e sem pessoas.editar', () => {
    const limited = toImportActor(
      teamActor(
        'SUPERVISOR',
        { revoke: ['telefone.ver_completo', 'pessoas.editar'] },
        { managedSectorIds: ['s1'] },
      ),
    );

    expect(limited.fullPhone).toBe(false);
    expect(limited.canEditPeople).toBe(false);
    expect(phoneFullFor(limited)).toBe(false);
    expect(phoneFullFor(gestor())).toBe(true);
  });
});

describe('assertCanWrite', () => {
  it('ADMIN e gestor com a chave e setor gravam', () => {
    expect(() =>
      assertCanWrite(toImportActor(teamActor('ADMIN'))),
    ).not.toThrow();
    expect(() => assertCanWrite(gestor())).not.toThrow();
  });

  it('sem pessoas.editar 403 com o texto da chave; sem setor 403', () => {
    const noEdit = denial(() =>
      assertCanWrite(gestor({ canEditPeople: false })),
    );
    expect(noEdit).toMatchObject({
      code: 'auth.permission_denied',
      status: 403,
      detail: 'Você não tem permissão para cadastrar ou editar pessoas.',
    });

    const noSector = denial(() => assertCanWrite(gestor({ reach: [] })));
    expect(noSector).toMatchObject({
      code: 'people_import.no_managed_sector',
      status: 403,
      detail: 'Você não gerencia nenhum setor.',
    });

    const noReach = denial(() => assertCanWrite(gestor({ reach: null })));
    expect(noReach).toMatchObject({ code: 'people_import.no_managed_sector' });
  });
});

describe('canSeeBatch', () => {
  it('ADMIN vê todos; os demais só os seus', () => {
    const admin = toImportActor(teamActor('ADMIN', { id: 'adm' }));
    const manager = gestor();

    expect(canSeeBatch(admin, { createdById: 'outro' })).toBe(true);
    expect(canSeeBatch(manager, { createdById: manager.id })).toBe(true);
    expect(canSeeBatch(manager, { createdById: 'outro' })).toBe(false);
  });
});

describe('loadImportActor', () => {
  beforeEach(() => vi.mocked(findTeamActor).mockReset());

  it('monta o ator a partir de findTeamActor, lido a cada chamada', async () => {
    vi.mocked(findTeamActor)
      .mockResolvedValueOnce(
        teamActor('SUPERVISOR', {}, { managedSectorIds: ['s1'] }),
      )
      .mockResolvedValueOnce(
        teamActor(
          'SUPERVISOR',
          { revoke: ['pessoas.editar'] },
          { managedSectorIds: ['s1'] },
        ),
      );

    const first = await loadImportActor(prisma, 'actor-supervisor');
    const second = await loadImportActor(prisma, 'actor-supervisor');

    expect(findTeamActor).toHaveBeenCalledWith(prisma, 'actor-supervisor');
    expect(findTeamActor).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ canEditPeople: true, reach: ['s1'] });
    expect(second.canEditPeople).toBe(false);
  });

  it('recusa ator ausente, inativo ou sem acesso', async () => {
    const cases = [
      null,
      teamActor('ADMIN', {}, { isActive: false }),
      teamActor('ADMIN', {}, { hasAccess: false }),
    ];

    for (const found of cases) {
      vi.mocked(findTeamActor).mockResolvedValueOnce(found);
      await expect(loadImportActor(prisma, 'x')).rejects.toMatchObject({
        code: 'auth.permission_denied',
        status: 403,
        detail: 'Você não tem permissão para importar planilhas de pessoas.',
      });
    }
  });
});
