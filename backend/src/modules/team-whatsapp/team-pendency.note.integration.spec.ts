import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  at,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import {
  closedBy,
  heldBy,
  readers,
  setupHandling,
} from './team-pendency.handling.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.note.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
}, 180_000);

afterAll(() => stopPendencyDb(db));

/** Registrar contato em `at(10)`: `expected` é o responsável que a tela mostrava. */
const noteAs = (
  actorId: string,
  id: string,
  expected: string | null,
  text: string,
) =>
  scenario
    .actions()
    .addNote(actorId, id, { expectedHandlerId: expected, text }, at(10));

const CONTACT_TEXT = 'Liguei no celular e ninguém atendeu';

describe.skipIf(!ENABLED)('Registrar contato — grava a anotação', () => {
  it('aceite 18: registrar contato grava anotação CONTACT; situação e prazo iguais; trilha pendency_note sem o texto', async () => {
    const { manager, dispatchId, seed } = scenario;
    const { rowOf, notesOf, trailOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    const before = await rowOf(id);
    await noteAs(manager.id, id, manager.id, CONTACT_TEXT);
    expect(await rowOf(id)).toEqual(before);
    const [note, ...others] = await notesOf(id);
    expect(others).toEqual([]);
    expect(note).toMatchObject({
      kind: 'CONTACT',
      authorId: manager.id,
      text: CONTACT_TEXT,
      createdAt: at(10),
    });
    const [event, ...rest] = await trailOf(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_note',
      actorId: manager.id,
      metadata: {
        dispatchId,
        recipientId: id,
        kind: 'CONTACT',
        noteId: note.id,
      },
      changes: [
        { field: 'handlerId', before: manager.id, after: manager.id },
        { field: 'situation', before: 'IN_PROGRESS', after: 'IN_PROGRESS' },
        {
          field: 'dueAt',
          before: at(61).toISOString(),
          after: at(61).toISOString(),
        },
      ],
    });
    expect(JSON.stringify(event)).not.toContain(CONTACT_TEXT);
  });
});

describe.skipIf(!ENABLED)('Registrar contato — quem registra', () => {
  it('ADMIN também registra contato, de pendência de outro responsável ou sem responsável', async () => {
    const { manager, seed } = scenario;
    const { notesOf } = readers(db);
    const held = await seed(heldBy(manager.id));
    await noteAs(db.ids.admin, held, manager.id, 'Falei com o gestor');
    const free = await seed();
    await noteAs(db.ids.admin, free, null, 'Sem resposta ainda');
    expect(await notesOf(held)).toMatchObject([
      { kind: 'CONTACT', authorId: db.ids.admin },
    ]);
    expect(await notesOf(free)).toMatchObject([
      { kind: 'CONTACT', authorId: db.ids.admin },
    ]);
  });
});

describe.skipIf(!ENABLED)('Registrar contato — fora do período', () => {
  it('ações valem para pendência fora do período de 7 dias', async () => {
    const { manager, seed, actions } = scenario;
    const { notesOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    const later = at(40 * 24 * 60);
    await actions().addNote(
      manager.id,
      id,
      { expectedHandlerId: manager.id, text: 'Contato tardio' },
      later,
    );
    expect(await notesOf(id)).toMatchObject([
      { kind: 'CONTACT', createdAt: later },
    ]);
  });
});

describe.skipIf(!ENABLED)('Registrar contato — estado da pendência', () => {
  it('aceite 18: responsável trocado — 409 pendency_changed, nada gravado', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const id = await seed(heldBy(db.ids.admin));
    const before = await snapshot(id);
    await expect(
      noteAs(manager.id, id, manager.id, CONTACT_TEXT),
    ).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.pendency_changed',
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it('DK13: registrar contato pelo responsável em pendência ciente ou encerrada — grava a anotação', async () => {
    // Pega `pendencyConflict` olhando ciência ou encerramento no contato: a
    // ciência que chega no mesmo minuto não pode perder o contato já feito.
    const { manager, seed } = scenario;
    const { rowOf, notesOf, trailOf } = readers(db);
    const acked = await seed({ ...heldBy(manager.id), ackAt: at(5) });
    const closed = await seed({
      ...heldBy(manager.id),
      ...closedBy(db.ids.admin),
    });
    for (const id of [acked, closed]) {
      const before = await rowOf(id);
      await noteAs(manager.id, id, manager.id, CONTACT_TEXT);
      expect(await rowOf(id)).toEqual(before);
      expect(await notesOf(id)).toMatchObject([{ kind: 'CONTACT' }]);
    }
    const [event] = await trailOf(acked);
    expect(event).toMatchObject({
      changes: [
        { field: 'handlerId', before: manager.id, after: manager.id },
        { field: 'situation', before: 'ACKED', after: 'ACKED' },
        { field: 'dueAt' },
      ],
    });
  });
});
