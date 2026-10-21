import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  teamRosterResponseSchema,
  teamTargetsResponseSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import type { TeamActor } from './team-whatsapp.policy';
import {
  ADMIN,
  NO_SNAPSHOT,
  PHONE,
  SHIFT_FIRST,
  SHIFT_SECOND,
  createHarness,
  dayPerson,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

// Produção (s1) em 21/10: João no ciclo da Noite, Maria de férias, Ana no turno
// do cadastro, Beto sem escala nem turno, Caio (Logística) emprestado à Noite de
// Produção e Davi (Produção) emprestado à Logística.
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const DATE = '2026-10-21';
const PROD = 's1';
const LOG = 's2';
const LOG_MANAGER: TeamActor = {
  id: 'g',
  role: 'OPERATOR',
  isActive: true,
  managedSectorIds: [LOG],
};
const otherSector = (
  sectorId: string,
  shiftId: string,
): ScheduleExceptionInput => ({
  id: `ex-${sectorId}`,
  kind: 'OTHER_SECTOR',
  startDate: DATE,
  endDate: DATE,
  shiftId,
  sectorId,
});
const joao = dayPerson({
  id: 'joao',
  name: 'João',
  jobTitle: 'Operador',
  cycle: { startDate: '2026-10-01', cycleLength: 1, days: [NOITE.id] },
});
const maria = dayPerson({
  id: 'maria',
  name: 'Maria',
  jobTitle: 'Técnica',
  ...onShift(NOITE),
  exceptions: [
    {
      id: 'ex-ferias',
      kind: 'VACATION',
      startDate: '2026-10-20',
      endDate: '2026-10-24',
      shiftId: null,
      sectorId: null,
    },
  ],
});
const ana = dayPerson({ id: 'ana', name: 'Ana', ...onShift(SHIFT_FIRST) });
const beto = dayPerson({ id: 'beto', name: 'Beto' });
const caio = dayPerson({
  id: 'caio',
  name: 'Caio',
  jobTitle: 'Mecânico',
  sectorId: LOG,
  exceptions: [otherSector(PROD, NOITE.id)],
});
const davi = dayPerson({
  id: 'davi',
  name: 'Davi',
  exceptions: [otherSector(LOG, SHIFT_FIRST.id)],
});

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(
      sector({ id, name: id === PROD ? 'Produção' : 'Logística' }),
    ),
  );
  h.repo.listActiveShifts.mockResolvedValue([SHIFT_FIRST, SHIFT_SECOND, NOITE]);
  h.repo.loadDayPeople.mockResolvedValue([joao, maria, ana, beto, caio, davi]);
});
afterEach(() => {
  vi.useRealTimers();
});

type SectorTarget = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;
type SectorExtra = Partial<
  Pick<SectorTarget, 'shiftId' | 'userIds' | 'includeOff'>
>;
const send = (extra: SectorExtra, actorId = ADMIN.id) =>
  h.service.dispatch(actorId, {
    channelId: 'c1',
    text: 'Oi',
    target: { type: 'sector', sectorId: PROD, date: DATE, ...extra },
  });
const created = () => h.repo.createDispatch.mock.calls[0][0];
const recipients = () =>
  created().recipients.map((r) => [r.userName, r.shiftId, r.shiftName]);
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
const FORBIDDEN = { code: 'team_whatsapp.forbidden', status: 403 };

describe('targets em Manaus', () => {
  const PRODUCAO = { id: PROD, name: 'Produção', code: 'PRD' };
  it.each([
    ['2026-10-22T01:00:00Z', '2026-10-21', null],
    ['2026-10-22T06:00:00Z', '2026-10-22', { date: DATE, shift: NOITE }],
  ])(
    'em %s → today %s e a Noite em andamento',
    async (iso, today, inProgress) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
      h.repo.listEligibleChannels.mockResolvedValue([]);
      h.repo.listSectors.mockResolvedValue([PRODUCAO]);
      const out = await h.service.targets(ADMIN.id);
      // Igualdade exata: `sectors` sem `members`; `shifts` = ativos do repositório.
      expect(out).toEqual({
        today,
        inProgress,
        shifts: [SHIFT_FIRST, SHIFT_SECOND, NOITE],
        channels: [],
        sectors: [PRODUCAO],
      });
      expect(teamTargetsResponseSchema.parse(out)).toEqual(out);
    },
  );
});

describe('roster por data', () => {
  it('21/10: setor principal sem quem está em outro setor, mais quem vem de fora', async () => {
    const out = await h.service.roster(ADMIN.id, {
      sectorId: PROD,
      date: DATE,
    });
    expect(h.repo.loadDayPeople.mock.calls).toEqual([[PROD, DATE]]);
    const work = (shiftId: string, source: string) => ({
      kind: 'WORK',
      sectorId: PROD,
      shiftId,
      source,
    });
    expect(
      out.members.map((m) => [m.id, m.fromOtherSector, m.situation]),
    ).toEqual([
      ['ana', false, work(SHIFT_FIRST.id, 'PROFILE')],
      ['beto', false, { kind: 'NONE' }],
      ['joao', false, work(NOITE.id, 'CYCLE')],
      [
        'maria',
        false,
        { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' },
      ],
      ['caio', true, work(NOITE.id, 'EXCEPTION')],
    ]);
    expect(out.shiftStarts).toContainEqual({
      shiftId: NOITE.id,
      startsAt: '2026-10-22T02:00:00.000Z',
    });
    expect(teamRosterResponseSchema.parse(out)).toEqual(out);
  });

  it('gestor de Logística pedindo Produção → 403', async () => {
    h.repo.findActor.mockResolvedValue(LOG_MANAGER);
    await expect(
      h.service.roster(LOG_MANAGER.id, { sectorId: PROD, date: DATE }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
  });
});

describe('seleção fora da escala da data → 422 sem efeito', () => {
  it.each<[string, SectorExtra]>([
    ['Noite + Ana (outro turno)', { shiftId: NOITE.id, userIds: ['ana'] }],
    ['Noite + Maria (de férias)', { shiftId: NOITE.id, userIds: ['maria'] }],
    ['todos sem includeOff + Maria', { userIds: ['maria'] }],
    ['todos + Davi (outro setor no dia)', { userIds: ['davi'] }],
    ['todos + Beto (sem escala)', { userIds: ['beto'] }],
    ['id inexistente', { userIds: ['joao', 'nao-existe'] }],
  ])('%s', async (_caso, extra) => {
    await expect(send(extra)).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_selection',
      status: 422,
    });
    expectNothingCreated();
  });
});

describe('política e turno antes da seleção', () => {
  it('gestor de Logística com sectorId Produção e userIds [caio] → 403 antes da seleção', async () => {
    h.repo.findActor.mockResolvedValue(LOG_MANAGER);
    await expect(
      send({ userIds: ['caio'] }, LOG_MANAGER.id),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.listActiveShifts.mock.calls).toHaveLength(0);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    expect(h.repo.findChannel.mock.calls).toHaveLength(0);
    expectNothingCreated();
  });

  it.each([
    ['inativo', 'shift_old'],
    ['inexistente', 'nao-existe'],
  ])(
    'shiftId %s → 422 team_whatsapp.invalid_shift, sem createDispatch',
    async (_caso, shiftId) => {
      await expect(send({ shiftId, userIds: ['joao'] })).rejects.toMatchObject({
        code: 'team_whatsapp.invalid_shift',
        status: 422,
      });
      expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
      expectNothingCreated();
    },
  );
});

describe('todos os turnos e incluir folga', () => {
  it('todos alcança João, Ana e Caio, sem Beto nem Maria', async () => {
    await send({});
    expect(recipients()).toEqual([
      ['Ana', SHIFT_FIRST.id, '1º turno'],
      ['João', NOITE.id, 'Noite'],
      ['Caio', NOITE.id, 'Noite'],
    ]);
    expect(created()).toMatchObject({
      ...NO_SNAPSHOT,
      targetLabel: 'Produção · todos os turnos · 21/10',
      includeOff: false,
    });
  });

  it('todos + includeOff acrescenta Maria, destinatária com shiftName null', async () => {
    await send({ includeOff: true });
    expect(recipients()).toHaveLength(4);
    expect(recipients()).toContainEqual(['Maria', null, null]);
    expect(created().includeOff).toBe(true);
  });
});

describe('foto e rótulo', () => {
  it('Noite + [joao] em 21/10 grava rótulo, data, foto sem telefone e o turno do filtro', async () => {
    await send({ shiftId: NOITE.id, userIds: ['joao'] });
    expect(created()).toMatchObject({
      targetLabel: 'Produção · Noite · 21/10 · seleção de 1',
      rosterDate: DATE,
      includeOff: false,
      shiftId: NOITE.id,
      shiftName: 'Noite',
      shiftStartTime: '22:00',
      shiftEndTime: '06:00',
    });
    const person = (userId: string, name: string, jobTitle: string) => ({
      userId,
      name,
      jobTitle,
    });
    expect(created().roster).toEqual({
      working: [
        {
          ...person('joao', 'João', 'Operador'),
          shiftName: 'Noite',
          reason: null,
        },
        {
          ...person('caio', 'Caio', 'Mecânico'),
          shiftName: 'Noite',
          reason: null,
        },
      ],
      off: [
        {
          ...person('maria', 'Maria', 'Técnica'),
          shiftName: null,
          reason: 'VACATION',
        },
      ],
    });
    const foto = JSON.stringify(created().roster);
    expect(foto).not.toMatch(/phone/i);
    expect(foto).not.toContain(PHONE);
  });
});

describe('alvo pessoa não muda', () => {
  it('sem foto nem escala; destinatário com o turno do cadastro', async () => {
    h.repo.findTargetUser.mockResolvedValue(maria);
    await h.service.dispatch(ADMIN.id, {
      channelId: 'c1',
      text: 'Oi',
      target: { type: 'user', userId: 'maria' },
    });
    expect(created()).toMatchObject({ ...NO_SNAPSHOT, targetLabel: 'Maria' });
    expect(created()).not.toHaveProperty('rosterDate');
    expect(recipients()).toEqual([['Maria', NOITE.id, 'Noite']]);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
  });
});
