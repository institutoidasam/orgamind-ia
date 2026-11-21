import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendencyListQuerySchema } from '../../schemas/contracts/team-pendency.schema';
import { DomainError } from '../../shared/errors/domain.error';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamAlertAckService } from './team-alert-ack.service';
import { TeamPendencyActionsService } from './team-pendency-actions.service';
import { TeamPendencyController } from './team-pendency.controller';
import {
  closedBy,
  heldBy,
  readers,
} from './team-pendency.handling.test-fixtures';
import { TeamPendencyService } from './team-pendency.service';
import {
  T0,
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  startPendencyDb,
  stopPendencyDb,
  type NewPendencyInput,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

/**
 * Aceite 12 e Anti-objetivo 1 (K2-4), prova parametrizada em TODA rota de
 * pendência e de ciência manual: os serviços reais (`TeamPendencyService`,
 * `TeamPendencyActionsService`, `TeamAlertAckService`, o que cada controller
 * chama) contra o Postgres do testcontainer. O ator tem as chaves `equipe.enviar`
 * e `equipe.urgencia` e é remetente: o 404 é do alcance, nunca um 403 que o
 * mascare. Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.scope-routes.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = at(60);
const NOTE = 'Contato feito';
const FORBIDDEN = '403 team_whatsapp.forbidden';
const PENDENCY_404 = '404 team_whatsapp.pendency_not_found';
const DISPATCH_404 = '404 team_whatsapp.dispatch_not_found';

let db: TestDb;
let pendencies: TeamPendencyService;
let actions: TeamPendencyActionsService;
let ack: TeamAlertAckService;
let peerId: string;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  const prisma = db.prisma as unknown as PrismaService;
  pendencies = new TeamPendencyService(prisma);
  actions = new TeamPendencyActionsService(prisma, db.audit);
  const repo = new TeamWhatsappRepository(
    prisma,
    new StaffScheduleRepository(prisma),
  );
  ack = new TeamAlertAckService(repo, prisma, db.audit);
  // O ADMIN tem todas as chaves (a matriz não o edita); o SUPERVISOR as recebe aqui.
  await grantPermission(db, 'SUPERVISOR', 'equipe.enviar');
  await grantPermission(db, 'SUPERVISOR', 'equipe.urgencia');
  // Destino possível do Transferir: ADMIN ativo, com acesso e `equipe.enviar`.
  peerId = (await newTeamUser(db, { role: 'ADMIN' })).id;
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Start = Partial<Omit<NewPendencyInput, 'dispatchId'>>;
type Call = { who: string; d: string; r: string };
type Route = {
  name: string;
  /** Estado de partida da pendência: o mesmo no setor gerido e no de fora. */
  start: (who: string) => Start;
  /** Ciência manual já gravada (para o desfazer ter o que desfazer). */
  manual?: boolean;
  call: (c: Call) => Promise<unknown>;
};
type IdRoute = Route & { missing: string };

const open = (): Start => ({});
const held = (who: string): Start => heldBy(who);
const closedHeld = (who: string): Start => ({
  ...heldBy(who),
  ...closedBy(db.ids.admin),
});

/** Rotas sem id (a pendência semeada só serve ao teste de não remetente). */
const LIST_ROUTES: Route[] = [
  {
    name: 'list',
    start: open,
    call: ({ who }) =>
      pendencies.list(who, pendencyListQuerySchema.parse({}), NOW),
  },
  { name: 'count', start: open, call: ({ who }) => pendencies.count(who, NOW) },
];

/** Rotas de pendência (404 `pendency_not_found`) e de ciência manual (404 de envio, DK17). */
const ID_ROUTES: IdRoute[] = [
  {
    name: 'get',
    start: open,
    missing: PENDENCY_404,
    call: ({ who, r }) => pendencies.get(who, r, NOW),
  },
  {
    name: 'handlers',
    start: open,
    missing: PENDENCY_404,
    call: ({ who, r }) => pendencies.handlers(who, r),
  },
  {
    name: 'assume',
    start: open,
    missing: PENDENCY_404,
    call: ({ who, r }) =>
      actions.assume(who, r, { expectedHandlerId: null }, NOW),
  },
  {
    name: 'transfer',
    start: held,
    missing: PENDENCY_404,
    call: ({ who, r }) =>
      actions.transfer(
        who,
        r,
        { expectedHandlerId: who, toUserId: peerId },
        NOW,
      ),
  },
  {
    name: 'addNote',
    start: held,
    missing: PENDENCY_404,
    call: ({ who, r }) =>
      actions.addNote(who, r, { expectedHandlerId: who, text: NOTE }, NOW),
  },
  {
    name: 'close',
    start: held,
    missing: PENDENCY_404,
    call: ({ who, r }) =>
      actions.close(who, r, { expectedHandlerId: who, reason: NOTE }, NOW),
  },
  {
    name: 'reopen',
    start: closedHeld,
    missing: PENDENCY_404,
    call: ({ who, r }) =>
      actions.reopen(who, r, { expectedHandlerId: who }, NOW),
  },
  {
    name: 'markManual',
    start: open,
    missing: DISPATCH_404,
    call: ({ who, d, r }) =>
      ack.markManual(who, d, r, { note: NOTE, now: NOW }),
  },
  {
    name: 'undoManual',
    start: () => ({ ackAt: at(2) }),
    manual: true,
    missing: DISPATCH_404,
    call: ({ who, d, r }) => ack.undoManual(who, d, r),
  },
];

type Sector = { id: string; name: string };
type Cast = {
  manager: string;
  outsider: string;
  s1: Sector;
  s2: Sector;
  dispatchId: string;
};

/**
 * `manager` é SUPERVISOR do setor S1; o alerta é de OUTRO autor (o gestor de
 * S2, que nem o ADMIN nem o `manager` são); `outsider` é SUPERVISOR sem setor
 * ativo, logo não é remetente.
 */
async function newCast(): Promise<Cast> {
  const manager = await newTeamUser(db, { role: 'SUPERVISOR' });
  const rival = await newTeamUser(db, { role: 'SUPERVISOR' });
  const outsider = await newTeamUser(db, { role: 'SUPERVISOR' });
  const s1 = await newSector(db, { managerId: manager.id });
  const s2 = await newSector(db, { managerId: rival.id });
  const dispatchId = await newAlert(db, { authorId: rival.id, createdAt: T0 });
  return { manager: manager.id, outsider: outsider.id, s1, s2, dispatchId };
}

/** Pendência (Sem responsável, prazo de ciência vencido em `NOW`) do alerta, no setor dado. */
function plant(c: Cast, sector: Sector, start: Start = {}): Promise<string> {
  return newPendency(db, {
    dispatchId: c.dispatchId,
    sectorId: sector.id,
    sectorName: sector.name,
    ...start,
  });
}

async function seedFor(
  c: Cast,
  sector: Sector,
  route: Route,
  who: string,
): Promise<Call> {
  const r = await plant(c, sector, route.start(who));
  if (route.manual) {
    await db.prisma.teamWhatsappRecipient.update({
      where: { id: r },
      data: { ackKind: 'MANUAL', ackByUserId: who, ackNote: NOTE },
    });
  }
  return { who, d: c.dispatchId, r };
}

/** `ok` ou `status code` da recusa; erro que não é de domínio aparece inteiro. */
async function outcomeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    if (!(error instanceof DomainError)) return String(error);
    return `${error.status} ${error.code}`;
  }
}

/** A rota recusa com `expected` e a pendência, as anotações e a trilha ficam como estavam. */
async function expectRefusedUntouched(
  route: Route,
  call: Call,
  expected: string,
): Promise<void> {
  const { snapshot } = readers(db);
  const before = await snapshot(call.r);
  expect(await outcomeOf(route.call(call))).toBe(expected);
  expect(await snapshot(call.r)).toEqual(before);
}

describe('alcance das rotas — cobertura da tabela (aceite 12)', () => {
  // Rota nova no controller sem linha na tabela escaparia da prova do alcance.
  it('aceite 12: a tabela tem uma linha por rota do TeamPendencyController', () => {
    const routes = Object.getOwnPropertyNames(
      TeamPendencyController.prototype,
    ).filter((name) => name !== 'constructor');
    const covered = [...LIST_ROUTES, ...ID_ROUTES].map(({ name }) => name);
    expect(covered).toEqual(expect.arrayContaining(routes));
  });
});

describe.skipIf(!ENABLED)(
  'alcance das rotas — recusas (Anti-objetivo 1)',
  () => {
    // Pega rota nova sem `requireVisiblePendency` (ou sem `requireAckVisible`):
    // ela responderia 200, 403 ou 409 em vez do 404, ou gravaria algo.
    it.each(ID_ROUTES)(
      'aceite 12: fora do alcance — 404 em $name',
      async (route) => {
        const c = await newCast();
        const call = await seedFor(c, c.s2, route, c.manager);
        await expectRefusedUntouched(route, call, route.missing);
      },
    );

    it.each([...LIST_ROUTES, ...ID_ROUTES])(
      'aceite 12: quem não é remetente — 403 em $name',
      async (route) => {
        const c = await newCast();
        const call = await seedFor(c, c.s1, route, c.outsider);
        await expectRefusedUntouched(route, call, FORBIDDEN);
      },
    );
  },
);

describe.skipIf(!ENABLED)(
  'alcance das rotas — quem alcança (aceite 12)',
  () => {
    // Controle positivo: o 404 acima é do setor, não do estado de partida.
    it.each(ID_ROUTES)(
      'aceite 12: a mesma pendência no setor gerido — $name passa',
      async (route) => {
        const c = await newCast();
        const call = await seedFor(c, c.s1, route, c.manager);
        expect(await outcomeOf(route.call(call))).toBe('ok');
      },
    );

    it.each(ID_ROUTES)(
      'aceite 12: ADMIN alcança $name em pendência de qualquer setor',
      async (route) => {
        const c = await newCast();
        const call = await seedFor(c, c.s2, route, db.ids.admin);
        expect(await outcomeOf(route.call(call))).toBe('ok');
      },
    );
  },
);

describe.skipIf(!ENABLED)(
  'alcance das rotas — lista e contador (aceite 12)',
  () => {
    const listOf = (who: string, raw: Record<string, string> = {}) =>
      pendencies.list(who, pendencyListQuerySchema.parse(raw), NOW);

    it('aceite 12: lista e contador não trazem a pendência fora do alcance', async () => {
      const c = await newCast();
      const inside = await plant(c, c.s1);
      const outside = await plant(c, c.s2);
      const list = await listOf(c.manager);
      expect(list.items.map(({ id }) => id)).toEqual([inside]);
      expect(list.total).toBe(1);
      // Nem a pendência, nem o setor de fora (opções do filtro) vazam.
      expect(list.sectors.map(({ id }) => id)).toEqual([c.s1.id]);
      expect(JSON.stringify(list)).not.toContain(outside);
      expect(await pendencies.count(c.manager, NOW)).toEqual({
        unassignedOverdue: 1,
      });
    });

    it('aceite 12: ADMIN conta e lista as pendências dos dois setores', async () => {
      const c = await newCast();
      const admin = db.ids.admin;
      const before = (await pendencies.count(admin, NOW)).unassignedOverdue;
      const inside = await plant(c, c.s1);
      const outside = await plant(c, c.s2);
      const ids = async (sector: Sector) =>
        (await listOf(admin, { sectorId: sector.id })).items.map(
          ({ id }) => id,
        );
      expect([await ids(c.s1), await ids(c.s2)]).toEqual([[inside], [outside]]);
      const after = (await pendencies.count(admin, NOW)).unassignedOverdue;
      expect(after - before).toBe(2);
    });
  },
);
