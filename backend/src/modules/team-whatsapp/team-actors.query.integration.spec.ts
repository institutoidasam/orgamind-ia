import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findEffectivePermissions } from '../permissions/permissions.query';
import { findTeamActor } from './team-actor.query';
import {
  findTeamActors,
  handlerStatesFor,
  listHandlerCandidates,
} from './team-actors.query';
import {
  grantPermission,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

// Espião que mantém o comportamento real: conta as leituras de permissão por papel.
vi.mock('../permissions/permissions.query', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../permissions/permissions.query')>();
  return {
    ...original,
    findEffectivePermissions: vi.fn(original.findEffectivePermissions),
  };
});

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-actors.query.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: TestDb;
const service = () => db.prisma as unknown as PrismaService;

beforeAll(async () => {
  if (ENABLED) db = await startPendencyDb();
}, 180_000);

// Os testes que desligam `equipe.enviar` do OPERATOR devolvem a matriz ao padrão.
afterEach(async () => {
  if (ENABLED) await grantPermission(db, 'OPERATOR', 'equipe.enviar');
});

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

const permissionReads = () =>
  vi.mocked(findEffectivePermissions).mock.calls.map(([, role]) => role);

async function seedFormatCase() {
  const supervisor = await newTeamUser(db, { role: 'SUPERVISOR' });
  const operator = await newTeamUser(db, { role: 'OPERATOR' });
  const active = await newSector(db, { managerId: supervisor.id });
  await newSector(db, { managerId: supervisor.id, isActive: false });
  await revokePermission(db, 'OPERATOR', 'equipe.enviar');
  return { supervisor, operator, active };
}

describe.skipIf(!ENABLED)('findTeamActors', () => {
  it('findTeamActors — mesmo formato de findTeamActor; setores geridos só ativos; permissões do papel', async () => {
    const { supervisor, operator, active } = await seedFormatCase();
    const ids = [supervisor.id, operator.id, 'inexistente'];
    const actors = await findTeamActors(service(), ids);
    expect(actors.size).toBe(2);
    for (const { id, name } of [supervisor, operator]) {
      const single = await findTeamActor(service(), id);
      expect(actors.get(id)).toEqual({ ...single, name });
    }
    expect(actors.get(supervisor.id)?.managedSectorIds).toEqual([active.id]);
    expect(actors.get(supervisor.id)?.permissions).toContain('equipe.enviar');
    expect(actors.get(operator.id)?.permissions).not.toContain('equipe.enviar');
  });

  it('uma chamada de findEffectivePermissions por papel', async () => {
    const people = [
      await newTeamUser(db, { role: 'SUPERVISOR' }),
      await newTeamUser(db, { role: 'SUPERVISOR' }),
      await newTeamUser(db, { role: 'OPERATOR' }),
      await newTeamUser(db, { role: 'ADMIN' }),
    ];
    vi.mocked(findEffectivePermissions).mockClear();
    await findTeamActors(
      service(),
      people.map((p) => p.id),
    );
    expect(permissionReads().sort()).toEqual([
      'ADMIN',
      'OPERATOR',
      'SUPERVISOR',
    ]);
    vi.mocked(findEffectivePermissions).mockClear();
    expect(await findTeamActors(service(), [])).toEqual(new Map());
    expect(permissionReads()).toEqual([]);
  });
});

/** Três candidatos (um por papel, nomes fora de ordem) e três que não podem ser. */
async function seedCandidates() {
  const sector = await newSector(db);
  const eligible = [
    await newTeamUser(db, { role: 'OPERATOR', name: 'Cand Gama' }),
    await newTeamUser(db, { role: 'ADMIN', name: 'Cand Alfa' }),
    await newTeamUser(db, { role: 'SUPERVISOR', name: 'Cand Beta' }),
  ];
  const excluded = [
    await newTeamUser(db, { role: 'VIEWER', name: 'Cand Delta' }),
    await newTeamUser(db, {
      role: 'OPERATOR',
      name: 'Cand Eta',
      isActive: false,
    }),
    await newTeamUser(db, {
      role: 'OPERATOR',
      name: 'Cand Zeta',
      hasAccess: false,
    }),
  ];
  await db.prisma.sector.update({
    where: { id: sector.id },
    data: { managerId: eligible[2].id },
  });
  return { sector, eligible, excluded };
}

describe.skipIf(!ENABLED)('listHandlerCandidates', () => {
  it('listHandlerCandidates — só ADMIN, SUPERVISOR e OPERATOR ativos com acesso, ordem por nome', async () => {
    const { sector, eligible, excluded } = await seedCandidates();
    const all = await listHandlerCandidates(service());
    const mine = new Set([...eligible, ...excluded].map((u) => u.id));
    const found = all.filter((actor) => mine.has(actor.id));
    expect(found.map((actor) => actor.name)).toEqual([
      'Cand Alfa',
      'Cand Beta',
      'Cand Gama',
    ]);
    expect(found[1]).toMatchObject({
      role: 'SUPERVISOR',
      managedSectorIds: [sector.id],
    });
    expect(found[1].permissions).toContain('equipe.enviar');
  });
});

type Seeded = {
  rows: Parameters<typeof handlerStatesFor>[1];
  names: Record<'active' | 'inactive' | 'noAccess' | 'noSend', string>;
};

/** Um responsável de cada tipo e as linhas que os usam (fatos de alcance no setor `s1`). */
async function seedHandlerRows(): Promise<Seeded> {
  const s1 = await newSector(db);
  const s2 = await newSector(db);
  const active = await newTeamUser(db, { role: 'SUPERVISOR' });
  const noSend = await newTeamUser(db, { role: 'OPERATOR' });
  const inactive = await newTeamUser(db, { role: 'OPERATOR', isActive: false });
  const noAccess = await newTeamUser(db, {
    role: 'OPERATOR',
    hasAccess: false,
  });
  await db.prisma.sector.update({
    where: { id: s1.id },
    data: { managerId: active.id },
  });
  await db.prisma.sector.update({
    where: { id: s2.id },
    data: { managerId: noSend.id },
  });
  await revokePermission(db, 'OPERATOR', 'equipe.enviar');
  const facts = (handlerId: string | null, sectorId: string) => ({
    handlerId,
    isAlert: true,
    authorId: null,
    sectorId,
    personSectorId: null,
  });
  return {
    rows: [
      facts(null, s1.id),
      facts('inexistente', s1.id),
      facts(inactive.id, s1.id),
      facts(noAccess.id, s1.id),
      facts(active.id, s1.id),
      facts(active.id, s2.id),
      facts(noSend.id, s2.id),
    ],
    names: {
      active: active.name,
      inactive: inactive.name,
      noAccess: noAccess.name,
      noSend: noSend.name,
    },
  };
}

describe.skipIf(!ENABLED)('handlerStatesFor', () => {
  it('handlerStatesFor — sem responsável null; inexistente, inativo, sem acesso inactive; sem equipe.enviar e fora do setor out_of_scope; nome do usuário', async () => {
    const { rows, names } = await seedHandlerRows();
    expect(await handlerStatesFor(service(), rows)).toEqual([
      null,
      { state: 'inactive', name: null },
      { state: 'inactive', name: names.inactive },
      { state: 'inactive', name: names.noAccess },
      { state: 'active', name: names.active },
      { state: 'out_of_scope', name: names.active },
      { state: 'out_of_scope', name: names.noSend },
    ]);
  });
});
