import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatRepository } from './chat.repository';
import {
  applyOwnershipChange,
  findAssigneeRef,
  findEligibleAssignee,
  listConversationHistory,
  listEligibleAssignees,
  lockConversation,
  OWNERSHIP_TX_OPTIONS,
  runOwnershipTransaction,
  type OwnershipChange,
} from './conversation-ownership.repository';
import * as ownership from './conversation-ownership.repository';
import { ConversationOwnershipService } from './conversation-ownership.service';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-ownership.repository.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let audit: AuditService;
let channelId = '';
let seq = 0;
const ids: Record<string, string> = {};

const T0 = new Date('2026-11-21T12:00:00.000Z');
const at = (minute: number) => new Date(T0.getTime() + minute * 60_000);

type UserSeed = [
  key: string,
  name: string | null,
  role: 'ADMIN' | 'OPERATOR' | 'SUPERVISOR' | 'VIEWER',
  extra: object,
];
const USERS: UserSeed[] = [
  ['admin', 'Zé Admin', 'ADMIN', {}],
  ['ana', 'Ana Atendente', 'OPERATOR', {}],
  ['bia', 'bia atendente', 'OPERATOR', {}],
  ['supervisor', 'Sara Supervisora', 'SUPERVISOR', {}],
  ['viewer', 'Vera Visualizadora', 'VIEWER', {}],
  ['inactive', 'Iara Inativa', 'OPERATOR', { isActive: false }],
  [
    'noaccess',
    'Nando Sem Acesso',
    'VIEWER',
    { hasAccess: false, email: null, password: null },
  ],
  [
    'opsemacesso',
    'Olga Operadora Sem Acesso',
    'OPERATOR',
    { hasAccess: false, email: null, password: null },
  ],
  ['semnome', null, 'OPERATOR', {}],
];

async function seedUsers(db: PrismaClient): Promise<void> {
  for (const [key, name, role, extra] of USERS) {
    const user = await db.user.create({
      data: { email: `${key}@test.local`, password: 'x', role, name, ...extra },
      select: { id: true },
    });
    ids[key] = user.id;
  }
  const channel = await db.channel.create({
    data: { name: 'Canal de teste' },
    select: { id: true },
  });
  channelId = channel.id;
}

type ConversationSeed = {
  assignedUserId?: string | null;
  resolvedAt?: Date | null;
  botPausedAt?: Date | null;
};

async function newConversation(over: ConversationSeed = {}): Promise<string> {
  seq += 1;
  const id = `conv-${seq}`;
  await prisma.conversation.create({
    data: {
      id,
      instanceId: channelId,
      remoteJid: `${id}@s.whatsapp.net`,
      createdAt: T0,
      updatedAt: T0,
      lastInboundAt: T0,
      ...over,
    },
  });
  return id;
}

/** Trava a linha e aplica a mudança na mesma transação, como o serviço fará. */
function apply(
  id: string,
  over: Partial<Omit<OwnershipChange, 'conversation'>>,
): Promise<void> {
  return runOwnershipTransaction(
    prisma as unknown as PrismaService,
    async (tx) => {
      const conversation = await lockConversation(tx, id);
      await applyOwnershipChange(tx, audit, {
        conversation,
        actorId: ids.ana,
        assignedUserId: conversation.assignedUserId,
        resolved: conversation.resolvedAt !== null,
        actions: [],
        note: null,
        pauseBot: false,
        now: at(1),
        ...over,
      });
    },
  );
}

const conversationRow = (id: string) =>
  prisma.conversation.findUniqueOrThrow({ where: { id } });
const historyRows = (id: string) =>
  prisma.conversationHistoryEntry.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const auditRows = (id: string) =>
  prisma.auditEvent.findMany({
    where: { entity: 'Conversation', entityId: id },
  });

beforeAll(async () => {
  if (!ENABLED) return;
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  deployMigrations({ databaseUrl: postgres.getConnectionUri() });
  prisma = new PrismaClient({
    datasources: { db: { url: postgres.getConnectionUri() } },
  });
  audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  await seedUsers(prisma);
}, 180_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const NOTE = 'pegou o caso';

const actionsOf = async (id: string) =>
  (await historyRows(id)).map((row) => row.action);
const history = (id: string) => listConversationHistory(prisma, id);

async function expectAssignTrail(id: string, kind: string): Promise<void> {
  const [event] = await auditRows(id);
  expect(event).toMatchObject({
    action: 'conversation.assign',
    actorId: ids.ana,
    category: null,
    changes: [{ field: 'assignedUserId', before: null, after: ids.ana }],
    metadata: { assignedUserId: ids.ana, assignedBy: ids.ana, kind },
  });
  expect(JSON.stringify(event)).not.toContain(NOTE);
}

describe.skipIf(!ENABLED)('núcleo — trava e assumir', () => {
  it('lockConversation — conversa inexistente 404', async () => {
    await expect(
      runOwnershipTransaction(prisma, (tx) =>
        lockConversation(tx, 'conv-inexistente'),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'conversation.not_found' });
  });

  it('applyOwnershipChange assumir — atendente, assignedAt, botPausedAt, linha ASSUMED com de/para, AuditEvent conversation.assign com changes e sem note', async () => {
    const id = await newConversation();
    await apply(id, {
      assignedUserId: ids.ana,
      actions: ['ASSUMED'],
      note: NOTE,
      pauseBot: true,
    });
    expect(await conversationRow(id)).toMatchObject({
      assignedUserId: ids.ana,
      assignedAt: at(1),
      botPausedAt: at(1),
      resolvedAt: null,
    });
    expect((await historyRows(id))[0]).toMatchObject({
      action: 'ASSUMED',
      actorId: ids.ana,
      fromUserId: null,
      toUserId: ids.ana,
      note: NOTE,
      createdAt: at(1),
    });
    await expectAssignTrail(id, 'ASSUMED');
  });
});

describe.skipIf(!ENABLED)('núcleo — resolver e reabrir', () => {
  it('resolver — resolvedAt, sem atendente, linha RESOLVED, AuditEvent com after null, botPausedAt igual', async () => {
    const id = await newConversation({
      assignedUserId: ids.ana,
      botPausedAt: at(-5),
    });
    await apply(id, {
      assignedUserId: null,
      resolved: true,
      actions: ['RESOLVED'],
    });
    expect(await conversationRow(id)).toMatchObject({
      assignedUserId: null,
      assignedAt: null,
      resolvedAt: at(1),
      botPausedAt: at(-5),
    });
    expect((await historyRows(id))[0]).toMatchObject({
      action: 'RESOLVED',
      fromUserId: ids.ana,
      toUserId: null,
    });
    expect((await auditRows(id))[0].changes).toEqual([
      { field: 'assignedUserId', before: ids.ana, after: null },
    ]);
  });

  it('sem troca de atendente — nenhum AuditEvent', async () => {
    const id = await newConversation({ resolvedAt: at(-1) });
    await apply(id, { resolved: false, actions: ['REOPENED'] });
    expect((await conversationRow(id)).resolvedAt).toBeNull();
    expect(await actionsOf(id)).toEqual(['REOPENED']);
    expect(await auditRows(id)).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('núcleo — atomicidade e ordem', () => {
  it('falha do recordChange desfaz conversa e histórico', async () => {
    const id = await newConversation();
    vi.spyOn(audit, 'recordChange').mockRejectedValueOnce(
      new Error('falha da trilha'),
    );
    await expect(
      apply(id, {
        assignedUserId: ids.ana,
        actions: ['ASSUMED'],
        pauseBot: true,
      }),
    ).rejects.toThrow('falha da trilha');
    expect(await conversationRow(id)).toMatchObject({
      assignedUserId: null,
      assignedAt: null,
      botPausedAt: null,
    });
    expect(await historyRows(id)).toEqual([]);
  });

  it('duas ações — duas linhas na ordem', async () => {
    const id = await newConversation({ resolvedAt: at(-1) });
    await apply(id, {
      assignedUserId: ids.ana,
      resolved: false,
      actions: ['REOPENED', 'ASSUMED_ON_REPLY'],
    });
    expect(await actionsOf(id)).toEqual(['REOPENED', 'ASSUMED_ON_REPLY']);
    await apply(id, {
      assignedUserId: ids.bia,
      actions: ['TRANSFERRED'],
      now: at(2),
    });
    expect((await history(id)).items.map((item) => item.action)).toEqual([
      'TRANSFERRED',
      'ASSUMED_ON_REPLY',
      'REOPENED',
    ]);
  });
});

describe.skipIf(!ENABLED)('núcleo — destinos', () => {
  it('findEligibleAssignee — ADMIN e OPERATOR ativos com acesso; SUPERVISOR, VIEWER, inativo, sem acesso → null', async () => {
    expect(await findEligibleAssignee(prisma, ids.admin)).toEqual({
      id: ids.admin,
      name: 'Zé Admin',
    });
    expect(await findEligibleAssignee(prisma, ids.ana)).toEqual({
      id: ids.ana,
      name: 'Ana Atendente',
    });
    for (const key of ['supervisor', 'viewer', 'inactive', 'noaccess']) {
      expect(await findEligibleAssignee(prisma, ids[key])).toBeNull();
    }
    expect(await findEligibleAssignee(prisma, 'user-inexistente')).toBeNull();
  });

  it('findAssigneeRef — active é isActive e hasAccess; inexistente null', async () => {
    expect(await findAssigneeRef(prisma, ids.ana)).toEqual({
      id: ids.ana,
      name: 'Ana Atendente',
      active: true,
    });
    expect(await findAssigneeRef(prisma, ids.inactive)).toMatchObject({
      active: false,
    });
    expect(await findAssigneeRef(prisma, ids.noaccess)).toMatchObject({
      active: false,
    });
    expect(await findAssigneeRef(prisma, 'user-inexistente')).toBeNull();
  });

  it('aceite 8: listEligibleAssignees — só id e nome, ordem por nome', async () => {
    expect(await listEligibleAssignees(prisma)).toEqual([
      { id: ids.semnome, name: '' },
      { id: ids.ana, name: 'Ana Atendente' },
      { id: ids.bia, name: 'bia atendente' },
      { id: ids.admin, name: 'Zé Admin' },
    ]);
  });
});

describe.skipIf(!ENABLED)('núcleo — destinos (filtros)', () => {
  it('hasAccess é filtro próprio: OPERATOR ativo sem acesso não é destino', async () => {
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: ids.opsemacesso },
        select: { role: true, isActive: true, hasAccess: true },
      }),
    ).toEqual({ role: 'OPERATOR', isActive: true, hasAccess: false });
    expect(await findEligibleAssignee(prisma, ids.opsemacesso)).toBeNull();
    const listed = await listEligibleAssignees(prisma);
    expect(listed.map((user) => user.id)).not.toContain(ids.opsemacesso);
  });

  it('User.name nulo vira string vazia em findEligibleAssignee e listEligibleAssignees', async () => {
    const semnome = { id: ids.semnome, name: '' };
    expect(await findEligibleAssignee(prisma, ids.semnome)).toEqual(semnome);
    expect(await listEligibleAssignees(prisma)).toContainEqual(semnome);
  });
});

async function seedMixedHistory(id: string): Promise<void> {
  const base = { conversationId: id, fromUserId: null };
  await prisma.conversationHistoryEntry.createMany({
    data: [
      {
        ...base,
        action: 'ASSUMED',
        actorId: ids.ana,
        toUserId: ids.ana,
        createdAt: at(1),
      },
      {
        ...base,
        action: 'TRANSFERRED',
        actorId: ids.ana,
        fromUserId: ids.ana,
        toUserId: 'user-removido',
        createdAt: at(2),
      },
      {
        ...base,
        action: 'REOPENED',
        actorId: null,
        note: 'nova mensagem',
        createdAt: at(3),
      },
    ],
  });
}

describe.skipIf(!ENABLED)('núcleo — histórico (nomes)', () => {
  it('listConversationHistory — mais nova primeiro, nomes resolvidos, ator nulo e usuário removido com nome null', async () => {
    const id = await newConversation();
    await seedMixedHistory(id);
    const { items, hasMore } = await history(id);
    expect(hasMore).toBe(false);
    expect(items.map((item) => item.action)).toEqual([
      'REOPENED',
      'TRANSFERRED',
      'ASSUMED',
    ]);
    expect(items[0]).toMatchObject({
      actorId: null,
      actorName: null,
      note: 'nova mensagem',
      createdAt: at(3).toISOString(),
    });
    expect(items[1]).toMatchObject({
      actorName: 'Ana Atendente',
      fromUserName: 'Ana Atendente',
      toUserId: 'user-removido',
      toUserName: null,
    });
    expect(items[2]).toMatchObject({
      toUserName: 'Ana Atendente',
      fromUserName: null,
    });
  });
});

const assumedRows = (id: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    conversationId: id,
    action: 'ASSUMED' as const,
    actorId: ids.ana,
    createdAt: at(from + i),
  }));

describe.skipIf(!ENABLED)('núcleo — histórico (limite)', () => {
  it('listConversationHistory — 200 linhas: hasMore false; 201 linhas: 200 itens e hasMore true, sem a mais antiga', async () => {
    const id = await newConversation();
    await prisma.conversationHistoryEntry.createMany({
      data: assumedRows(id, 10, 210),
    });
    const exact = await history(id);
    expect(exact.items).toHaveLength(200);
    expect(exact.hasMore).toBe(false);
    await prisma.conversationHistoryEntry.createMany({
      data: assumedRows(id, 0, 1),
    });
    const more = await history(id);
    expect(more.items).toHaveLength(200);
    expect(more.hasMore).toBe(true);
    expect(more.items.at(-1)?.createdAt).toBe(at(10).toISOString());
  });
});

/** Fontes de produção (sem spec) do backend, para provar que ninguém altera o histórico. */
function productionSources(): string[] {
  const root = path.resolve(__dirname, '..', '..');
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => path.join(root, file));
}

describe('núcleo — garantias', () => {
  it('toda $transaction do núcleo usa OWNERSHIP_TX_OPTIONS', async () => {
    expect(OWNERSHIP_TX_OPTIONS).toEqual({ timeout: 10_000, maxWait: 5_000 });
    const transaction = vi.fn().mockResolvedValue('feito');
    const result = await runOwnershipTransaction(
      { $transaction: transaction } as never,
      () => Promise.resolve('x'),
    );
    expect(result).toBe('feito');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 10_000,
      maxWait: 5_000,
    });
  });

  it('histórico só de inclusão: o repositório não exporta update nem delete da tabela', () => {
    const exported = Object.keys(ownership);
    expect(
      exported.filter((name) => /update|delete|remove/i.test(name)),
    ).toEqual([]);
    const writers = productionSources().filter((file) =>
      /conversationHistoryEntry\s*\.\s*(update|delete|upsert)/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(writers).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('ConversationOwnershipService — leituras', () => {
  const service = () =>
    new ConversationOwnershipService(
      prisma as never,
      audit,
      { publish: vi.fn() } as never,
      new ChatRepository(prisma as never),
    );

  it('history — conversa inexistente 404; existente devolve itens e hasMore', async () => {
    await expect(service().history('conv-inexistente')).rejects.toMatchObject({
      status: 404,
      code: 'conversation.not_found',
    });
    const id = await newConversation();
    await apply(id, { assignedUserId: ids.ana, actions: ['ASSUMED'] });
    const page = await service().history(id);
    expect(page.hasMore).toBe(false);
    expect(page.items).toMatchObject([
      {
        action: 'ASSUMED',
        actorName: 'Ana Atendente',
        toUserName: 'Ana Atendente',
      },
    ]);
  });

  it('assignees — só ADMIN e OPERATOR ativos, id e nome', async () => {
    const { items } = await service().assignees();
    expect(items.map((item) => item.id)).toEqual([
      ids.semnome,
      ids.ana,
      ids.bia,
      ids.admin,
    ]);
    expect(Object.keys(items[0]).sort()).toEqual(['id', 'name']);
  });
});
