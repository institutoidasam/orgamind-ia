import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListConversationsQuery } from '../../schemas/contracts/chat.schema';
import { ChatRepository } from './chat.repository';
import { ChatService } from './chat.service';
import { findHandoverReceivedIds } from './conversation-handover-received.query';
import {
  attendedBy,
  handoverActor,
  handoverInput,
  handoverService,
} from './conversation-handover.test-fixtures';
import {
  historyRows,
  ownershipService,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-handover-received.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
// Passado fixo: assign/resolve/claimForReply gravam com o relógio real e ficam depois da passagem.
const NOW = new Date('2026-11-01T12:00:00.000Z');

type Who = 'admin' | 'ana' | 'bia';

let db: OwnershipDb;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
}, 180_000);

// Cada teste parte de uma caixa vazia (o histórico sai junto, em cascata).
beforeEach(async () => {
  if (ENABLED) await db.prisma.conversation.deleteMany();
});

afterAll(() => stopOwnershipDb(db));

/** A lista do `ChatService` real sobre o banco; devolve os ids ordenados. */
async function listIds(who: Who, query: Partial<ListConversationsQuery> = {}) {
  const chat = new ChatService(
    new ChatRepository(db.prisma as never),
    {} as never,
    {} as never,
    db.prisma as never,
    db.audit,
  );
  const page = await chat.listConversations(
    { filter: 'all', status: 'open', page: 1, pageSize: 50, ...query },
    db.ids[who],
  );
  return page.items.map((item) => item.id).sort();
}

/** A aba "Recebidas na passagem de turno": `assignee=me&handover=true`. */
const received = (who: Who, query: Partial<ListConversationsQuery> = {}) =>
  listIds(who, { assignee: 'me', handover: 'true', ...query });

/** Passagem real (serviço da T-B2): `SHIFT_HANDOVER` com `createdAt = assignedAt = NOW`. */
async function handOver(from: Who, to: Who, ids: string[]) {
  const { service } = handoverService(db);
  await service.handover(
    handoverActor(db, from),
    handoverInput(db.ids[to], ids),
    NOW,
  );
}

const assign = (
  id: string,
  who: Who,
  userId: string | null,
  expectedAssigneeId: string | null,
) =>
  ownershipService(db).service.assign(id, handoverActor(db, who), {
    userId,
    expectedAssigneeId,
  });

const claimOnReply = (id: string, who: Who) =>
  ownershipService(db).service.claimForReply(id, db.ids[who]);

const resolveAs = (id: string, who: Who) =>
  ownershipService(db).service.resolve(id, handoverActor(db, who), {
    expectedAssigneeId: db.ids[who],
    expectedLastInboundAt: T0.toISOString(),
  });

const patch = (id: string, data: { archivedAt?: Date; resolvedAt?: Date }) =>
  db.prisma.conversation.update({ where: { id }, data });

/** `count` conversas abertas de Ana, criadas em série. */
async function attendedByAna(count: number) {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) ids.push(await attendedBy(db, db.ids.ana));
  return ids;
}

describe.skipIf(!ENABLED)('Recebidas na passagem de turno: entra', () => {
  it('aceite 27: recebida por passagem e ainda comigo — entra', async () => {
    const handed = await attendedBy(db, db.ids.ana);
    await attendedBy(db, db.ids.bia); // atribuída direto a Bia: não é passagem
    await attendedBy(db, null); // Pendente: sem atendente
    await handOver('ana', 'bia', [handed]);

    expect(await received('bia')).toEqual([handed]);
  });

  it('passagem para outro — não entra na minha', async () => {
    const id = await attendedBy(db, db.ids.ana);
    await handOver('ana', 'bia', [id]);

    expect(await received('ana')).toEqual([]);
    expect(await received('admin')).toEqual([]);
    expect(await received('bia')).toEqual([id]);
  });
});

describe.skipIf(!ENABLED)('Recebidas na passagem de turno: sai', () => {
  it('recebida e depois assumida por outro ao responder (ASSUMED_ON_REPLY) — sai', async () => {
    const byOther = await attendedBy(db, db.ids.ana);
    const byMe = await attendedBy(db, db.ids.ana);
    await handOver('ana', 'bia', [byOther, byMe]);
    for (const id of [byOther, byMe]) await assign(id, 'bia', null, db.ids.bia);
    await claimOnReply(byOther, 'ana');
    await claimOnReply(byMe, 'bia'); // volta para Bia, mas por resposta

    expect((await historyRows(db, byMe)).at(-1)?.action).toBe(
      'ASSUMED_ON_REPLY',
    );
    expect(await received('bia')).toEqual([]);
    expect(await received('ana')).toEqual([]);
  });

  it('recebida e depois transferida de volta para mim — sai (a última mudança é TRANSFERRED)', async () => {
    const id = await attendedBy(db, db.ids.ana);
    await handOver('ana', 'bia', [id]);
    await assign(id, 'bia', db.ids.ana, db.ids.bia);
    await assign(id, 'ana', db.ids.bia, db.ids.ana);

    expect((await historyRows(db, id)).at(-1)).toMatchObject({
      action: 'TRANSFERRED',
      toUserId: db.ids.bia,
    });
    expect(await received('bia')).toEqual([]);
  });

  it('recebida e depois resolvida — sai', async () => {
    const [kept, resolved, archived, stale] = await attendedByAna(4);
    await handOver('ana', 'bia', [kept, resolved, archived, stale]);
    await resolveAs(resolved, 'bia');
    // Linhas que ainda apontam para Bia, mas arquivadas ou resolvidas: a consulta as exclui.
    await patch(archived, { archivedAt: NOW });
    await patch(stale, { resolvedAt: NOW });

    expect(await received('bia')).toEqual([kept]);
    expect(
      await findHandoverReceivedIds(db.prisma as never, db.ids.bia),
    ).toEqual([kept]);
  });
});

describe.skipIf(!ENABLED)('Recebidas na passagem de turno: combinações', () => {
  it('combina com unread e busca; status=resolved vazio', async () => {
    const alfa = await attendedBy(db, db.ids.ana, {
      waName: 'Cliente Alfa',
      unreadCount: 2,
      lastMessageDirection: 'INBOUND',
    });
    const beta = await attendedBy(db, db.ids.ana, {
      waName: 'Cliente Beta',
      unreadCount: 0,
      lastMessageDirection: 'INBOUND',
    });
    await handOver('ana', 'bia', [alfa, beta]);

    expect(await received('bia', { filter: 'unread' })).toEqual([alfa]);
    expect(await received('bia', { filter: 'awaiting' })).toEqual(
      [alfa, beta].sort(),
    );
    expect(await received('bia', { search: 'Beta' })).toEqual([beta]);
    expect(await received('bia', { status: 'resolved' })).toEqual([]);
  });

  it('sem handover — lista igual à de antes', async () => {
    const handed = await attendedBy(db, db.ids.ana);
    const direct = await attendedBy(db, db.ids.bia);
    const pending = await attendedBy(db, null);
    await handOver('ana', 'bia', [handed]);

    const mine = [handed, direct].sort();
    expect(await listIds('bia', { assignee: 'me' })).toEqual(mine);
    expect(await listIds('bia', { assignee: 'me', handover: 'false' })).toEqual(
      mine,
    );
    expect(await listIds('bia', { assignee: 'unassigned' })).toEqual([pending]);
  });

  it('handover=true com assignee de outro, unassigned ou ausente — o servidor força o atendente = quem olha; nunca lista as recebidas por outro', async () => {
    const mine = await attendedBy(db, db.ids.ana);
    const theirs = await attendedBy(db, db.ids.bia);
    await handOver('ana', 'bia', [mine]);
    await handOver('bia', 'ana', [theirs]);

    for (const assignee of [db.ids.ana, 'unassigned', undefined, 'me']) {
      expect(await listIds('bia', { handover: 'true', assignee })).toEqual([
        mine,
      ]);
    }
  });
});
