import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { manualAckSchema } from './dto/manual-ack.dto';
import { TeamAlertAckService } from './team-alert-ack.service';
import type { TeamActor } from './team-whatsapp.policy';

// CI6 (I5, DI7; aceites 11, 12, 19): recusas e trilhas da ciência manual com
// repositório, banco e trilha falsos. A gravação e as corridas são provadas
// contra o Postgres real em team-alert-manual-ack.integration.spec.ts.
const NOW = new Date('2026-11-20T13:10:00.000Z');

type Setup = {
  actor: TeamActor | null;
  authorId?: string;
  deadline?: number | null;
  inDispatch?: boolean;
};

const withKey = (id: string): TeamActor => ({
  ...actorWith('SUPERVISOR', { id, grant: ['equipe.urgencia'] }),
  managedSectorIds: ['s1'],
});
const withoutKey = (id: string): TeamActor => ({
  ...actorWith('SUPERVISOR', { id }),
  managedSectorIds: ['s1'],
});

function setup(s: Setup) {
  const repo = {
    findActor: vi.fn().mockResolvedValue(s.actor),
    findDispatchForActor: vi.fn().mockResolvedValue({
      id: 'd1',
      authorId: s.authorId ?? 'sup-1',
      targetType: 'SECTOR',
      targetId: 's1',
      state: 'DISPATCHED',
      sectors: [{ sectorId: 's1' }],
    }),
  };
  const db = {
    teamWhatsappDispatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'd1',
        createdAt: NOW,
        ackDeadlineMinutes: s.deadline === undefined ? 15 : s.deadline,
        reminderCount: 0,
        lastReminderAt: null,
      }),
    },
    teamWhatsappRecipient: {
      // Alcance da pendência (K2-7): o envio invisível consulta os fatos; sem eles, 404.
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi
        .fn()
        .mockResolvedValue(s.inDispatch === false ? null : { id: 'r1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ ackKind: null }]),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new TeamAlertAckService(
    repo as never,
    db as never,
    audit as never,
  );
  const mark = () =>
    service.markManual('x', 'd1', 'r1', { note: 'ligou', now: NOW });
  const undo = () => service.undoManual('x', 'd1', 'r1');
  return { repo, db, audit, mark, undo };
}

type Fixture = ReturnType<typeof setup>;

function expectNothingWritten({ db, audit }: Fixture) {
  expect(db.teamWhatsappRecipient.updateMany).not.toHaveBeenCalled();
  expect(db.$queryRaw).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
}

describe('TeamAlertAckService — chave antes da visibilidade (aceite 12, GI4)', () => {
  it('aceite 12: sem a chave — 403 antes de buscar o envio', async () => {
    for (const op of ['mark', 'undo'] as const) {
      const f = setup({ actor: withoutKey('sup-1') });
      await expect(f[op]()).rejects.toMatchObject({
        status: 403,
        code: 'auth.permission_denied',
        detail: 'Você não tem permissão para criar alerta urgente.',
      });
      expect(f.repo.findDispatchForActor).not.toHaveBeenCalled();
      expect(f.db.teamWhatsappDispatch.findUnique).not.toHaveBeenCalled();
      expect(f.db.teamWhatsappRecipient.findFirst).not.toHaveBeenCalled();
      expectNothingWritten(f);
    }
  });

  it('sem a chave num alerta invisível — 403, não 404', async () => {
    const f = setup({ actor: withoutKey('sup-2'), authorId: 'sup-1' });
    await expect(f.mark()).rejects.toMatchObject({ status: 403 });
    await expect(f.undo()).rejects.toMatchObject({ status: 403 });
    expect(f.repo.findDispatchForActor).not.toHaveBeenCalled();
  });

  it('sem ator ou sem papel de remetente — 403 antes da chave e do envio', async () => {
    const viewer = {
      ...actorWith('VIEWER', { id: 'v', grant: ['equipe.urgencia'] }),
      managedSectorIds: ['s1'],
    };
    for (const actor of [null, viewer]) {
      const f = setup({ actor });
      await expect(f.mark()).rejects.toMatchObject({
        status: 403,
        code: 'team_whatsapp.forbidden',
      });
      expect(f.repo.findDispatchForActor).not.toHaveBeenCalled();
      expectNothingWritten(f);
    }
  });
});

describe('TeamAlertAckService — 404 e 422 (I5)', () => {
  it('invisível — 404; destinatário de outro envio — 404', async () => {
    const invisible = setup({ actor: withKey('sup-2'), authorId: 'sup-1' });
    await expect(invisible.mark()).rejects.toMatchObject({ status: 404 });
    await expect(invisible.undo()).rejects.toMatchObject({ status: 404 });
    expect(invisible.db.teamWhatsappRecipient.findFirst).not.toHaveBeenCalled();
    expectNothingWritten(invisible);

    const other = setup({ actor: withKey('sup-1'), inDispatch: false });
    await expect(other.mark()).rejects.toMatchObject({
      status: 404,
      code: 'team_whatsapp.dispatch_not_found',
    });
    await expect(other.undo()).rejects.toMatchObject({ status: 404 });
    expect(other.db.teamWhatsappRecipient.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', dispatchId: 'd1' },
      select: { id: true },
    });
    expectNothingWritten(other);
  });

  it('aceite 19: reunião ou lembrete — 422 not_an_alert', async () => {
    const f = setup({ actor: withKey('sup-1'), deadline: null });
    await expect(f.mark()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.not_an_alert',
    });
    await expect(f.undo()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.not_an_alert',
    });
    expectNothingWritten(f);
  });

  it('gravação que não muda linha — 422 ack_exists no marcar, ack_not_manual no desfazer', async () => {
    const f = setup({ actor: withKey('sup-1') });
    f.db.teamWhatsappRecipient.updateMany.mockResolvedValue({ count: 0 });
    f.db.$queryRaw.mockResolvedValue([]);
    await expect(f.mark()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.ack_exists',
    });
    await expect(f.undo()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.ack_not_manual',
    });
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});

describe('TeamAlertAckService — trilhas sem dado pessoal (GI3)', () => {
  it('trilha ack_manual só com actorId, dispatchId e recipientId (sem observação)', async () => {
    const f = setup({ actor: withKey('sup-1') });
    await f.mark();
    expect(f.db.teamWhatsappRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', dispatchId: 'd1', ackAt: null },
      data: {
        ackAt: NOW,
        ackKind: 'MANUAL',
        ackByUserId: 'sup-1',
        ackNote: 'ligou',
      },
    });
    expect(f.audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.ack_manual',
        'TeamWhatsappRecipient',
        'r1',
        { actorId: 'sup-1', dispatchId: 'd1', recipientId: 'r1' },
      ],
    ]);
  });

  it('trilha ack_manual_undo com result pending ou keyword', async () => {
    const results: [string | null, string][] = [
      [null, 'pending'],
      ['KEYWORD', 'keyword'],
    ];
    for (const [ackKind, result] of results) {
      const f = setup({ actor: withKey('sup-1') });
      f.db.$queryRaw.mockResolvedValue([{ ackKind }]);
      await f.undo();
      expect(f.audit.log.mock.calls).toEqual([
        [
          'team_whatsapp.ack_manual_undo',
          'TeamWhatsappRecipient',
          'r1',
          { actorId: 'sup-1', dispatchId: 'd1', recipientId: 'r1', result },
        ],
      ]);
    }
  });
});

describe('manualAckSchema (CI6)', () => {
  const pipe = new ZodValidationPipe(manualAckSchema);
  const parse = (body: unknown): unknown =>
    pipe.transform(body, { type: 'body' });

  it('observação aparada, até 200 caracteres', () => {
    expect(parse({ note: '  confirmou por ligação  ' })).toEqual({
      note: 'confirmou por ligação',
    });
    expect(parse({ note: 'a'.repeat(200) })).toEqual({ note: 'a'.repeat(200) });
  });

  it('observação com 201 caracteres — 400; só espaços — 400', () => {
    for (const body of [{ note: 'a'.repeat(201) }, { note: '   ' }, {}]) {
      expect(() => parse(body)).toThrow(BadRequestException);
    }
  });
});
