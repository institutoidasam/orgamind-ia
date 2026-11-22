import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PeopleExportQuery } from '../../schemas/contracts/people-export.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  exportSectorNotFound,
  exportShiftNotFound,
  noManagedSector,
  peopleTooLarge,
  sectorOutOfReach,
} from './people-export.errors';
import {
  PeopleExportService,
  type PeopleExportPlan,
} from './people-export.service';
import {
  MASKED,
  NAMES,
  PHONE_NAME,
  candidate,
  expectDomainError,
  fakeRepo,
  firstFilter,
  teamActor,
  type FakeRepoData,
} from './people-export.service.fixtures';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

const TODAY = '2026-11-19';
const NOW = new Date('2026-11-19T15:00:00Z'); // 11:00 em Manaus
const ADMIN = teamActor('ADMIN');
const MANAGER = teamActor('SUPERVISOR', { managedSectorIds: ['s1', 's3'] });
const BLIND = teamActor('SUPERVISOR', {
  managedSectorIds: ['s1'],
  revoke: ['telefone.ver_completo'],
});
const BASE_QUERY: PeopleExportQuery = {
  format: 'csv',
  status: 'active',
  sectorId: undefined,
  shiftId: undefined,
};

type Setup = {
  actor?: TeamActor | null;
  data?: FakeRepoData;
  query?: Partial<PeopleExportQuery>;
};

function run(setup: Setup = {}) {
  const repo = fakeRepo(setup.data);
  const actor = setup.actor === undefined ? ADMIN : setup.actor;
  vi.mocked(findTeamActor).mockResolvedValue(actor);
  const service = new PeopleExportService(
    {} as unknown as PrismaService,
    repo.repo,
    {} as unknown as AuditService,
  );
  const plan = () =>
    service.planPeopleExport('actor-1', { ...BASE_QUERY, ...setup.query });
  return { repo, plan };
}

const idsOf = (plan: PeopleExportPlan) => plan.entries.map((e) => e.id);
const entryOf = (plan: PeopleExportPlan, id: string) =>
  plan.entries.find((e) => e.id === id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('planPeopleExport: filtro por setor e turno (aceite 1)', () => {
  it('devolve só as pessoas do filtro, ordenadas pelo nome exibido', async () => {
    const { repo, plan } = run({
      query: { sectorId: 's1', shiftId: 't1' },
      data: {
        candidates: [
          candidate({ id: 'p1', name: 'Zélia' }),
          candidate({ id: 'p2', name: 'Ana' }),
          candidate({ id: 'p3', name: 'Bia', shiftId: 't2' }),
          candidate({ id: 'p4', name: 'Caio', sectorId: 's2' }),
        ],
      },
    });
    const result = await plan();
    expect(idsOf(result)).toEqual(['p2', 'p1']);
    expect(result.sector).toEqual({ id: 's1', name: 'Logística' });
    expect(result.shift).toEqual({ id: 't1', name: 'Manhã' });
    expect(result.viewer).toEqual({
      isAdmin: true,
      fullPhone: true,
      reach: null,
    });
    expect(result.names).toBe(NAMES);
    expect(firstFilter(repo).mirror).toEqual({
      sectorIds: ['s1'],
      shiftId: 't1',
    });
  });

  it('sem resultado: plano com entries vazio, sem erro', async () => {
    const { plan } = run({ data: { candidates: [] } });
    const result = await plan();
    expect(result.entries).toEqual([]);
    expect(result.sector).toBeNull();
    expect(result.shift).toBeNull();
  });
});

describe('planPeopleExport: telefone e nome por linha (aceite 3)', () => {
  const people = [
    candidate({ id: 'p1', name: PHONE_NAME, hasAccess: true }),
    candidate({ id: 'p2', name: PHONE_NAME }),
    candidate({ id: 'p3', name: 'Bia' }),
  ];

  it('sem telefone.ver_completo, tudo sai mascarado, inclusive o nome-telefone', async () => {
    const { plan } = run({ actor: BLIND, data: { candidates: people } });
    const result = await plan();
    expect(entryOf(result, 'p1')).toMatchObject({
      phoneFull: false,
      displayName: MASKED,
    });
    expect(entryOf(result, 'p2')).toMatchObject({
      phoneFull: false,
      displayName: MASKED,
    });
    expect(entryOf(result, 'p3')).toMatchObject({
      phoneFull: false,
      displayName: 'Bia',
    });
  });

  it('gestor com a chave: pessoa com login mascarada, sem login completa', async () => {
    const { plan } = run({ actor: MANAGER, data: { candidates: people } });
    const result = await plan();
    expect(result.viewer.fullPhone).toBe(true);
    expect(entryOf(result, 'p1')).toMatchObject({
      phoneFull: false,
      displayName: MASKED,
    });
    expect(entryOf(result, 'p2')).toMatchObject({
      phoneFull: true,
      displayName: PHONE_NAME,
    });
  });
});

describe('planPeopleExport: alcance sem setor escolhido (aceite 4)', () => {
  const people = [
    candidate({ id: 'p1', sectorId: 's1' }),
    candidate({ id: 'p2', sectorId: 's3' }),
    candidate({ id: 'p3', sectorId: 's2' }),
    candidate({ id: 'p4', sectorId: null }),
  ];

  it('gestor recebe só os setores que gerencia e o SQL leva o alcance', async () => {
    const { repo, plan } = run({
      actor: MANAGER,
      data: { candidates: people },
    });
    const result = await plan();
    expect(idsOf(result)).toEqual(['p2', 'p1']);
    expect(result.viewer.reach).toEqual(['s1', 's3']);
    expect(firstFilter(repo).mirror?.sectorIds).toEqual(['s1', 's3']);
  });

  it('ADMIN recebe todos, inclusive sem setor, e o espelho não restringe setor', async () => {
    const { repo, plan } = run({ data: { candidates: people } });
    const result = await plan();
    expect(idsOf(result)).toEqual(['p3', 'p2', 'p1', 'p4']);
    expect(result.viewer.reach).toBeNull();
    expect(firstFilter(repo).mirror?.sectorIds).toBeNull();
  });
});

describe('planPeopleExport: corte por cadastro e hoje (GX6)', () => {
  it('data passada: createdBefore é o início do dia seguinte em Manaus, sem espelho', async () => {
    const { repo, plan } = run({ query: { date: '2026-11-18' } });
    const result = await plan();
    expect(firstFilter(repo).createdBefore.toISOString()).toBe(
      '2026-11-19T04:00:00.000Z',
    );
    expect(firstFilter(repo).mirror).toBeNull();
    expect(result).toMatchObject({ today: TODAY, date: '2026-11-18' });
  });

  it('exportação de hoje: dia seguinte a hoje, com espelho', async () => {
    const { repo, plan } = run({ query: { shiftId: 't2', status: 'all' } });
    const result = await plan();
    const filter = firstFilter(repo);
    expect(filter.createdBefore.toISOString()).toBe('2026-11-20T04:00:00.000Z');
    expect(filter.status).toBe('all');
    expect(filter.mirror).toEqual({ sectorIds: null, shiftId: 't2' });
    expect(result).toMatchObject({ today: TODAY, date: TODAY });
  });
});

describe('planPeopleExport: hoje uma vez só (GX6)', () => {
  it('quando UTC já virou o dia e Manaus não, vale o dia de Manaus', async () => {
    vi.setSystemTime(new Date('2026-11-20T02:00:00Z')); // 22:00 de 19/11 em Manaus
    const { repo, plan } = run({ query: { date: TODAY } });
    const result = await plan();
    expect(result).toMatchObject({ today: TODAY, date: TODAY });
    expect(firstFilter(repo).mirror).not.toBeNull();
    expect(firstFilter(repo).createdBefore.toISOString()).toBe(
      '2026-11-20T04:00:00.000Z',
    );
  });

  it('virar a meia-noite durante a leitura não muda o recorte', async () => {
    const people = Array.from({ length: 1_001 }, (_, i) =>
      candidate({ id: `p${String(i).padStart(4, '0')}` }),
    );
    const { repo, plan } = run({ data: { candidates: people } });
    repo.pageCandidates.mockImplementationOnce(() => {
      vi.setSystemTime(new Date('2026-11-20T05:00:00Z'));
      return Promise.resolve(people.slice(0, 1_000));
    });
    const result = await plan();
    expect(result).toMatchObject({ today: TODAY, date: TODAY });
    expect(result.entries).toHaveLength(1_001);
    expect(repo.linesOn).not.toHaveBeenCalled();
  });
});

describe('planPeopleExport: vínculo da data (aceite 6)', () => {
  const lines = {
    p1: [
      { sectorId: 's1', shiftId: 't1', levelId: 'n1', from: null, to: null },
    ],
  };
  const moved = candidate({ id: 'p1', name: PHONE_NAME, sectorId: 's2' });

  it('data passada mostra o setor daquele dia, não o do espelho', async () => {
    const { repo, plan } = run({
      query: { date: '2026-11-10' },
      data: { candidates: [moved], lines },
    });
    const result = await plan();
    expect(entryOf(result, 'p1')?.sectorName).toBe('Logística');
    expect(repo.linesOn).toHaveBeenCalledWith(['p1'], '2026-11-10');
  });

  it('gestor: quem estava no setor dele na data entra, mas hoje está em outro, mascarado', async () => {
    const { plan } = run({
      actor: MANAGER,
      query: { date: '2026-11-10' },
      data: { candidates: [moved], lines },
    });
    const result = await plan();
    expect(idsOf(result)).toEqual(['p1']);
    expect(entryOf(result, 'p1')).toMatchObject({
      phoneFull: false,
      displayName: MASKED,
    });
  });
});

describe('planPeopleExport: linhas de vínculo só para data passada', () => {
  it.each([[undefined], [TODAY], ['2026-12-01']])(
    'data %s não consulta as linhas',
    async (date) => {
      const { repo, plan } = run({
        query: { date },
        data: { candidates: [candidate()] },
      });
      await plan();
      expect(repo.linesOn).not.toHaveBeenCalled();
    },
  );

  it('data passada consulta uma vez por página', async () => {
    const { repo, plan } = run({
      query: { date: '2026-11-18' },
      data: { candidates: [candidate()] },
    });
    await plan();
    expect(repo.linesOn).toHaveBeenCalledTimes(1);
  });
});

describe('planPeopleExport: ator e alcance (DX12)', () => {
  it.each([
    ['inexistente', null],
    ['inativo', teamActor('ADMIN', { isActive: false })],
    ['sem acesso', teamActor('ADMIN', { hasAccess: false })],
  ])('ator %s: 403 sectorOutOfReach, sem ler pessoas', async (_name, actor) => {
    const { repo, plan } = run({ actor });
    await expectDomainError(plan(), sectorOutOfReach());
    expect(repo.pageCandidates).not.toHaveBeenCalled();
  });

  it.each([['s2'], ['setor-que-nao-existe']])(
    'gestor com setor %s: o mesmo 403, antes de ler pessoas',
    async (sectorId) => {
      const { repo, plan } = run({ actor: MANAGER, query: { sectorId } });
      await expectDomainError(plan(), sectorOutOfReach());
      expect(repo.pageCandidates).not.toHaveBeenCalled();
      expect(repo.detailsByIds).not.toHaveBeenCalled();
    },
  );

  it('gestor sem setor: 403 noManagedSector, antes de ler nomes e pessoas', async () => {
    const { repo, plan } = run({ actor: teamActor('SUPERVISOR') });
    await expectDomainError(plan(), noManagedSector());
    expect(repo.nameMaps).not.toHaveBeenCalled();
    expect(repo.pageCandidates).not.toHaveBeenCalled();
  });
});

describe('planPeopleExport: setor e turno inexistentes (DX12)', () => {
  it('ADMIN com setor inexistente: 404 do setor', async () => {
    const { repo, plan } = run({ query: { sectorId: 'nada' } });
    await expectDomainError(plan(), exportSectorNotFound());
    expect(repo.pageCandidates).not.toHaveBeenCalled();
  });

  it.each([[ADMIN], [MANAGER]])(
    'turno inexistente: 404 do turno para qualquer papel',
    async (actor) => {
      const { repo, plan } = run({ actor, query: { shiftId: 'nada' } });
      await expectDomainError(plan(), exportShiftNotFound());
      expect(repo.pageCandidates).not.toHaveBeenCalled();
    },
  );
});

describe('planPeopleExport: limite de 50.000 (DX4)', () => {
  const many = (total: number) =>
    Array.from({ length: total }, (_, i) =>
      candidate({ id: `p${String(i).padStart(6, '0')}` }),
    );

  it('acima de 50.000: 422, para de ler na 51ª página e nunca chega aos detalhes', async () => {
    const { repo, plan } = run({ data: { candidates: many(52_000) } });
    await expectDomainError(plan(), peopleTooLarge());
    expect(repo.pageCandidates).toHaveBeenCalledTimes(51);
    expect(repo.detailsByIds).not.toHaveBeenCalled();
  });

  it('exatamente 50.000 passa', async () => {
    const { plan } = run({ data: { candidates: many(50_000) } });
    const result = await plan();
    expect(result.entries).toHaveLength(50_000);
  });
});

describe('planPeopleExport: setor do próprio alcance e ator do pedido', () => {
  it('gestor pedindo um setor que gerencia: o filtro leva só esse setor e o plano só as pessoas dele', async () => {
    const { repo, plan } = run({
      actor: MANAGER,
      query: { sectorId: 's1' },
      data: {
        candidates: [
          candidate({ id: 'p1', sectorId: 's1' }),
          candidate({ id: 'p2', sectorId: 's3' }),
          candidate({ id: 'p3', sectorId: 's1' }),
        ],
      },
    });
    const result = await plan();
    expect(firstFilter(repo).mirror?.sectorIds).toEqual(['s1']);
    expect(idsOf(result)).toEqual(['p1', 'p3']);
  });

  it('o ator consultado é o de quem fez o pedido', async () => {
    const { plan } = run();
    await plan();
    expect(findTeamActor).toHaveBeenCalledWith(expect.anything(), 'actor-1');
  });
});
