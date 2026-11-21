import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TeamPendencyService } from './team-pendency.service';
import {
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.handlers.integration.spec.ts
 * A lista de destinos é a regra do destino de Transferir (K2-7, `canHandlePendency`).
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const ago = (minutes: number) => at(-minutes);
const FORBIDDEN = { code: 'team_whatsapp.forbidden' };
const NOT_FOUND = { code: 'team_whatsapp.pendency_not_found' };

let db: TestDb;
let service: TeamPendencyService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  service = new TeamPendencyService(db.prisma as unknown as PrismaService);
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Boss = { id: string; name: string; sectorId: string; sectorName: string };

/** Gestor ativo (remetente) de um setor novo. */
async function boss(role: Role, name: string): Promise<Boss> {
  const user = await newTeamUser(db, { role, name });
  const sector = await newSector(db, { managerId: user.id });
  return { ...user, sectorId: sector.id, sectorName: sector.name };
}

/**
 * Pendência no setor do gestor Carla, de um alerta enviado pelo gestor Bruno
 * (de outro setor), que é o responsável atual. Quem a vê e é remetente com
 * `equipe.enviar`: o ADMIN Alice, Bruno (autor) e Carla (gestora do setor).
 */
async function world(authorRole: Role = 'OPERATOR') {
  const carla = await boss('SUPERVISOR', 'Carla Gestora');
  const bruno = await boss(authorRole, 'Bruno Autor');
  const alice = await newTeamUser(db, { role: 'ADMIN', name: 'Alice Admin' });
  const excluded = [
    await newTeamUser(db, {
      role: 'ADMIN',
      name: 'Diego Inativo',
      isActive: false,
    }),
    await newTeamUser(db, {
      role: 'ADMIN',
      name: 'Elisa Sem Acesso',
      hasAccess: false,
    }),
    await boss('SUPERVISOR', 'Fabio Outro Setor'),
    await newTeamUser(db, { role: 'SUPERVISOR', name: 'Gil Sem Setor' }),
  ];
  const dispatchId = await newAlert(db, {
    authorId: bruno.id,
    createdAt: ago(30),
  });
  const pendencyId = await newPendency(db, {
    dispatchId,
    sectorId: carla.sectorId,
    sectorName: carla.sectorName,
    handlerId: bruno.id,
  });
  const eligible = [alice, bruno, carla].map(({ id, name }) => ({ id, name }));
  const known = new Set([...eligible, ...excluded].map(({ id }) => id));
  return { actorId: carla.id, pendencyId, eligible, known };
}

type World = Awaited<ReturnType<typeof world>>;

/** Destinos desta pendência que são pessoas da `world` (o banco é compartilhado entre os testes). */
async function knownHandlers(w: World) {
  const res = await service.handlers(w.actorId, w.pendencyId);
  return res.items.filter(({ id }) => w.known.has(id));
}

describe.skipIf(!ENABLED)('destinos da pendência (K2-7, aceite 17)', () => {
  it('destinos — só ativos com acesso, equipe.enviar e que veem a pendência; id e nome; ordem por nome', async () => {
    const w = await world();
    const res = await service.handlers(w.actorId, w.pendencyId);
    expect(Object.keys(res)).toEqual(['items']);
    // `toEqual` estrito nas chaves: nada além de id e nome. O responsável atual
    // (Bruno) e quem pergunta (Carla) ficam: tirar o responsável é do front.
    expect(await knownHandlers(w)).toEqual(w.eligible);
  });

  it('destino sem equipe.enviar sai da lista', async () => {
    const w = await world('OPERATOR');
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      expect(await knownHandlers(w)).toEqual(
        w.eligible.filter(({ name }) => name !== 'Bruno Autor'),
      );
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
  });

  it('nome que é telefone sai mascarado sem telefone.ver_completo', async () => {
    const w = await world();
    const phoneName = '+5592991110009';
    const phoneLike = await newTeamUser(db, { role: 'ADMIN', name: phoneName });
    const nameOf = async () =>
      (await service.handlers(w.actorId, w.pendencyId)).items.find(
        ({ id }) => id === phoneLike.id,
      )?.name;
    expect(await nameOf()).toBe(phoneName);
    await revokePermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    try {
      expect(await nameOf()).toBe('•••• 0009');
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    }
  });
});

describe.skipIf(!ENABLED)('destinos — recusas (K2-4, aceite 12)', () => {
  it('destinos — fora do alcance 404 pendency_not_found; não remetente 403 forbidden', async () => {
    const w = await world();
    const outsider = await boss('SUPERVISOR', 'Hugo Outro Setor');
    const viewer = await newTeamUser(db, { role: 'VIEWER' });
    await newSector(db, { managerId: viewer.id });
    const lonely = await newTeamUser(db, { role: 'SUPERVISOR' });
    const handlers = (actorId: string, id = w.pendencyId) =>
      service.handlers(actorId, id);
    await expect(handlers(outsider.id)).rejects.toMatchObject(NOT_FOUND);
    await expect(handlers(w.actorId, 'inexistente')).rejects.toMatchObject(
      NOT_FOUND,
    );
    // 403 antes do 404: quem não é remetente não descobre se a pendência existe.
    await expect(handlers(viewer.id)).rejects.toMatchObject(FORBIDDEN);
    await expect(handlers(lonely.id, 'inexistente')).rejects.toMatchObject(
      FORBIDDEN,
    );
  });
});
