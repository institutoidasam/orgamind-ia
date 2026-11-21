import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TeamPendencyHandoverService } from './team-pendency-handover.service';
import {
  grantPermission,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-handover.targets.integration.spec.ts
 * Destinos da passagem de pendências (K3-4, K2-7, aceite 28).
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const FORBIDDEN = { code: 'team_whatsapp.forbidden' };
const NOT_HANDLER = { code: 'team_whatsapp.not_handler' };
const PERMISSION_DENIED = { code: 'auth.permission_denied' };

let db: TestDb;
let service: TeamPendencyHandoverService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  service = new TeamPendencyHandoverService(
    db.prisma as unknown as PrismaService,
    {} as AuditService,
  );
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Person = { id: string; name: string };

/** Gestor ativo (remetente) de um setor novo. */
async function boss(role: Role, name: string): Promise<Person> {
  const user = await newTeamUser(db, { role, name });
  await newSector(db, { managerId: user.id });
  return user;
}

/** Quem pede (OPERATOR gestor) e as pessoas que podem receber, mais as que nunca podem. */
async function world() {
  const actor = await boss('OPERATOR', 'Olavo Operador');
  const eligible = [
    await newTeamUser(db, { role: 'ADMIN', name: 'Alice Admin' }),
    await boss('SUPERVISOR', 'Bruno Supervisor'),
    await boss('OPERATOR', 'Dora Operadora'),
  ];
  const viewer = await boss('VIEWER', 'Vera Leitora');
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
    await newTeamUser(db, { role: 'SUPERVISOR', name: 'Gil Sem Setor' }),
    await newTeamUser(db, { role: 'OPERATOR', name: 'Hana Sem Setor' }),
    viewer,
  ];
  const known = new Set([actor, ...eligible, ...excluded].map(({ id }) => id));
  return { actor, eligible, known };
}

type World = Awaited<ReturnType<typeof world>>;

/** Destinos que são pessoas da `world` (o banco é compartilhado entre os testes). */
async function knownTargets(w: World, actorId: string, fromUserId?: string) {
  const res = await service.targets(actorId, fromUserId);
  return res.items.filter(({ id }) => w.known.has(id));
}

describe.skipIf(!ENABLED)('destinos da passagem — ordem das recusas', () => {
  it('ator relido sem equipe.enviar pedindo fromUserId de outro — 403 auth.permission_denied, antes de not_handler', async () => {
    const w = await world();
    const [, bruno] = w.eligible;
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      await expect(service.targets(w.actor.id, bruno.id)).rejects.toMatchObject(
        PERMISSION_DENIED,
      );
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
  });
});

describe.skipIf(!ENABLED)('destinos da passagem (K2-7, aceite 28)', () => {
  it('aceite 28: destinos — só remetentes ativos, com acesso e equipe.enviar; sem quem sai; VIEWER e SUPERVISOR sem setor fora', async () => {
    const w = await world();
    const res = await service.targets(w.actor.id, undefined);
    expect(Object.keys(res)).toEqual(['items']);
    // `toEqual` estrito nas chaves: nada além de id e nome; quem sai (Olavo) fica de fora.
    expect(await knownTargets(w, w.actor.id)).toEqual(w.eligible);
  });

  it('sem equipe.enviar — o destino sai da lista e o ator relido sem a chave recebe 403 auth.permission_denied', async () => {
    const w = await world();
    const boss = await newTeamUser(db, { role: 'SUPERVISOR' });
    await newSector(db, { managerId: boss.id });
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      const names = (await knownTargets(w, boss.id)).map(({ name }) => name);
      expect(names).toEqual(['Alice Admin', 'Bruno Supervisor']);
      await expect(
        service.targets(w.actor.id, undefined),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
  });

  it('nome que é telefone sai mascarado sem telefone.ver_completo', async () => {
    const w = await world();
    const phoneLike = await newTeamUser(db, {
      role: 'ADMIN',
      name: '+5592991110009',
    });
    const nameOf = async () =>
      (await service.targets(w.actor.id, undefined)).items.find(
        ({ id }) => id === phoneLike.id,
      )?.name;
    await revokePermission(db, 'OPERATOR', 'telefone.ver_completo');
    try {
      expect(await nameOf()).toBe('•••• 0009');
    } finally {
      await grantPermission(db, 'OPERATOR', 'telefone.ver_completo');
    }
  });
});

describe.skipIf(!ENABLED)(
  'destinos da passagem — quem sai e recusas (DT4)',
  () => {
    it('fromUserId de outro — OPERATOR 403 not_handler; ADMIN tira o outro da lista', async () => {
      const w = await world();
      const [alice, bruno] = w.eligible;
      await expect(service.targets(w.actor.id, bruno.id)).rejects.toMatchObject(
        NOT_HANDLER,
      );
      const asAdmin = await knownTargets(w, alice.id, bruno.id);
      expect(asAdmin.map(({ name }) => name)).toEqual([
        'Alice Admin',
        'Dora Operadora',
        'Olavo Operador',
      ]);
    });

    it('não remetente — 403 forbidden, antes de not_handler', async () => {
      const w = await world();
      const [, bruno] = w.eligible;
      const lonely = await newTeamUser(db, { role: 'SUPERVISOR' });
      const inactive = await newTeamUser(db, {
        role: 'ADMIN',
        isActive: false,
      });
      const viewer = await boss('VIEWER', 'Vitor Leitor');
      const nobody = [lonely.id, inactive.id, viewer.id, 'inexistente'];
      for (const actorId of nobody) {
        await expect(service.targets(actorId, undefined)).rejects.toMatchObject(
          FORBIDDEN,
        );
        await expect(service.targets(actorId, bruno.id)).rejects.toMatchObject(
          FORBIDDEN,
        );
      }
    });
  },
);
