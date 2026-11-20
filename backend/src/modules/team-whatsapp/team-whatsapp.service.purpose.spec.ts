import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import type { TeamActor } from './team-whatsapp.policy';
import {
  ADMIN,
  createHarness,
  dayPerson,
  givenNumber,
  givenNumbers,
  member,
  numberRow,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';
import { withAudienceKey } from './team-whatsapp.sector-send.test-fixtures';

// Produção (s1) e Logística (s2) em 21/10; "agora" = 08:00 de Manaus, antes da
// Noite (22:00) e das atividades das 15:00.
const DATE = '2026-10-21';
const NOW = new Date('2026-10-21T12:00:00Z');
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const PROD = 's1';
const LOG = 's2';
const TEXT = 'Recado da equipe';
const PLACE = 'Sala de treinamento 2';
const REASON = 'Vazamento no galpão';
const ACTIVITY = { date: DATE, time: '15:00', place: PLACE };

const vacation: ScheduleExceptionInput = {
  id: 'ex-ferias',
  kind: 'VACATION',
  startDate: DATE,
  endDate: DATE,
  shiftId: null,
  sectorId: null,
};
const ana = dayPerson({
  id: 'ana',
  name: 'Ana',
  phoneE164: '+5592991110001',
  ...onShift(NOITE),
});
const joao = dayPerson({
  id: 'joao',
  name: 'João',
  phoneE164: '+5592991110002',
  ...onShift(NOITE),
});

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h = createHarness();
  givenNumber(h);
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(
      sector({ id, name: id === PROD ? 'Produção' : 'Logística' }),
    ),
  );
  h.repo.listActiveShifts.mockResolvedValue([NOITE]);
  h.repo.loadDayPeople.mockResolvedValue([ana, joao]);
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
  target: { type: 'sector', sectorIds: [PROD], date: DATE, ...target },
});
// A impressão sai do público real com os fakes do momento (a "prévia").
const keyed = (input: CreateTeamDispatchInput, expectError = false) =>
  withAudienceKey(h, ADMIN.id, input, { expectError });
const send = async (input: CreateTeamDispatchInput) =>
  h.service.dispatch(ADMIN.id, await keyed(input));
const created = () => h.repo.createDispatch.mock.calls[0][0];
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
const CHANGED = {
  code: 'team_whatsapp.audience_changed',
  status: 409,
  message: 'O público mudou depois da prévia. Confira de novo antes de enviar.',
};

describe('envio com finalidade — impressão do público (GF9)', () => {
  it('aceite 11: escala alterada entre prévia e envio — 409 audience_changed e nada é criado', async () => {
    const input = await keyed(body());
    h.repo.loadDayPeople.mockResolvedValue([
      ana,
      { ...joao, exceptions: [vacation] },
    ]);
    await expect(h.service.dispatch(ADMIN.id, input)).rejects.toMatchObject(
      CHANGED,
    );
    expectNothingCreated();
  });

  it('aceite 16: telefone de incluído trocado — 409', async () => {
    const input = await keyed(body());
    h.repo.loadDayPeople.mockResolvedValue([
      ana,
      { ...joao, phoneE164: '+5592991110009' },
    ]);
    await expect(h.service.dispatch(ADMIN.id, input)).rejects.toMatchObject(
      CHANGED,
    );
    expectNothingCreated();
  });

  it('409 antes do 422: marcado que perdeu a relação dá 409', async () => {
    const input = await keyed(body({}, { userIds: ['joao'] }));
    // João saiu do setor depois da prévia: o id fica sem relação e a impressão muda.
    h.repo.loadDayPeople.mockResolvedValue([ana]);
    await expect(h.service.dispatch(ADMIN.id, input)).rejects.toMatchObject(
      CHANGED,
    );
    expectNothingCreated();
  });
});

const OPERATOR_WITHOUT_BROAD: TeamActor = {
  ...actorWith('OPERATOR', { id: 'm', revoke: ['equipe.disparo_amplo'] }),
  managedSectorIds: [PROD, LOG],
};

describe('envio com finalidade — ordem das recusas', () => {
  it('ordem nova: 403 de disparo amplo antes de 422 invalid_selection', async () => {
    h.repo.findActor.mockResolvedValue(OPERATOR_WITHOUT_BROAD);
    h.repo.listActiveSectorIds.mockResolvedValue([PROD, LOG]);
    const input = body({}, { sectorIds: [PROD, LOG], userIds: ['nao-existe'] });
    const sent = await withAudienceKey(h, 'm', input, { expectError: true });
    await expect(h.service.dispatch('m', sent)).rejects.toMatchObject({
      code: 'team_whatsapp.broad_send_denied',
      status: 403,
    });
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    expectNothingCreated();
  });

  it('mesma impressão e id sem relação dá 422 invalid_selection', async () => {
    const input = await keyed(body({}, { userIds: ['joao', 'nao-existe'] }));
    await expect(h.service.dispatch(ADMIN.id, input)).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_selection',
      status: 422,
    });
    expectNothingCreated();
  });
});

describe('envio com finalidade — travas do botão (CF4)', () => {
  it('aceite 4: palestra sem local — 422 missing_activity com o texto, nada criado', async () => {
    const input = body({
      purpose: 'lecture',
      activity: { date: DATE, time: '15:00' },
    });
    await expect(send(input)).rejects.toMatchObject({
      code: 'team_whatsapp.missing_activity',
      status: 422,
      message: 'Informe a data, a hora e o local da atividade.',
    });
    expectNothingCreated();
  });

  it('texto só com espaços no alvo setor — 422 empty_text', async () => {
    await expect(send(body({ text: '   ' }))).rejects.toMatchObject({
      code: 'team_whatsapp.empty_text',
      status: 422,
      message: 'Escreva a mensagem.',
    });
    expectNothingCreated();
  });
});

describe('envio com finalidade — gravação (F2, DF3, DF4)', () => {
  it('grava finalidade, base, atividade, motivo, regra e excluídos; roster nulo', async () => {
    h.repo.loadDayPeople.mockResolvedValue([
      ana,
      { ...joao, exceptions: [vacation] },
    ]);
    // Reunião não tem motivo de urgência: o enviado é ignorado.
    await send(
      body({ purpose: 'meeting', activity: ACTIVITY, urgencyReason: REASON }),
    );
    expect(created()).toMatchObject({
      purpose: 'MEETING',
      audienceBase: 'ASSIGNED',
      activity: ACTIVITY,
      urgencyReason: null,
      rosterDate: DATE,
      includeOff: false,
      roster: null,
      audienceRule: {
        shifts: null,
        levels: [],
        withoutLevel: false,
        selectedUserIds: null,
      },
      audienceExcluded: [
        { userId: 'joao', name: 'João', sectorId: PROD, reason: 'vacation' },
      ],
    });
    expect(created().recipients.map((r) => [r.userId, r.status])).toEqual([
      ['ana', 'QUEUED'],
    ]);
  });
});

describe('envio com finalidade — atividade e motivo por finalidade (T3)', () => {
  it('aviso de turno e urgência gravam atividade nula (T3); urgência grava o motivo', async () => {
    await send(
      body({ purpose: 'urgency', activity: ACTIVITY, urgencyReason: REASON }),
    );
    expect(created()).toMatchObject({
      purpose: 'URGENCY',
      audienceBase: 'ON_DUTY',
      activity: null,
      urgencyReason: REASON,
    });
    h.repo.createDispatch.mockClear();
    await send(body({ activity: ACTIVITY, urgencyReason: REASON }));
    expect(created()).toMatchObject({
      purpose: 'SHIFT_NOTICE',
      activity: null,
      urgencyReason: null,
    });
  });
});

const C_PROD = numberRow({ id: 'c-prod', name: 'Número Produção' });
const C_LOG = numberRow({ id: 'c-log', name: 'Número Logística' });
// Davi é de Produção e foi remanejado para a Logística na Noite de 21/10.
const davi = dayPerson({
  id: 'davi',
  name: 'Davi',
  ...onShift(NOITE),
  exceptions: [
    {
      ...vacation,
      id: 'ex-log',
      kind: 'OTHER_SECTOR',
      sectorId: LOG,
      shiftId: NOITE.id,
    },
  ],
});

describe('envio com finalidade — área do destinatário e agendamento', () => {
  it.each([
    ['em serviço (aviso de turno) → Logística', {}, LOG, 'c-log'],
    [
      'vinculada (alinhamento) → Produção',
      { purpose: 'alignment', base: 'assigned' },
      PROD,
      'c-prod',
    ],
  ] as const)(
    'destinatário sai pela área do sectorId da entrada; remanejado na vinculada pela área do vínculo: %s',
    async (_caso, over, area, channelId) => {
      givenNumbers(h, { [PROD]: C_PROD, [LOG]: C_LOG });
      h.repo.loadDayPeople.mockResolvedValue([davi]);
      await send(body(over, { sectorIds: [PROD, LOG] }));
      expect(created().recipients).toMatchObject([
        { userId: 'davi', sectorId: area, channelId, status: 'QUEUED' },
      ]);
      expect(created().audienceExcluded).toEqual([]);
    },
  );

  it('início do turno grava schedulePolicy nulo e destinatários SCHEDULED', async () => {
    await send(body({ when: 'shift_start' }, { shiftIds: [NOITE.id] }));
    expect(created()).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      purpose: 'SHIFT_NOTICE',
      roster: null,
    });
    expect(created()).not.toHaveProperty('schedulePolicy');
    expect(created().recipients.map((r) => r.status)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
    ]);
    expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  });
});

describe('envio com finalidade — trilha (GF12)', () => {
  it('aceite 19: trilha dispatch e schedule com purpose e base, sem nome, telefone, texto, local nem motivo', async () => {
    await send(body({ purpose: 'meeting', activity: ACTIVITY }));
    await send(body({ purpose: 'urgency', urgencyReason: REASON }));
    await send(body({ when: 'shift_start' }, { shiftIds: [NOITE.id] }));
    expect(h.audit.log.mock.calls.map((c) => [c[0], c[3]])).toEqual([
      [
        'team_whatsapp.dispatch',
        expect.objectContaining({ purpose: 'meeting', base: 'assigned' }),
      ],
      [
        'team_whatsapp.dispatch',
        expect.objectContaining({ purpose: 'urgency', base: 'on_duty' }),
      ],
      [
        'team_whatsapp.schedule',
        expect.objectContaining({ purpose: 'shift_notice', base: 'on_duty' }),
      ],
    ]);
    const logged = JSON.stringify(h.audit.log.mock.calls);
    for (const secret of [
      'Ana',
      'João',
      ana.phoneE164,
      joao.phoneE164,
      TEXT,
      PLACE,
      REASON,
    ])
      expect(logged).not.toContain(secret);
  });
});

describe('envio a uma pessoa (GF1)', () => {
  it('alvo pessoa continua como hoje', async () => {
    h.repo.findTargetUser.mockResolvedValue(member({ id: 'ana', name: 'Ana' }));
    await h.service.dispatch(ADMIN.id, {
      text: TEXT,
      target: { type: 'user', userId: 'ana' },
    });
    expect(created()).toMatchObject({ targetType: 'USER', targetLabel: 'Ana' });
    expect(created()).not.toHaveProperty('purpose');
    expect(created()).not.toHaveProperty('rosterDate');
    expect(h.audit.log.mock.calls[0][3]).toEqual({
      actorId: ADMIN.id,
      targetType: 'USER',
      targetId: 'ana',
      channelIds: ['c1'],
      queued: 1,
      skipped: 0,
    });
  });
});
