import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import {
  TeamWhatsappRepository,
  type NewTeamDispatch,
} from './team-whatsapp.repository';
import { NO_SNAPSHOT } from './team-whatsapp.test-fixtures';

// Lote F, T6: finalidade, base, atividade, motivo, regra e excluídos no
// repositório (DF2, DF4, GF13). Um container para o arquivo inteiro.
const PAGE = { page: 1, pageSize: 50 };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const RULE = {
  shifts: [{ id: 'shift_second', name: '2º turno' }],
  levels: [{ id: 'lv-1', name: 'Nível 1' }],
  withoutLevel: false,
  selectedUserIds: ['u-1', 'u-2'],
};
const EXCLUDED = [
  {
    userId: 'u-3',
    name: 'Caio',
    sectorId: 's-1',
    sectorName: 'Produção',
    shiftName: '2º turno',
    levelName: null,
    reason: 'day_off' as const,
  },
];
const ACTIVITY = { date: '2026-11-21', time: '14:30', place: 'Sala 2' };

/** Envio a um setor gravado direto no repositório; `extra` traz os campos do F. */
async function enviar(tag: string, extra: Partial<NewTeamDispatch> = {}) {
  const sector = await prisma.sector.create({
    data: { name: `Finalidade ${tag}`, code: `FIN${tag}` },
  });
  const author = await prisma.user.create({
    data: { email: `${tag}@test.local`, password: 'x', name: tag },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'SECTOR',
    targetId: sector.id,
    targetLabel: `Envio ${tag}`,
    ...NO_SNAPSHOT,
    channelId: null,
    text: 'oi',
    sectors: [{ sectorId: sector.id, sectorName: sector.name }],
    recipients: [],
    ...extra,
  });
  const row = await prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: created.id },
  });
  return { created, row, authorId: author.id };
}

describe('TeamWhatsappRepository — finalidade: gravação (Postgres real)', () => {
  it('grava e lê finalidade, base, atividade, motivo, regra e excluídos', async () => {
    const { created, row } = await enviar('completo', {
      purpose: 'URGENCY',
      audienceBase: 'ON_DUTY',
      activity: ACTIVITY,
      urgencyReason: 'Falta de energia',
      audienceRule: RULE,
      audienceExcluded: EXCLUDED,
      roster: null,
    });
    expect(row).toMatchObject({
      purpose: 'URGENCY',
      audienceBase: 'ON_DUTY',
      activityTime: '14:30',
      activityPlace: 'Sala 2',
      urgencyReason: 'Falta de energia',
      roster: null,
    });
    expect(row.activityDate?.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(row.audienceRule).toEqual(RULE);
    expect(row.audienceExcluded).toEqual(EXCLUDED);
    const detail = await repo.findDispatchDetail(created.id);
    expect(detail?.audienceRule).toEqual(RULE);
  }, 60_000);

  it('audienceExcluded descarta telefone e chaves fora do contrato', async () => {
    const { row } = await enviar('limpo', {
      purpose: 'MEETING',
      audienceBase: 'ASSIGNED',
      audienceRule: { ...RULE, phoneE164: '+5592991110001' } as never,
      // Telefone em runtime (tipagem estrutural deixa passar): não pode ser gravado.
      audienceExcluded: EXCLUDED.map((p) => ({
        ...p,
        phoneE164: '+5592991110001',
        extra: 'x',
      })),
    });
    expect(row.audienceExcluded).toEqual(EXCLUDED);
    expect(row.audienceRule).toEqual(RULE);
    expect(
      JSON.stringify([row.audienceRule, row.audienceExcluded]),
    ).not.toMatch(/phone|\+55|extra/i);
  }, 60_000);
});

describe('TeamWhatsappRepository — finalidade: agendado e envio antigo (Postgres real)', () => {
  it('agendado grava schedulePolicy nulo', async () => {
    const { row } = await enviar('agendado', {
      purpose: 'SHIFT_NOTICE',
      audienceBase: 'ASSIGNED',
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-11-21T18:00:00Z'),
    });
    expect(row).toMatchObject({
      state: 'SCHEDULED',
      purpose: 'SHIFT_NOTICE',
      schedulePolicy: null,
    });
  }, 60_000);

  it('envio sem os campos novos fica com tudo nulo, como antes', async () => {
    const { row } = await enviar('antigo');
    expect(row).toMatchObject({
      purpose: null,
      audienceBase: null,
      activityDate: null,
      activityTime: null,
      activityPlace: null,
      urgencyReason: null,
      audienceRule: null,
      audienceExcluded: null,
      schedulePolicy: null,
    });
  }, 60_000);
});

describe('TeamWhatsappRepository — finalidade: lista e detalhe (Postgres real)', () => {
  it('lista e detalhe devolvem as colunas novas', async () => {
    const { created, authorId } = await enviar('leitura', {
      purpose: 'LECTURE',
      audienceBase: 'ASSIGNED',
      activity: ACTIVITY,
      audienceRule: RULE,
      audienceExcluded: EXCLUDED,
    });
    const plain = {
      purpose: 'LECTURE',
      audienceBase: 'ASSIGNED',
      activityTime: '14:30',
      activityPlace: 'Sala 2',
      urgencyReason: null,
    };
    const { rows } = await repo.listDispatches(authorId, PAGE);
    const listed = rows.find((r) => r.id === created.id);
    expect(listed).toMatchObject(plain);
    expect(listed?.activityDate?.toISOString()).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    // A lista não carrega o Json da regra nem dos excluídos: só o detalhe (DF2).
    expect(listed).not.toHaveProperty('audienceExcluded');
    const detail = await repo.findDispatchDetail(created.id);
    expect(detail).toMatchObject({
      ...plain,
      audienceRule: RULE,
      audienceExcluded: EXCLUDED,
      schedulePolicy: null,
    });
    expect(detail?.activityDate?.toISOString()).toBe(
      '2026-11-21T00:00:00.000Z',
    );
  }, 60_000);
});

describe('TeamWhatsappRepository — finalidade: lista de excluídos vazia (Postgres real)', () => {
  it('audienceExcluded [] volta [] (ninguém excluído), não nulo', async () => {
    const { created, row } = await enviar('vazio', {
      purpose: 'ALIGNMENT',
      audienceBase: 'ASSIGNED',
      audienceRule: RULE,
      audienceExcluded: [],
    });
    expect(row.audienceExcluded).toEqual([]);
    const detail = await repo.findDispatchDetail(created.id);
    expect(detail?.audienceExcluded).toEqual([]);
  }, 60_000);
});
