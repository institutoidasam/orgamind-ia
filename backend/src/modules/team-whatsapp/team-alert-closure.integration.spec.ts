import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAlertClosures } from './team-alert-closure';
import {
  T0,
  at,
  newAlert,
  newPendency,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * K2-2 (DK18): `loadAlertClosures` contra o Postgres real. Opt-in (Testcontainers):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-alert-closure.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: TestDb;

beforeAll(async () => {
  if (ENABLED) db = await startPendencyDb();
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

const newAlertOf = () =>
  newAlert(db, { authorId: db.ids.admin, createdAt: T0 });

describe.skipIf(!ENABLED)('loadAlertClosures — encerramentos do alerta', () => {
  it('mapa só com os destinatários encerrados do alerta; motivo, hora e quem', async () => {
    const dispatchId = await newAlertOf();
    const closed = await newPendency(db, {
      dispatchId,
      handlerId: db.ids.ana,
      closedAt: at(30),
      closedById: db.ids.bia,
      closeReason: 'Contato feito por ligação',
    });
    await newPendency(db, { dispatchId, handlerId: db.ids.ana });
    const otherAlert = await newAlertOf();
    await newPendency(db, {
      dispatchId: otherAlert,
      closedAt: at(31),
      closedById: db.ids.bia,
      closeReason: 'Outro alerta',
    });

    const closures = await loadAlertClosures(db.prisma, dispatchId);

    expect([...closures.keys()]).toEqual([closed]);
    expect(closures.get(closed)).toEqual({
      at: at(30),
      byUserId: db.ids.bia,
      reason: 'Contato feito por ligação',
    });
  });
});

describe.skipIf(!ENABLED)('loadAlertClosures — reabertura', () => {
  it('reaberta — fora do mapa', async () => {
    const dispatchId = await newAlertOf();
    const reopened = await newPendency(db, {
      dispatchId,
      handlerId: db.ids.ana,
      closedAt: at(30),
      closedById: db.ids.bia,
      closeReason: 'Encerrada por engano',
    });
    // Reabrir limpa as três colunas do encerramento (K2-7).
    await db.prisma.teamWhatsappRecipient.update({
      where: { id: reopened },
      data: {
        pendencyClosedAt: null,
        pendencyClosedById: null,
        pendencyCloseReason: null,
      },
    });

    const closures = await loadAlertClosures(db.prisma, dispatchId);

    expect(closures.size).toBe(0);
  });
});
