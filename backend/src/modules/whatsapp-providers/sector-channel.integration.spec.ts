import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type ChannelProvider } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { SectorChannelService } from './sector-channel.service';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: SectorChannelService;
const audit = { log: vi.fn().mockResolvedValue(undefined) };

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  service = new SectorChannelService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

async function makeSector(
  name: string,
  over: { isActive?: boolean; channelId?: string } = {},
) {
  return prisma.sector.create({
    data: { name, code: randomUUID().slice(0, 8), ...over },
  });
}

async function makeChannel(
  provider: ChannelProvider = 'GOZAP',
  over: { isActive?: boolean; name?: string } = {},
) {
  return prisma.channel.create({
    data: {
      name: over.name ?? `Número ${randomUUID().slice(0, 6)}`,
      provider,
      isActive: over.isActive ?? true,
      apiKey: '',
      gozapInstanceId: provider === 'GOZAP' ? randomUUID() : undefined,
      evolutionInstanceName:
        provider === 'EVOLUTION' ? randomUUID() : undefined,
      phoneE164: provider === 'TWILIO' ? '+15550001111' : undefined,
    },
  });
}

const channelOf = async (sectorId: string) =>
  (await prisma.sector.findUniqueOrThrow({ where: { id: sectorId } }))
    .channelId;

describe('associar áreas ao número (Postgres real)', () => {
  it('Logística e Expedição passam ao número X, e a auditoria leva só ids', async () => {
    const x = await makeChannel();
    const logistica = await makeSector('Logística A');
    const expedicao = await makeSector('Expedição A');

    const result = await service.assign({
      channelId: x.id,
      sectorIds: [logistica.id, expedicao.id, logistica.id],
      actorId: 'admin-1',
    });

    expect(result).toEqual({
      channelId: x.id,
      sectors: [
        { id: expedicao.id, name: 'Expedição A' },
        { id: logistica.id, name: 'Logística A' },
      ],
      moved: [],
    });
    expect(await channelOf(logistica.id)).toBe(x.id);
    expect(audit.log).toHaveBeenCalledWith(
      'channel.sectors_update',
      'Channel',
      x.id,
      expect.objectContaining({ channelId: x.id, moved: [] }),
    );
  });
});

// Continuação do grupo acima (dividido só pelo limite de linhas por função).
describe('associar áreas ao número (Postgres real)', () => {
  it('Expedição estava em Y: sai de Y (que mantém as outras) e vem em moved', async () => {
    const [x, y] = [await makeChannel(), await makeChannel('EVOLUTION')];
    const expedicao = await makeSector('Expedição B', { channelId: y.id });
    const compras = await makeSector('Compras B', { channelId: y.id });

    const result = await service.assign({
      channelId: x.id,
      sectorIds: [expedicao.id],
      actorId: 'admin-1',
    });

    expect(result.moved).toEqual([
      { sectorId: expedicao.id, fromChannelId: y.id },
    ]);
    expect(await channelOf(expedicao.id)).toBe(x.id);
    expect(await channelOf(compras.id)).toBe(y.id);
  });

  it('RH estava em X e não veio na lista: fica sem número; lista vazia tira todas', async () => {
    const x = await makeChannel();
    const rh = await makeSector('RH C', { channelId: x.id });
    const logistica = await makeSector('Logística C', { channelId: x.id });

    await service.assign({
      channelId: x.id,
      sectorIds: [logistica.id],
      actorId: 'a',
    });
    expect(await channelOf(rh.id)).toBeNull();
    expect(await channelOf(logistica.id)).toBe(x.id);

    const empty = await service.assign({
      channelId: x.id,
      sectorIds: [],
      actorId: 'a',
    });
    expect(empty).toEqual({ channelId: x.id, sectors: [], moved: [] });
    expect(await channelOf(logistica.id)).toBeNull();
  });
});

/**
 * Atrasa, dentro da transação, o fim da limpeza das áreas que saem do número
 * (o `updateMany` que zera `channelId`). Sem trava no canal, as duas `assign`
 * fazem a limpeza antes de qualquer uma gravar (cada uma enxerga o canal sem
 * áreas) e depois as duas gravam; com a trava, a segunda só começa quando a
 * primeira termina. Torna a corrida determinística em vez de depender de sorte.
 */
function withSlowClearing(client: PrismaClient, ms: number): PrismaService {
  const slowSector = (sector: PrismaClient['sector']) =>
    new Proxy(sector, {
      get(target, prop) {
        if (prop !== 'updateMany') return Reflect.get(target, prop) as unknown;
        return async (args: Parameters<typeof target.updateMany>[0]) => {
          const done = await target.updateMany(args);
          if (args?.data?.channelId === null) {
            await new Promise((resolve) => setTimeout(resolve, ms));
          }
          return done;
        };
      },
    });
  return {
    $transaction: (fn: (tx: PrismaClient) => Promise<unknown>) =>
      client.$transaction((tx) =>
        fn(
          new Proxy(tx as unknown as PrismaClient, {
            get: (target, prop): unknown =>
              prop === 'sector'
                ? slowSector(target.sector)
                : (Reflect.get(target, prop) as unknown),
          }),
        ),
      ),
  } as unknown as PrismaService;
}

describe('duas associações ao mesmo número ao mesmo tempo', () => {
  it('o estado final é exatamente uma das duas listas, nunca a união', async () => {
    const x = await makeChannel();
    const s1 = await makeSector('Logística F');
    const s2 = await makeSector('Expedição F');
    const racing = new SectorChannelService(
      withSlowClearing(prisma, 300),
      audit as unknown as AuditService,
    );

    await Promise.all([
      racing.assign({ channelId: x.id, sectorIds: [s1.id], actorId: 'a' }),
      racing.assign({ channelId: x.id, sectorIds: [s2.id], actorId: 'b' }),
    ]);

    const holders = await prisma.sector.findMany({
      where: { channelId: x.id },
      select: { id: true },
    });
    expect(holders).toHaveLength(1);
    expect([s1.id, s2.id]).toContain(holders[0].id);
  });
});

describe('recusas (nada muda)', () => {
  it.each([
    ['TWILIO', 'TWILIO', true],
    ['GOZAP inativo', 'GOZAP', false],
    ['EVOLUTION inativo', 'EVOLUTION', false],
  ] as const)(
    'canal %s: 422 channel.sectors_not_team',
    async (_label, provider, isActive) => {
      const channel = await makeChannel(provider, { isActive });
      const sector = await makeSector(`Setor ${_label}`);

      await expect(
        service.assign({
          channelId: channel.id,
          sectorIds: [sector.id],
          actorId: 'a',
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'channel.sectors_not_team',
      });
      expect(await channelOf(sector.id)).toBeNull();
    },
  );

  it('canal inexistente: 404', async () => {
    await expect(
      service.assign({ channelId: 'nao-existe', sectorIds: [], actorId: 'a' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// Continuação do grupo acima (dividido só pelo limite de linhas por função).
describe('recusas (nada muda)', () => {
  it.each([
    [
      'inativo',
      async () => (await makeSector('Inativo D', { isActive: false })).id,
    ],
    ['inexistente', () => Promise.resolve('setor-que-nao-existe')],
  ])(
    'setor %s: 422 channel.sector_invalid, sem mover os válidos',
    async (_label, bad) => {
      const x = await makeChannel();
      const y = await makeChannel();
      const onX = await makeSector(`Fica em X ${_label}`, { channelId: x.id });
      const onY = await makeSector(`Vem de Y ${_label}`, { channelId: y.id });
      const badId = await bad();

      await expect(
        service.assign({
          channelId: x.id,
          sectorIds: [onY.id, badId],
          actorId: 'a',
        }),
      ).rejects.toMatchObject({ status: 422, code: 'channel.sector_invalid' });
      await expect(
        service.assertAssignable([onY.id, badId]),
      ).rejects.toMatchObject({
        code: 'channel.sector_invalid',
      });
      expect(await channelOf(onX.id)).toBe(x.id);
      expect(await channelOf(onY.id)).toBe(y.id);
    },
  );
});

describe('leituras', () => {
  it('assertAssignable devolve os ids únicos; sectorsByChannel lista só as ativas, por nome', async () => {
    const x = await makeChannel();
    const vazio = await makeChannel();
    const zeta = await makeSector('Zeta E', { channelId: x.id });
    const alfa = await makeSector('Alfa E', { channelId: x.id });
    await makeSector('Inativa E', { channelId: x.id, isActive: false });

    expect(await service.assertAssignable([zeta.id, zeta.id, alfa.id])).toEqual(
      [zeta.id, alfa.id],
    );
    expect(await service.assertAssignable([])).toEqual([]);
    expect(await service.sectorsByChannel([x.id, vazio.id])).toEqual(
      new Map([
        [
          x.id,
          [
            { id: alfa.id, name: 'Alfa E' },
            { id: zeta.id, name: 'Zeta E' },
          ],
        ],
        [vazio.id, []],
      ]),
    );
  });
});
