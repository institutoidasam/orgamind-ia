import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type TeamWhatsappRecipientStatus } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../../test/migrations';
import { TeamRecipientTrackingService } from './team-recipient-tracking.service';

const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

const T1 = new Date('2026-11-10T12:00:00Z');
const T2 = new Date('2026-11-10T13:00:00Z');
const AFTER_T2 = new Date('2026-11-10T14:00:00Z');
const LATER = new Date('2026-11-10T15:00:00Z');
const RECEIPT_AT = new Date('2026-11-10T12:30:00Z');

type ReceiptStatus = 'DELIVERED' | 'READ';
type ReplyInput = Parameters<TeamRecipientTrackingService['applyReply']>[0];
type SeedOptions = {
  status?: TeamWhatsappRecipientStatus;
  messageId?: string;
  contactId?: string;
  acceptedAt?: Date | null;
};

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let svc: TeamRecipientTrackingService;
let seq = 0;

async function seedRecipient(opts: SeedOptions = {}): Promise<string> {
  seq += 1;
  const row = await prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId: 'd-1',
      userName: `Pessoa ${seq}`,
      status: opts.status ?? 'SENT',
      messageId: opts.messageId ?? `m-${seq}`,
      channelId: 'ch-x',
      contactId: opts.contactId ?? 'c-1',
      acceptedAt: opts.acceptedAt === undefined ? T1 : opts.acceptedAt,
    },
    select: { id: true },
  });
  return row.id;
}

const read = (id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      acceptedAt: true,
      deliveredAt: true,
      readAt: true,
      repliedAt: true,
    },
  });

const receipt = (messageId: string, status: ReceiptStatus) =>
  svc.applyReceipt({ messageId, status, occurredAt: RECEIPT_AT });

const reply = (over: Partial<ReplyInput> = {}) =>
  svc.applyReply({
    channelId: 'ch-x',
    contactIds: ['c-1'],
    receivedAt: AFTER_T2,
    ...over,
  });

beforeAll(async () => {
  if (!ENABLED) return;
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  svc = new TeamRecipientTrackingService(prisma as never);
  await prisma.channel.createMany({
    data: [
      { id: 'ch-x', name: 'Número X' },
      { id: 'ch-y', name: 'Número Y' },
    ],
  });
  await prisma.teamWhatsappDispatch.create({
    data: {
      id: 'd-1',
      targetType: 'SECTOR',
      targetId: 's-1',
      targetLabel: 'Produção',
      text: 'oi',
    },
  });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

type NoReplyCase = {
  name: string;
  seed: SeedOptions;
  input: Partial<ReplyInput>;
};
// Respostas que não marcam ninguém: outro número, antes do aceite, destinatário
// que o WhatsApp não aceitou (falhou ou incerto) e mensagem sem contato.
const NO_REPLY_CASES: NoReplyCase[] = [
  {
    name: 'resposta para o número Y',
    seed: {},
    input: { channelId: 'ch-y' },
  },
  {
    name: 'resposta antes do acceptedAt',
    seed: { acceptedAt: T2 },
    input: { receivedAt: T1 },
  },
  { name: 'destinatário FAILED', seed: { status: 'FAILED' }, input: {} },
  {
    name: 'destinatário UNCERTAIN',
    seed: { status: 'UNCERTAIN' },
    input: {},
  },
  { name: 'sem contactIds', seed: {}, input: { contactIds: [] } },
];

describe.skipIf(!ENABLED)('recibos', () => {
  // `at` é o acceptedAt do destinatário (null = o processor ainda não gravou).
  it.each([
    { from: 'SENT', at: T1, event: 'DELIVERED', to: 'DELIVERED', count: 1 },
    { from: 'QUEUED', at: null, event: 'DELIVERED', to: 'DELIVERED', count: 1 },
    { from: 'UNCERTAIN', at: null, event: 'READ', to: 'READ', count: 1 },
    { from: 'FAILED', at: T1, event: 'DELIVERED', to: 'FAILED', count: 0 },
    { from: 'REPLIED', at: T1, event: 'READ', to: 'REPLIED', count: 0 },
    { from: 'SKIPPED', at: null, event: 'READ', to: 'SKIPPED', count: 0 },
    { from: 'CANCELLED', at: T1, event: 'READ', to: 'CANCELLED', count: 0 },
  ] as const)('$from + $event → $to', async (c) => {
    const messageId = `m-${c.from}-${c.event}`;
    const id = await seedRecipient({
      status: c.from,
      acceptedAt: c.at,
      messageId,
    });
    await expect(receipt(messageId, c.event)).resolves.toBe(c.count);
    const row = await read(id);
    expect(row.status).toBe(c.to);
    const stamp = c.event === 'DELIVERED' ? row.deliveredAt : row.readAt;
    expect(stamp).toEqual(c.count === 1 ? RECEIPT_AT : null);
    // R4: recibo antes do aceite fixa o acceptedAt com a hora do recibo.
    expect(row.acceptedAt).toEqual(c.at ?? (c.count === 1 ? RECEIPT_AT : null));
  });

  it('recibo repetido ou fora de ordem não rebaixa (lido não volta a entregue)', async () => {
    const id = await seedRecipient({ messageId: 'm-order' });
    const counts = [
      await receipt('m-order', 'DELIVERED'),
      await receipt('m-order', 'DELIVERED'),
      await receipt('m-order', 'READ'),
      await receipt('m-order', 'DELIVERED'),
      await receipt('m-order', 'READ'),
    ];
    expect(counts).toEqual([1, 0, 1, 0, 0]);
    await expect(read(id)).resolves.toMatchObject({
      status: 'READ',
      deliveredAt: RECEIPT_AT,
      readAt: RECEIPT_AT,
    });
  });

  it('mensagem sem destinatário → count 0', async () => {
    await expect(receipt('m-nobody', 'READ')).resolves.toBe(0);
  });
});

describe.skipIf(!ENABLED)('respondeu', () => {
  beforeEach(async () => {
    await prisma.teamWhatsappRecipient.deleteMany({});
  });

  it('dois envios do número X (T1 < T2) → só o de T2 vira REPLIED; a segunda resposta não muda nada', async () => {
    const old = await seedRecipient({ acceptedAt: T1 });
    const recent = await seedRecipient({ status: 'READ', acceptedAt: T2 });
    await expect(reply()).resolves.toBe(recent);
    await expect(reply({ receivedAt: LATER })).resolves.toBeNull();
    await expect(read(recent)).resolves.toMatchObject({
      status: 'REPLIED',
      repliedAt: AFTER_T2,
    });
    await expect(read(old)).resolves.toMatchObject({
      status: 'SENT',
      repliedAt: null,
    });
  });

  it('contato gêmeo (9º dígito) em contactIds → marca', async () => {
    const id = await seedRecipient({ contactId: 'c-twin' });
    await expect(reply({ contactIds: ['c-1', 'c-twin'] })).resolves.toBe(id);
    await expect(read(id)).resolves.toMatchObject({ status: 'REPLIED' });
  });

  it.each(NO_REPLY_CASES)('$name → nada muda', async ({ seed, input }) => {
    const id = await seedRecipient(seed);
    await expect(reply(input)).resolves.toBeNull();
    await expect(read(id)).resolves.toMatchObject({
      status: seed.status ?? 'SENT',
      repliedAt: null,
    });
  });
});
