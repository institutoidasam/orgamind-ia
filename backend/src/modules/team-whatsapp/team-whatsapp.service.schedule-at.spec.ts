import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  CreateTeamDispatchDto,
  PreviewTeamDispatchDto,
  type CreateTeamDispatchInput,
} from './dto/create-team-dispatch.dto';
import {
  ADMIN,
  SUPPRESSED,
  createHarness,
  givenNumber,
  givenSector,
  member,
  onShift,
  type Harness,
} from './team-whatsapp.test-fixtures';
import { withAudienceKey } from './team-whatsapp.sector-send.test-fixtures';

// "Agora" = 08:00 de 21/10 em Manaus (UTC−4); a Noite começa às 22:00 (02:00Z).
const DATE = '2026-10-21';
const NOW = new Date('2026-10-21T12:00:00Z');
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const TEXT = 'Recado agendado da equipe';
const ANA_PHONE = '+5592991110001';
const DANI_CONTACT = '+5592991110004';
const ana = member({ id: 'ana', name: 'Ana', phoneE164: ANA_PHONE });
const bia = member({ id: 'bia', name: 'Bia', phoneE164: null });
const caio = member({ id: 'caio', name: 'Caio', phoneE164: SUPPRESSED });
const dani = member({
  id: 'dani',
  name: 'Dani',
  phoneE164: '+5592991110005',
  contact: { phoneE164: DANI_CONTACT },
});
const eva = member({
  id: 'eva',
  name: 'Eva',
  phoneE164: '+5592991110006',
  contactAuthorization: 'NAO_AUTORIZADO',
});

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h = createHarness();
  givenNumber(h);
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.listActiveShifts.mockResolvedValue([NOITE]);
  givenSector(
    h,
    [ana, bia].map((m) => ({ ...m, ...onShift(NOITE) })),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

type Body = Partial<Omit<CreateTeamDispatchInput, 'target'>>;
type SectorTarget = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;
const body = (
  over: Body = {},
  target: Partial<SectorTarget> = {},
): CreateTeamDispatchInput => ({
  text: TEXT,
  purpose: 'shift_notice',
  ...over,
  target: { type: 'sector', sectorIds: ['s1'], date: DATE, ...target },
});
const send = async (input: CreateTeamDispatchInput, expectError = false) =>
  h.service.dispatch(
    ADMIN.id,
    await withAudienceKey(h, ADMIN.id, input, { expectError }),
  );
const created = () => h.repo.createDispatch.mock.calls[0][0];
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
// Reunião daqui a 3 dias, às 14:00 de Manaus (aceite 20).
const IN_3_DAYS = '2026-10-24';
const meetingAt = (time: string, activityTime = '14:00') =>
  body(
    {
      purpose: 'meeting',
      activity: { date: IN_3_DAYS, time: activityTime, place: 'Sala 2' },
      when: 'at',
      at: { date: IN_3_DAYS, time },
    },
    { date: IN_3_DAYS },
  );

describe('envio com data e hora (DG8) — gravação', () => {
  it('aceite 20: data e hora grava scheduledFor em Manaus, SCHEDULED e FROZEN_RECHECK', async () => {
    const out = await send(meetingAt('09:00'));

    expect(out).toMatchObject({
      queued: 0,
      scheduled: 1,
      scheduledFor: '2026-10-24T13:00:00.000Z',
    });
    expect(created()).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-10-24T13:00:00.000Z'),
      schedulePolicy: 'FROZEN_RECHECK',
      purpose: 'MEETING',
      audienceRule: { when: 'at' },
    });
    expect(created().recipients.map((r) => [r.userId, r.status])).toEqual([
      ['ana', 'SCHEDULED'],
      ['bia', 'SKIPPED'],
    ]);
    expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  });

  it('início do turno grava FROZEN_RECHECK', async () => {
    await send(body({ when: 'shift_start' }, { shiftIds: [NOITE.id] }));
    expect(created()).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      schedulePolicy: 'FROZEN_RECHECK',
    });
  });

  it('agora grava IMMEDIATE e a trilha dispatch leva a política', async () => {
    await send(body());
    expect(created()).toMatchObject({ schedulePolicy: 'IMMEDIATE' });
    expect(created()).not.toHaveProperty('state');
    expect(h.audit.log.mock.calls[0][0]).toBe('team_whatsapp.dispatch');
    expect(h.audit.log.mock.calls[0][3]).toMatchObject({ policy: 'immediate' });
    expect(h.audit.log.mock.calls[0][3]).not.toHaveProperty('when');
  });
});

describe('envio com data e hora (DG8) — regra gravada', () => {
  it('audienceRule grava when', async () => {
    await send(body());
    await send(body({ when: 'shift_start' }, { shiftIds: [NOITE.id] }));
    await send(body({ when: 'at', at: { date: DATE, time: '18:00' } }));
    const whens = h.repo.createDispatch.mock.calls.map(
      ([data]) => data.audienceRule?.when,
    );
    expect(whens).toEqual(['now', 'shift_start', 'at']);
  });
});

describe('envio com data e hora (DG8) — travas pela rota do envio', () => {
  it('aceite 37: 31 dias à frente — 422 schedule_too_far com o texto; urgência com at — 422 when_not_allowed', async () => {
    const tooFar = body({
      when: 'at',
      at: { date: '2026-11-21', time: '09:00' },
    });
    await expect(send(tooFar)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.schedule_too_far',
      message: 'O envio pode ser agendado para até 30 dias à frente.',
    });
    const urgency = body({
      purpose: 'urgency',
      urgencyReason: 'Vazamento no galpão',
      when: 'at',
      at: { date: DATE, time: '18:00' },
    });
    await expect(send(urgency, true)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.when_not_allowed',
    });
    expectNothingCreated();
  });

  it('aceite 30: reunião com at depois do início — 422 after_activity_start', async () => {
    await expect(send(meetingAt('15:00'))).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.after_activity_start',
      message: 'A mensagem precisa sair antes do início da atividade.',
    });
    expectNothingCreated();
  });

  it('data e hora já passada — 422 schedule_in_past com o texto da data e hora', async () => {
    const past = body({ when: 'at', at: { date: DATE, time: '07:59' } });
    await expect(send(past)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.schedule_in_past',
      message: 'A data e a hora do envio já passaram.',
    });
    expectNothingCreated();
  });
});

describe('envio — telefone gravado por destinatário (DG7)', () => {
  it('grava phoneE164 de cada destinatário, inclusive SKIPPED de telefone', async () => {
    givenSector(h, [ana, bia, caio, dani, eva]);
    const out = await send(body({ purpose: 'alignment' }));
    expect(
      created().recipients.map((r) => [r.userId, r.status, r.phoneE164]),
    ).toEqual([
      ['ana', 'QUEUED', ANA_PHONE],
      ['bia', 'SKIPPED', null],
      ['caio', 'SKIPPED', SUPPRESSED],
      ['dani', 'QUEUED', DANI_CONTACT],
      ['eva', 'SKIPPED', '+5592991110006'],
    ]);
    // T2-m1: a criação só pula por telefone; os motivos cabem nos 4 do front.
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'NO_PHONE',
      'SUPPRESSED',
      'NOT_AUTHORIZED',
    ]);
  });

  it('alvo pessoa grava phoneE164 e política nula', async () => {
    h.repo.findTargetUser.mockResolvedValue(dani);
    await h.service.dispatch(ADMIN.id, {
      text: TEXT,
      target: { type: 'user', userId: 'dani' },
    });
    expect(created().recipients).toMatchObject([
      { userId: 'dani', status: 'QUEUED', phoneE164: DANI_CONTACT },
    ]);
    expect(created().schedulePolicy ?? null).toBeNull();
    expect(created().audienceRule ?? null).toBeNull();
  });
});

describe('prévia e trilha do agendado com data e hora', () => {
  it('prévia com at devolve when at, scheduledFor e frozen_recheck', async () => {
    const preview = (time: string, date = DATE) =>
      h.audience.preview(ADMIN.id, {
        ...body({ when: 'at', at: { date, time } }),
        purpose: 'shift_notice',
        target: { type: 'sector', sectorIds: ['s1'], date: DATE },
      });
    const ok = await preview('18:00');
    expect(ok.rule).toMatchObject({
      when: 'at',
      scheduledFor: '2026-10-21T22:00:00.000Z',
      schedulePolicy: 'frozen_recheck',
    });
    expect(ok.blocks).toEqual([]);
    const late = await preview('07:00');
    const far = await preview('09:00', '2026-11-21');
    expect(late.blocks.map((b) => b.code)).toEqual([
      'team_whatsapp.schedule_in_past',
    ]);
    expect(far.blocks.map((b) => b.code)).toEqual([
      'team_whatsapp.schedule_too_far',
    ]);
  });

  it('trilha schedule com when e policy, sem nome, telefone nem texto', async () => {
    await send(body({ when: 'at', at: { date: DATE, time: '18:00' } }));
    expect(h.audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.schedule',
        'TeamWhatsappDispatch',
        'd1',
        {
          actorId: ADMIN.id,
          dispatchId: 'd1',
          purpose: 'shift_notice',
          base: 'on_duty',
          when: 'at',
          policy: 'frozen_recheck',
          scheduled: 1,
          skipped: 1,
        },
      ],
    ]);
    const logged = JSON.stringify(h.audit.log.mock.calls);
    for (const secret of ['Ana', 'Bia', ANA_PHONE, TEXT])
      expect(logged).not.toContain(secret);
  });
});

describe('corpo com at nulo (DTO)', () => {
  const pipe = (metatype: ArgumentMetadata['metatype'], raw: unknown) =>
    Promise.resolve().then((): unknown =>
      new ZodValidationPipe().transform(raw, { type: 'body', metatype }),
    );

  it.each([
    ['envio', CreateTeamDispatchDto],
    ['prévia', PreviewTeamDispatchDto],
  ])('at: null no %s — 400, nunca 500', async (_caso, dto) => {
    const raw = { ...body({ when: 'at' }), audienceKey: 'a'.repeat(64) };
    await expect(
      pipe(dto, { ...raw, at: { date: DATE, time: '18:00' } }),
    ).resolves.toMatchObject({ when: 'at' });
    await expect(pipe(dto, { ...raw, at: null })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
