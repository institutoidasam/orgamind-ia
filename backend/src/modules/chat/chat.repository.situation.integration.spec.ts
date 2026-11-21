import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type { ListConversationsQuery } from '../../schemas/contracts/chat.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatRepository } from './chat.repository';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/chat.repository.situation.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: ChatRepository;

const SINCE = new Date('2026-11-20T12:00:00.000Z');
const RESOLVED_AT = new Date('2026-11-21T09:00:00.000Z');

type Seed = {
  id: string;
  waName: string;
  minute: number;
  direction: 'INBOUND' | 'OUTBOUND';
  assigned?: boolean;
  resolved?: boolean;
  archived?: boolean;
};

// Seis conversas: duas abertas (Pendente e Em atendimento), duas resolvidas
// (uma aguardando resposta) e duas arquivadas (uma aberta, uma resolvida).
const SEEDS: Seed[] = [
  {
    id: 'c-pending',
    waName: 'Cliente Pendente',
    minute: 6,
    direction: 'INBOUND',
  },
  {
    id: 'c-progress',
    waName: 'Cliente Andamento',
    minute: 5,
    direction: 'OUTBOUND',
    assigned: true,
  },
  {
    id: 'c-resolved-alfa',
    waName: 'Cliente Resolvido Alfa',
    minute: 4,
    direction: 'INBOUND',
    resolved: true,
  },
  {
    id: 'c-resolved-beta',
    waName: 'Cliente Resolvido Beta',
    minute: 3,
    direction: 'OUTBOUND',
    resolved: true,
  },
  {
    id: 'c-archived-open',
    waName: 'Cliente Arquivado Aberto',
    minute: 2,
    direction: 'INBOUND',
    archived: true,
  },
  {
    id: 'c-archived-resolved',
    waName: 'Cliente Arquivado Resolvido',
    minute: 1,
    direction: 'INBOUND',
    archived: true,
    resolved: true,
  },
];

async function seedConversations(db: PrismaClient): Promise<void> {
  const agent = await db.user.create({
    data: {
      email: 'atendente-a@test.local',
      password: 'x',
      role: 'OPERATOR',
      name: 'Atendente A',
    },
    select: { id: true },
  });
  const channel = await db.channel.create({
    data: { name: 'Canal de teste' },
    select: { id: true },
  });
  for (const seed of SEEDS) {
    const at = new Date(SINCE.getTime() + seed.minute * 60_000);
    await db.conversation.create({
      data: {
        id: seed.id,
        instanceId: channel.id,
        remoteJid: `${seed.id}@s.whatsapp.net`,
        waName: seed.waName,
        lastMessageAt: at,
        lastMessageDirection: seed.direction,
        createdAt: SINCE,
        updatedAt: SINCE,
        assignedUserId: seed.assigned ? agent.id : null,
        resolvedAt: seed.resolved ? RESOLVED_AT : null,
        archivedAt: seed.archived ? RESOLVED_AT : null,
      },
    });
  }
}

function list(over: Partial<ListConversationsQuery> = {}) {
  const query: ListConversationsQuery = {
    filter: 'all',
    status: 'open',
    page: 1,
    pageSize: 30,
    ...over,
  };
  return repo.listConversations(query).then((page) => page.items);
}

async function startSituationDb(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  deployMigrations({ databaseUrl: postgres.getConnectionUri() });
  prisma = new PrismaClient({
    datasources: { db: { url: postgres.getConnectionUri() } },
  });
  repo = new ChatRepository(prisma as unknown as PrismaService);
  await seedConversations(prisma);
}

async function stopSituationDb(): Promise<void> {
  await prisma?.$disconnect();
  await postgres?.stop();
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'ChatRepository.listConversations situação (integração)',
  () => {
    beforeAll(startSituationDb, 180_000);
    afterAll(stopSituationDb);

    it('aceite 1: lista padrão traz Pendente e Em atendimento e não traz Resolvida', async () => {
      const items = await list();
      expect(items.map((item) => [item.id, item.status])).toEqual([
        ['c-pending', 'PENDING'],
        ['c-progress', 'IN_PROGRESS'],
      ]);
      expect(items[1].assignedUserActive).toBe(true);
    });

    it('aceite 1: status=resolved traz só resolvidas', async () => {
      const items = await list({ status: 'resolved' });
      expect(items.map((item) => item.id)).toEqual([
        'c-resolved-alfa',
        'c-resolved-beta',
      ]);
      expect(items.every((item) => item.status === 'RESOLVED')).toBe(true);
      expect(items[0].resolvedAt).toBe(RESOLVED_AT.toISOString());
    });

    it('archivedAt preenchido fica fora nas duas', async () => {
      const ids = [
        ...(await list()),
        ...(await list({ status: 'resolved' })),
      ].map((item) => item.id);
      expect(ids.filter((id) => id.startsWith('c-archived'))).toEqual([]);
    });

    it('filter=awaiting e search combinam com resolved', async () => {
      const awaiting = await list({ status: 'resolved', filter: 'awaiting' });
      expect(awaiting.map((item) => item.id)).toEqual(['c-resolved-alfa']);
      const searched = await list({ status: 'resolved', search: 'beta' });
      expect(searched.map((item) => item.id)).toEqual(['c-resolved-beta']);
      expect(await list({ status: 'open', search: 'beta' })).toEqual([]);
    });
  },
);
