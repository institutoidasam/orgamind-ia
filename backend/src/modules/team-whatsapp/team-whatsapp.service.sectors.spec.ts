import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamActor } from './team-whatsapp.policy';
import {
  createTeamDispatchSchema,
  type CreateTeamDispatchInput,
} from './dto/create-team-dispatch.dto';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import {
  ADMIN,
  MANAGER,
  createHarness,
  SHIFT_FIRST,
  dayPerson,
  givenNumber,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

// T8b (C5/C6): alvo setor com vários setores e filtro de nível. Noite de 21/10
// começa às 22:00 de Manaus = 2026-10-22T02:00Z.
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const DATE = '2026-10-21';
const COORD = { id: 'lv-coord', name: 'Coordenador' };
const ANALISTA = { id: 'lv-ana', name: 'Analista' };
const SECTORS = new Map(
  [
    sector({ id: 'ti', name: 'TI' }),
    sector({ id: 'op', name: 'Operação' }),
    sector({ id: 'rh', name: 'RH' }),
  ].map((s) => [s.id, s]),
);
const OP_MANAGER: TeamActor = { ...MANAGER, managedSectorIds: ['op'] };

const person = (
  id: string,
  sectorId: string | null,
  level: { id: string; name: string } | null,
) =>
  dayPerson({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    sectorId,
    sector: sectorId ? { isActive: true } : null,
    levelId: level?.id ?? null,
    level,
    ...onShift(NOITE),
  });
// TI: Ana (Coordenador), Bruno (Analista), Carla (sem nível); Operação: Davi
// (Coordenador), Eva (sem nível); Fábio é do RH; Gil não tem setor.
const PEOPLE = [
  person('ana', 'ti', COORD),
  person('bruno', 'ti', ANALISTA),
  person('carla', 'ti', null),
  person('davi', 'op', COORD),
  person('eva', 'op', null),
  person('fabio', 'rh', COORD),
  person('gil', null, null),
];

type SectorTarget = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;
type SectorExtra = Partial<Omit<SectorTarget, 'type' | 'date'>>;
const body = (extra: SectorExtra, when: 'now' | 'shift_start' = 'now') => ({
  channelId: 'c1',
  text: 'Oi',
  when,
  target: {
    type: 'sector' as const,
    sectorIds: ['ti', 'op'],
    date: DATE,
    shiftIds: [NOITE.id],
    ...extra,
  },
});
const send = (extra: SectorExtra, actorId = ADMIN.id) =>
  h.service.dispatch(actorId, body(extra));
const created = () => h.repo.createDispatch.mock.calls[0][0];
const recipientsOf = () =>
  created().recipients.map((r) => [
    r.userId,
    r.sectorId,
    r.sectorName,
    r.levelName,
  ]);
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
  expectNothingCreated();
};

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  h = createHarness();
  givenNumber(h);
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(SECTORS.get(id) ?? null),
  );
  h.repo.listActiveShifts.mockResolvedValue([NOITE]);
  h.repo.loadDayPeople.mockImplementation((sectorId) =>
    Promise.resolve(PEOPLE.filter((p) => p.sectorId === sectorId)),
  );
  // Ativos por sortOrder: Coordenador antes de Analista.
  h.levels.listActive.mockResolvedValue([COORD, ANALISTA]);
});
afterEach(() => {
  vi.useRealTimers();
});

// Filtro de nível (C5) sobre TI + Operação na Noite: quem recebe e o rótulo.
const filters: [string, SectorExtra, string[], string][] = [
  [
    'withoutLevel sozinho envia só a quem não tem nível',
    { withoutLevel: true },
    ['eva', 'carla'],
    'Operação, TI · Sem nível · Noite · 21/10',
  ],
  [
    // GC12: "Sem nível" por último (quem ordena é o chamador do rótulo).
    'Coordenador + Sem nível juntos',
    { withoutLevel: true, levelIds: [COORD.id] },
    ['davi', 'eva', 'ana', 'carla'],
    'Operação, TI · Coordenador, Sem nível · Noite · 21/10',
  ],
  [
    'sem filtro de nível envia a todos dos setores',
    { levelIds: [] },
    ['davi', 'eva', 'ana', 'bruno', 'carla'],
    'Operação, TI · Noite · 21/10',
  ],
  [
    // GC12: níveis pelo sortOrder do cadastro, não pela ordem do pedido.
    'níveis do rótulo pelo sortOrder, não pela ordem do pedido',
    { levelIds: [ANALISTA.id, COORD.id] },
    ['davi', 'ana', 'bruno'],
    'Operação, TI · Coordenador, Analista · Noite · 21/10',
  ],
];

describe('vários setores e nível', () => {
  it('TI + Operação + Coordenador: destinatários só os coordenadores dos dois, sectorName de cada um, levelName Coordenador', async () => {
    await send({ levelIds: [COORD.id] });
    expect(recipientsOf()).toEqual([
      ['davi', 'op', 'Operação', 'Coordenador'],
      ['ana', 'ti', 'TI', 'Coordenador'],
    ]);
    expect(created()).toMatchObject({
      targetType: 'SECTOR',
      // C6: o primeiro setor pela ordem do rótulo (nome).
      targetId: 'op',
      targetLabel: 'Operação, TI · Coordenador · Noite · 21/10',
      sectors: [
        { sectorId: 'op', sectorName: 'Operação' },
        { sectorId: 'ti', sectorName: 'TI' },
      ],
    });
    expect(
      created().roster?.working.map((p) => [p.name, p.sectorName, p.levelName]),
    ).toEqual([
      ['Davi', 'Operação', 'Coordenador'],
      ['Ana', 'TI', 'Coordenador'],
    ]);
  });

  it.each(filters)('%s', async (_caso, filter, userIds, label) => {
    await send(filter);
    expect(created().recipients.map((r) => r.userId)).toEqual(userIds);
    expect(created().targetLabel).toBe(label);
  });
});

describe('apelido sectorId (D7)', () => {
  it('body com sectorId sozinho = sectorIds [sectorId]', async () => {
    const input = createTeamDispatchSchema.parse({
      channelId: 'c1',
      text: 'Oi',
      target: { type: 'sector', sectorId: 'op', date: DATE },
    });
    await h.service.dispatch(ADMIN.id, input);
    expect(h.repo.findSector.mock.calls).toEqual([['op']]);
    expect(created()).toMatchObject({
      targetId: 'op',
      targetLabel: 'Operação · todos os turnos · 21/10',
      sectors: [{ sectorId: 'op', sectorName: 'Operação' }],
    });
    expect(recipientsOf()).toEqual([
      ['davi', 'op', 'Operação', 'Coordenador'],
      ['eva', 'op', 'Operação', null],
    ]);
  });
});

describe('recusas', () => {
  it('gestor de Operação pedindo Operação + TI → 403 antes de turno e seleção', async () => {
    h.repo.findActor.mockResolvedValue(OP_MANAGER);
    await rejectsWith(
      send(
        { sectorIds: ['op', 'ti'], shiftIds: ['nope'], userIds: ['ana'] },
        OP_MANAGER.id,
      ),
      'team_whatsapp.forbidden',
    );
    expect(h.repo.listActiveShifts.mock.calls).toHaveLength(0);
    expect(h.levels.listActive.mock.calls).toHaveLength(0);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
  });

  it.each([
    ['inexistente', 'lv-nope'],
    ['inativo', 'lv-old'],
  ])(
    'nível inválido → 422 invalid_level sem efeito (%s)',
    async (_caso, levelId) => {
      await rejectsWith(
        send({ levelIds: [COORD.id, levelId] }),
        'team_whatsapp.invalid_level',
      );
      // Níveis antes da lista refeita (C5).
      expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    },
  );

  it.each([
    ['não coordenador', 'bruno'],
    ['pessoa de setor fora do pedido', 'fabio'],
    ['pessoa sem setor', 'gil'],
  ])(
    'seleção fora da lista → 422 invalid_selection sem efeito (%s)',
    async (_caso, outsider) => {
      await rejectsWith(
        send({ levelIds: [COORD.id], userIds: ['ana', outsider] }),
        'team_whatsapp.invalid_selection',
      );
    },
  );
});

describe('agendar vários setores', () => {
  it('agendar TI + Operação no início da Noite grava SCHEDULED só para a lista conferida, com sectors [Operação, TI]', async () => {
    const out = await h.service.dispatch(
      ADMIN.id,
      body({ userIds: ['ana', 'eva'] }, 'shift_start'),
    );
    expect(created()).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      targetId: 'op',
      targetLabel: 'Operação, TI · Noite · 21/10 · seleção de 2',
      sectors: [
        { sectorId: 'op', sectorName: 'Operação' },
        { sectorId: 'ti', sectorName: 'TI' },
      ],
    });
    expect(
      created().recipients.map((r) => [r.userId, r.sectorName, r.status]),
    ).toEqual([
      ['eva', 'Operação', 'SCHEDULED'],
      ['ana', 'TI', 'SCHEDULED'],
    ]);
    expect(out).toMatchObject({ queued: 0, scheduled: 2 });
    expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  });
});

// D9: Dia + Noite no mesmo envio. Lia (TI, Dia) e Ana (TI, Noite); Davi (Operação,
// Noite); Bruno é do TI, mas na data trabalha em Operação (Dia, "Outro setor"):
// o repositório o devolve nas duas listas e ele conta uma vez, em Operação.
const DIA = {
  id: 'shift_day',
  name: 'Dia',
  startTime: '06:00',
  endTime: '14:00',
};
const BORROWED: ScheduleExceptionInput = {
  id: 'ex-op',
  kind: 'OTHER_SECTOR',
  startDate: DATE,
  endDate: DATE,
  shiftId: DIA.id,
  sectorId: 'op',
};
const inShift = (id: string, sectorId: string, shift: typeof DIA) =>
  dayPerson({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    sectorId,
    sector: { isActive: true },
    ...onShift(shift),
  });
const DIA_NOITE = [
  inShift('lia', 'ti', DIA),
  inShift('ana', 'ti', NOITE),
  inShift('davi', 'op', NOITE),
  inShift('eva', 'op', SHIFT_FIRST),
  { ...inShift('bruno', 'ti', NOITE), exceptions: [BORROWED] },
];

const givenDiaNoite = () => {
  h.repo.listActiveShifts.mockResolvedValue([DIA, NOITE, SHIFT_FIRST]);
  h.repo.loadDayPeople.mockResolvedValue(DIA_NOITE);
};
const sendBoth = () => send({ shiftIds: [NOITE.id, DIA.id] });

describe('vários turnos no mesmo envio (D9)', () => {
  beforeEach(givenDiaNoite);

  it('Dia + Noite em dois setores conta cada pessoa uma vez, sem quem é de outro turno', async () => {
    await sendBoth();
    expect(recipientsOf()).toEqual([
      ['davi', 'op', 'Operação', null],
      ['bruno', 'op', 'Operação', null],
      ['ana', 'ti', 'TI', null],
      ['lia', 'ti', 'TI', null],
    ]);
  });

  it('rótulo pela ordem dos turnos ativos e, com dois turnos, o envio grava turno null', async () => {
    await sendBoth();
    expect(created()).toMatchObject({
      targetLabel: 'Operação, TI · Dia, Noite · 21/10',
      shiftId: null,
      shiftName: null,
      shiftStartTime: null,
      shiftEndTime: null,
    });
    // Cada destinatário guarda o turno que a pessoa tem no dia.
    expect(created().recipients.map((r) => [r.userId, r.shiftName])).toEqual([
      ['davi', 'Noite'],
      ['bruno', 'Dia'],
      ['ana', 'Noite'],
      ['lia', 'Dia'],
    ]);
  });
});

describe('vários turnos: recusas sem efeito (D9)', () => {
  beforeEach(givenDiaNoite);

  it('seleção só vale dentro dos turnos pedidos (lista conferida = enviada)', async () => {
    await rejectsWith(
      send({ shiftIds: [NOITE.id, DIA.id], userIds: ['lia', 'eva'] }),
      'team_whatsapp.invalid_selection',
    );
  });

  it('um turno inativo entre os pedidos → 422 invalid_shift antes de carregar a escala', async () => {
    await rejectsWith(
      send({ shiftIds: [NOITE.id, 'shift_old'] }),
      'team_whatsapp.invalid_shift',
    );
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    expect(h.levels.listActive.mock.calls).toHaveLength(0);
  });
});
