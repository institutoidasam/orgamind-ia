import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  conversationRow,
  historyRows,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';
import {
  claimConversation,
  startClaimEnv,
  type ClaimEnv,
} from './conversation-claim.test-fixtures';

/**
 * K1-9 / DK11: o que não passa pela trava não muda situação nem atendente.
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/chat.k1-9.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: OwnershipDb;
let env: ClaimEnv;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  env = await startClaimEnv(db);
}, 180_000);

beforeEach(() => vi.clearAllMocks());

afterAll(() => stopOwnershipDb(db));

const ownership = async (id: string) => {
  const { assignedUserId, assignedAt, resolvedAt } = await conversationRow(
    db,
    id,
  );
  return { assignedUserId, assignedAt, resolvedAt };
};

describe.skipIf(!ENABLED)(
  'K1-9 — envios que não reivindicam a conversa',
  () => {
    it('aceite 9: prepareTeamMessage numa conversa de outro — passa; atendente e resolvedAt iguais', async () => {
      const id = await claimConversation(env, {
        assignedUserId: db.ids.ana,
        assignedAt: T0,
      });
      const before = await ownership(id);
      const prepared = await env.chat.prepareTeamMessage({
        instanceId: env.instanceId,
        contactId: null,
        phoneE164: '+5592991110001',
        text: 'recado da equipe',
        authorUserId: db.ids.bia,
      });
      const message = await db.prisma.message.findUniqueOrThrow({
        where: { id: prepared.messageId },
      });
      expect(message).toMatchObject({ conversationId: id, status: 'QUEUED' });
      expect(await ownership(id)).toEqual(before);
      expect(await historyRows(db, id)).toEqual([]);
    });

    it('aceite 9: sendBotReply numa resolvida — continua resolvida e sem atendente', async () => {
      const id = await claimConversation(env, { resolvedAt: T0 });
      const bot = await db.prisma.bot.create({
        data: { name: 'Robô de teste', difyApiKey: 'chave-de-teste' },
        select: { id: true },
      });
      await env.chat.sendBotReply(id, 'olá do robô', bot.id);
      expect(await ownership(id)).toMatchObject({
        assignedUserId: null,
        resolvedAt: T0,
      });
      expect(await historyRows(db, id)).toEqual([]);
    });
  },
);

describe.skipIf(!ENABLED)(
  'K1-9 — marcar como lida não reivindica a conversa',
  () => {
    it('markRead não muda situação nem atendente', async () => {
      const withAna = await claimConversation(env, {
        assignedUserId: db.ids.ana,
        assignedAt: T0,
        unreadCount: 2,
      });
      const resolved = await claimConversation(env, {
        resolvedAt: T0,
        unreadCount: 2,
      });
      for (const id of [withAna, resolved]) {
        const before = await ownership(id);
        await env.chat.markRead(id);
        expect((await conversationRow(db, id)).unreadCount).toBe(0);
        expect(await ownership(id)).toEqual(before);
      }
    });
  },
);

/**
 * Arquivos de produção que podem conter `assignedUserId:` sem gravar a
 * propriedade: o núcleo (que grava), o mapper e o filtro de leitura, e quem só
 * monta o `OwnershipChange` que o núcleo aplica.
 */
const ALLOWED = new Set([
  'chat/conversation-ownership.repository.ts',
  'chat/conversation-summary.mapper.ts',
  'chat/conversation-assign.rules.ts',
  'chat/conversation-claim.ts',
  'chat/conversation-ownership.service.ts',
  'chat/conversation-situation.ts',
  'users/person-history.ts',
]);

function productionSources(): string[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !/\.(spec|test-fixtures)\.ts$/.test(file))
    .map((file) => file.replaceAll('\\', '/'));
}

describe('K1 — a propriedade da conversa só é gravada pelo núcleo', () => {
  it('nenhuma escrita de assignedUserId fora do núcleo', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders = productionSources()
      .filter((file) => !ALLOWED.has(file))
      .filter((file) =>
        readFileSync(root + file, 'utf8').includes('assignedUserId:'),
      );
    expect(offenders).toEqual([]);
  });
});
