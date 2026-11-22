import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  PrismaClient,
  type MessageStatus,
  type TeamWhatsappRecipientStatus,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ChatService } from '../chat/chat.service';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamStuckRecipientsRepository } from './team-stuck-recipients.repository';
import {
  QUEUE_LOST_CODE,
  STUCK_CODE,
  stuckOutcome,
  type StuckCandidate,
} from './stuck-recipients';

// Verificador de presos (H2/DH7) contra Postgres real: a troca condicional
// decide sozinha contra o processor, o chat e o "Repetir". `now` é explícito
// e o `updatedAt` das linhas é gravado por SQL cru (o @updatedAt sobrescreve).
const NOW = new Date('2026-11-20T12:00:00-04:00');

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
// ChatService REAL, sem dublê: o claim e a regra de reenvio só usam o prisma.
let chat: ChatService;
const redispatchable = (code: string | null) =>
  chat.isRedispatchableFailure(code);
let stuck: TeamStuckRecipientsRepository;
let repo: TeamWhatsappRepository;
let dispatchId: string;
let channelId: string;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  stuck = new TeamStuckRecipientsRepository(prisma as never);
  chat = new ChatService(
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
  );
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  const channel = await prisma.channel.create({
    data: { name: 'Canal equipe', provider: 'EVOLUTION', apiKey: '' },
  });
  channelId = channel.id;
  const dispatch = await prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'setor-presos',
      targetLabel: 'Logística',
      text: 'Reunião às 9h',
    },
  });
  dispatchId = dispatch.id;
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

let seq = 0;

/** Grava o `updatedAt` da linha `minutes` antes de `now`. */
const age = (id: string, minutes: number, now = NOW) =>
  prisma.$executeRaw`UPDATE "TeamWhatsappRecipient" SET "updatedAt" = ${new Date(now.getTime() - minutes * 60_000)} WHERE "id" = ${id}`;

type SeedOpts = {
  status?: TeamWhatsappRecipientStatus;
  messageId?: string | null;
  manualRetries?: number;
  minutes?: number;
  now?: Date;
};

/** Destinatário `QUEUED` parado há 31 min (por padrão), com 2 tentativas. */
async function seedRecipient(opts: SeedOpts = {}): Promise<string> {
  const { id } = await prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId,
      userName: `Pessoa ${++seq}`,
      phoneE164: '+5592991110001',
      status: opts.status ?? 'QUEUED',
      messageId: opts.messageId ?? null,
      manualRetries: opts.manualRetries ?? 0,
      attempts: 2,
    },
    select: { id: true },
  });
  await age(id, opts.minutes ?? 31, opts.now);
  return id;
}

async function makeMessage(
  status: MessageStatus,
  extra: { errorCode?: string; sentAt?: Date } = {},
): Promise<string> {
  const { id } = await prisma.message.create({
    data: { instanceId: channelId, status, direction: 'OUTBOUND', ...extra },
    select: { id: true },
  });
  return id;
}

async function readCandidate(id: string): Promise<StuckCandidate> {
  const found = (await stuck.findCandidates(NOW)).find((c) => c.id === id);
  if (!found) throw new Error(`candidato ${id} não lido`);
  return found;
}

/** Lê o preso e classifica pela Message, como o verificador fará. */
async function readAndClassify(id: string) {
  const candidate = await readCandidate(id);
  const message = candidate.messageId
    ? await stuck.loadMessage(candidate.messageId)
    : null;
  const outcome = stuckOutcome({
    messageId: candidate.messageId,
    message,
    now: NOW,
    redispatchable,
  });
  return { candidate, outcome };
}

const rowOf = (id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      errorCode: true,
      messageId: true,
      attempts: true,
      manualRetries: true,
      acceptedAt: true,
      updatedAt: true,
    },
  });

const messageOf = (id: string) =>
  prisma.message.findUniqueOrThrow({
    where: { id },
    select: { status: true, errorCode: true, failedAt: true, sentAt: true },
  });

type ChatClaim = { claimTeamMessage(messageId: string): Promise<void> };

/**
 * Claim REAL do chat (`claimTeamMessage`, privado no ChatService): QUEUED ou
 * FAILED → SENDING. `true` = pegou; senão, o código do erro (ConflictError).
 */
const chatClaims = (messageId: string) =>
  (chat as unknown as ChatClaim).claimTeamMessage(messageId).then(
    () => true,
    (err: Error & { code?: string }) => err.code ?? err.message,
  );

describe('findCandidates', () => {
  it('findCandidates: só QUEUED com updatedAt antes de now − 30 min, em ordem, até o lote', async () => {
    // Relógio próprio (2020) para não enxergar linhas dos outros testes.
    const now = new Date('2020-01-01T12:00:00-04:00');
    const oldest = await seedRecipient({ minutes: 40, now });
    const tieA = await seedRecipient({ minutes: 31, now });
    const tieB = await seedRecipient({ minutes: 31, now });
    await seedRecipient({ minutes: 29, now });
    await seedRecipient({ status: 'SCHEDULED', minutes: 120, now });
    await seedRecipient({ status: 'FAILED', minutes: 120, now });

    const ties = [tieA, tieB].sort((a, b) => (a < b ? -1 : 1));
    const all = await stuck.findCandidates(now);
    expect(all.map((c) => c.id)).toEqual([oldest, ...ties]);
    expect(all[0]).toEqual({
      id: oldest,
      dispatchId,
      messageId: null,
      manualRetries: 0,
    });
    const batch = await stuck.findCandidates(now, 2);
    expect(batch.map((c) => c.id)).toEqual([oldest, ties[0]]);
  });
});

describe('settle — desfecho gravado (aceites 3 e 21)', () => {
  it('aceite 3: sem mensagem — FAILED queue_lost', async () => {
    const id = await seedRecipient();
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'FAILED',
      errorCode: QUEUE_LOST_CODE,
    });
    // Repetível: o "Repetir" devolve a linha à fila.
    expect(await repo.requeueFailed(dispatchId, [id])).toEqual([
      { id, manualRetries: 1 },
    ]);
  });

  it('aceite 21: Message QUEUED — destinatário FAILED queue_lost e Message FAILED queue_lost na mesma transação', async () => {
    const messageId = await makeMessage('QUEUED');
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'FAILED',
      errorCode: QUEUE_LOST_CODE,
      messageId,
    });
    expect(await messageOf(messageId)).toMatchObject({
      status: 'FAILED',
      errorCode: QUEUE_LOST_CODE,
      failedAt: NOW,
    });
  });
});

describe('settle — Message que já saiu da fila', () => {
  it('Message aceita — SENT com acceptedAt da Message', async () => {
    const sentAt = new Date('2026-11-20T11:05:00-04:00');
    const messageId = await makeMessage('DELIVERED', { sentAt });
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'SENT',
      acceptedAt: sentAt,
    });
    expect((await messageOf(messageId)).status).toBe('DELIVERED');
  });

  it('Message SENDING — UNCERTAIN stuck', async () => {
    const messageId = await makeMessage('SENDING');
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: STUCK_CODE,
    });
    expect((await messageOf(messageId)).status).toBe('SENDING');
  });

  it('aceite 21: Message FAILED reenviável — FAILED com o código dela; requeueFailed a pega', async () => {
    const errorCode = 'evolution.disconnected';
    const messageId = await makeMessage('FAILED', { errorCode });
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({ status: 'FAILED', errorCode });
    expect(await repo.requeueFailed(dispatchId, [id])).toEqual([
      { id, manualRetries: 1 },
    ]);
  });
});

describe('settle — quem mexe entre a leitura e a troca vence', () => {
  it('aceite 3: Repetir entre a leitura e a troca vence', async () => {
    const id = await seedRecipient();
    const { candidate, outcome } = await readAndClassify(id);
    await prisma.teamWhatsappRecipient.update({
      where: { id },
      data: { status: 'FAILED', errorCode: 'evolution.disconnected' },
    });
    expect(await repo.requeueFailed(dispatchId, [id])).toEqual([
      { id, manualRetries: 1 },
    ]);
    // A linha volta a parecer parada: só o manualRetries lido a protege.
    await age(id, 31);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(false);
    expect(await rowOf(id)).toMatchObject({
      status: 'QUEUED',
      errorCode: null,
      manualRetries: 1,
    });
  });

  it('processor que termina entre a leitura e a troca vence', async () => {
    const messageId = await makeMessage('QUEUED');
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    const sentAt = new Date('2026-11-20T11:50:00-04:00');
    await prisma.message.update({
      where: { id: messageId },
      data: { status: 'SENT', sentAt },
    });
    await prisma.teamWhatsappRecipient.update({
      where: { id },
      data: { status: 'SENT', acceptedAt: sentAt },
    });
    await age(id, 31);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(false);
    expect(await rowOf(id)).toMatchObject({ status: 'SENT', errorCode: null });
    expect(await messageOf(messageId)).toMatchObject({
      status: 'SENT',
      sentAt,
    });
  });
});

describe('settle — Message gravada ou trocada depois da leitura', () => {
  it('messageId gravado depois da leitura vence', async () => {
    const id = await seedRecipient();
    const { candidate, outcome } = await readAndClassify(id);
    const messageId = await makeMessage('QUEUED');
    await prisma.teamWhatsappRecipient.update({
      where: { id },
      data: { messageId },
    });
    await age(id, 31);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(false);
    expect(await rowOf(id)).toMatchObject({ status: 'QUEUED', messageId });
    expect((await messageOf(messageId)).status).toBe('QUEUED');
  });

  it('chat pega a Message depois da leitura e antes da troca: settle devolve false e o destinatário segue QUEUED intacto', async () => {
    const messageId = await makeMessage('QUEUED');
    const id = await seedRecipient({ messageId });
    const before = await rowOf(id);
    const { candidate, outcome } = await readAndClassify(id);
    expect(await chatClaims(messageId)).toBe(true);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(false);
    expect(await rowOf(id)).toEqual(before);
    expect(await messageOf(messageId)).toMatchObject({
      status: 'SENDING',
      errorCode: null,
      failedAt: null,
    });
  });
});

describe('settle — chamadas ao mesmo tempo', () => {
  it('dois verificadores ao mesmo tempo: só um troca', async () => {
    const messageId = await makeMessage('QUEUED');
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    const results = await Promise.all([
      stuck.settle(candidate, outcome, NOW),
      stuck.settle(candidate, outcome, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('FAILED');
    expect(await messageOf(messageId)).toMatchObject({
      status: 'FAILED',
      errorCode: QUEUE_LOST_CODE,
    });
  });
});

/** O chat pega a Message ao mesmo tempo que a troca (corrida real). */
async function settleWhileChatClaims(messageId: string, id: string) {
  const { candidate, outcome } = await readAndClassify(id);
  const [won, claimed] = await Promise.all([
    stuck.settle(candidate, outcome, NOW),
    chatClaims(messageId),
  ]);
  const [row, message] = await Promise.all([rowOf(id), messageOf(messageId)]);
  return { won, claimed, recipient: row.status, message: message.status };
}

// O banco só garante a ordem "chat antes" (o "chat pega a Message depois da
// leitura e antes da troca", acima: a troca desfaz tudo).
// Na ordem "troca antes", o chat (QUEUED ou FAILED → SENDING) ainda pega a
// Message FAILED queue_lost: quem impede o envio é a checagem de job vivo do
// verificador imediatamente antes de cada troca (DH5, Task 5), não a troca.
describe('settle × claim real do chat (o que o banco NÃO impede)', () => {
  it('troca antes, chat depois: destinatário FAILED queue_lost com Message SENDING é possível no banco (proteção = DH5, Task 5)', async () => {
    const messageId = await makeMessage('QUEUED');
    const id = await seedRecipient({ messageId });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await chatClaims(messageId)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'FAILED',
      errorCode: QUEUE_LOST_CODE,
    });
    expect(await messageOf(messageId)).toMatchObject({
      status: 'SENDING',
      errorCode: null,
      failedAt: null,
    });
  });

  it('corrida real troca × chat: só os dois desfechos que o banco permite', async () => {
    const pairs = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const messageId = await makeMessage('QUEUED');
        return { messageId, id: await seedRecipient({ messageId }) };
      }),
    );
    const results = await Promise.all(
      pairs.map((p) => settleWhileChatClaims(p.messageId, p.id)),
    );
    const allowed = [
      // chat antes: a troca desfaz tudo e o destinatário segue QUEUED
      { won: false, claimed: true, recipient: 'QUEUED', message: 'SENDING' },
      // troca antes: o chat ainda pega a FAILED queue_lost (só o DH5 protege)
      { won: true, claimed: true, recipient: 'FAILED', message: 'SENDING' },
    ];
    for (const result of results) expect(allowed).toContainEqual(result);
  });
});

describe('settle — colunas preservadas e renovadas', () => {
  it('settle não muda attempts nem manualRetries', async () => {
    const messageId = await makeMessage('SENDING');
    const id = await seedRecipient({ messageId, manualRetries: 3 });
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: 'UNCERTAIN',
      attempts: 2,
      manualRetries: 3,
    });
  });

  it('settle renova updatedAt', async () => {
    const id = await seedRecipient({ minutes: 31 });
    const before = (await rowOf(id)).updatedAt;
    const { candidate, outcome } = await readAndClassify(id);
    expect(await stuck.settle(candidate, outcome, NOW)).toBe(true);
    const after = (await rowOf(id)).updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(after).toEqual(NOW);
  });
});
