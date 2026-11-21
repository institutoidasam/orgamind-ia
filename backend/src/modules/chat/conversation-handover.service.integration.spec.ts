import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addHandoverUsers,
  attendedBy,
  handoverActor,
  handoverInput,
  handoverService,
  type HandoverUsers,
} from './conversation-handover.test-fixtures';
import {
  at,
  auditRows,
  conversationRow,
  historyRows,
  startOwnershipDb,
  stopOwnershipDb,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-handover.service.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = at(10);

let db: OwnershipDb;
let users: HandoverUsers;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  users = await addHandoverUsers(db);
}, 180_000);

afterAll(() => stopOwnershipDb(db));

/** Nada gravado na conversa: mesma linha, nenhum histórico, nenhuma trilha. */
async function expectUntouched(ids: string[], before: object[]) {
  for (const [index, id] of ids.entries()) {
    expect(await conversationRow(db, id)).toEqual(before[index]);
    expect(await historyRows(db, id)).toEqual([]);
    expect(await auditRows(db, id)).toEqual([]);
  }
}

/** A conversa passada de Ana para Bia: linha, histórico e trilha (sem a observação). */
async function expectHandedOver(id: string) {
  expect(await conversationRow(db, id)).toMatchObject({
    assignedUserId: db.ids.bia,
    assignedAt: NOW,
    botPausedAt: NOW,
    resolvedAt: null,
  });
  expect(await historyRows(db, id)).toMatchObject([
    {
      action: 'SHIFT_HANDOVER',
      actorId: db.ids.ana,
      fromUserId: db.ids.ana,
      toUserId: db.ids.bia,
      note: 'Fim do turno',
      createdAt: NOW,
    },
  ]);
  const trail = await auditRows(db, id);
  expect(trail).toMatchObject([
    {
      action: 'conversation.assign',
      actorId: db.ids.ana,
      metadata: {
        assignedUserId: db.ids.bia,
        assignedBy: db.ids.ana,
        kind: 'SHIFT_HANDOVER',
      },
    },
  ]);
  expect(JSON.stringify(trail)).not.toContain('Fim do turno');
}

describe.skipIf(!ENABLED)(
  'handover — transfere as marcadas (aceite 25)',
  () => {
    it('atendente = destino, uma linha SHIFT_HANDOVER, conversation.assign sem observação, robô pausado, evento por conversa', async () => {
      const { service, events } = handoverService(db);
      const ids = [
        await attendedBy(db, db.ids.ana),
        await attendedBy(db, db.ids.ana),
      ];
      const result = await service.handover(
        handoverActor(db, 'ana'),
        handoverInput(db.ids.bia, ids),
        NOW,
      );
      expect(result).toEqual({
        transferred: ids.map((id) => ({ id })),
        skipped: [],
      });
      for (const id of ids) await expectHandedOver(id);
      expect(events.publish.mock.calls).toEqual(
        ids.map((id) => [
          {
            type: 'conversation.updated',
            conversationId: id,
            instanceId: db.channelId,
          },
        ]),
      );
    });
  },
);

describe.skipIf(!ENABLED)('handover — puladas (aceite 25)', () => {
  it('resolvida, com outro, sem atendente, inexistente: motivo certo e nada gravado nelas', async () => {
    const { service, events } = handoverService(db);
    const ok = await attendedBy(db, db.ids.ana);
    const resolved = await attendedBy(db, db.ids.ana, { resolvedAt: at(-5) });
    const other = await attendedBy(db, db.ids.admin);
    const free = await attendedBy(db, null);
    const skippedIds = [resolved, other, free];
    const before = await Promise.all(
      skippedIds.map((id) => conversationRow(db, id)),
    );
    const result = await service.handover(
      handoverActor(db, 'ana'),
      handoverInput(db.ids.bia, [
        resolved,
        other,
        ok,
        free,
        'conv-inexistente',
      ]),
      NOW,
    );
    expect(result).toEqual({
      transferred: [{ id: ok }],
      skipped: [
        { id: resolved, reason: 'resolved' },
        { id: other, reason: 'other_assignee' },
        { id: free, reason: 'unassigned' },
        { id: 'conv-inexistente', reason: 'not_found' },
      ],
    });
    await expectUntouched(skippedIds, before);
    expect(events.publish).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!ENABLED)('handover — repetir o pedido (aceite 25)', () => {
  it('todas already_with_target e nenhuma linha nova', async () => {
    const { service, events } = handoverService(db);
    const ids = [
      await attendedBy(db, db.ids.ana),
      await attendedBy(db, db.ids.ana),
    ];
    const input = handoverInput(db.ids.bia, ids);
    await service.handover(handoverActor(db, 'ana'), input, NOW);
    const again = await service.handover(
      handoverActor(db, 'ana'),
      input,
      at(20),
    );
    expect(again).toEqual({
      transferred: [],
      skipped: ids.map((id) => ({ id, reason: 'already_with_target' })),
    });
    for (const id of ids) {
      expect(await historyRows(db, id)).toHaveLength(1);
      expect(await auditRows(db, id)).toHaveLength(1);
    }
    expect(events.publish).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!ENABLED)(
  'handover — ADMIN passa as de outro (aceite 26)',
  () => {
    it('as de atendente inativo: autor = ADMIN, de = inativo', async () => {
      const { service } = handoverService(db);
      const id = await attendedBy(db, users.inactive);
      const result = await service.handover(
        handoverActor(db, 'admin'),
        handoverInput(db.ids.ana, [id], { fromUserId: users.inactive }),
        NOW,
      );
      expect(result.transferred).toEqual([{ id }]);
      expect(await conversationRow(db, id)).toMatchObject({
        assignedUserId: db.ids.ana,
      });
      expect(await historyRows(db, id)).toMatchObject([
        {
          action: 'SHIFT_HANDOVER',
          actorId: db.ids.admin,
          fromUserId: users.inactive,
          toUserId: db.ids.ana,
        },
      ]);
      expect(await auditRows(db, id)).toMatchObject([
        { actorId: db.ids.admin },
      ]);
    });
  },
);

describe.skipIf(!ENABLED)('handover — autorização e destino', () => {
  it('OPERATOR pede as de outro — 403 chat.not_assignee antes do 404 do destino; nada gravado', async () => {
    const { service, events } = handoverService(db);
    const id = await attendedBy(db, db.ids.bia);
    const before = [await conversationRow(db, id)];
    await expect(
      service.handover(
        handoverActor(db, 'ana'),
        handoverInput(users.inactive, [id], { fromUserId: db.ids.bia }),
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'chat.not_assignee' });
    await expectUntouched([id], before);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('destino SUPERVISOR, inativo, sem acesso, inexistente ou igual a quem sai — 404 user.not_found; nada gravado', async () => {
    const { service, events } = handoverService(db);
    const id = await attendedBy(db, db.ids.ana);
    const before = [await conversationRow(db, id)];
    const targets = [
      users.supervisor,
      users.inactive,
      users.noAccess,
      'user-inexistente',
      db.ids.ana,
    ];
    for (const toUserId of targets) {
      await expect(
        service.handover(
          handoverActor(db, 'ana'),
          handoverInput(toUserId, [id]),
          NOW,
        ),
      ).rejects.toMatchObject({ status: 404, code: 'user.not_found' });
    }
    await expectUntouched([id], before);
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ENABLED)('handover — robô e mensagens (K3-7 b, K3-5)', () => {
  it('K3-7(b): passagem não retoma — a pausada segue pausada e a pulada não muda botPausedAt', async () => {
    const { service } = handoverService(db);
    const paused = await attendedBy(db, db.ids.ana, { botPausedAt: at(-30) });
    const resolved = await attendedBy(db, db.ids.ana, {
      resolvedAt: at(-5),
      botPausedAt: at(-30),
    });
    await service.handover(
      handoverActor(db, 'ana'),
      handoverInput(db.ids.bia, [paused, resolved]),
      NOW,
    );
    expect((await conversationRow(db, paused)).botPausedAt).toEqual(NOW);
    expect((await conversationRow(db, resolved)).botPausedAt).toEqual(at(-30));
  });

  it('K3-5: nenhuma mensagem criada, nenhum envio da equipe agendado', async () => {
    const { service } = handoverService(db);
    const id = await attendedBy(db, db.ids.ana);
    await db.prisma.message.create({
      data: {
        conversationId: id,
        instanceId: db.channelId,
        direction: 'INBOUND',
        content: 'oi',
      },
    });
    const counts = async () => [
      await db.prisma.message.count(),
      await db.prisma.teamWhatsappDispatch.count(),
      await db.prisma.teamWhatsappRecipient.count(),
    ];
    const before = await counts();
    await service.handover(
      handoverActor(db, 'ana'),
      handoverInput(db.ids.bia, [id]),
      NOW,
    );
    expect(await counts()).toEqual(before);
  });
});

describe.skipIf(!ENABLED)('handover — falha ao publicar o evento', () => {
  it('o commit já valeu: o lote segue, o resultado lista as duas e a segunda também publica', async () => {
    const { service, events } = handoverService(db);
    events.publish.mockRejectedValueOnce(new Error('redis fora'));
    const ids = [
      await attendedBy(db, db.ids.ana),
      await attendedBy(db, db.ids.ana),
    ];
    const result = await service.handover(
      handoverActor(db, 'ana'),
      handoverInput(db.ids.bia, ids),
      NOW,
    );
    expect(result.transferred).toEqual(ids.map((id) => ({ id })));
    expect(events.publish).toHaveBeenCalledTimes(2);
  });
});
