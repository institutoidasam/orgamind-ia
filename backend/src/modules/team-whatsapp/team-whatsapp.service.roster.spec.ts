import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  teamPersonRouteResponseSchema,
  teamRosterResponseSchema,
  teamTargetsResponseSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import { RosterQueryDto } from './dto/roster-query.dto';
import type { TeamActor } from './team-whatsapp.policy';
import {
  ADMIN,
  NO_SNAPSHOT,
  PHONE,
  SHIFT_FIRST,
  SHIFT_SECOND,
  createHarness,
  dayPerson,
  givenNumber,
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
  hasAccess: true,
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
  // Envio: toda área tem o número `c1`, aberto (a prévia redefine por teste).
  givenNumber(h);
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
  Pick<SectorTarget, 'shiftIds' | 'userIds' | 'includeOff'>
>;
const send = (extra: SectorExtra, actorId = ADMIN.id) =>
  h.service.dispatch(actorId, {
    channelId: 'c1',
    text: 'Oi',
    target: { type: 'sector', sectorIds: [PROD], date: DATE, ...extra },
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
        levels: [],
      });
      expect(teamTargetsResponseSchema.parse(out)).toEqual(out);
    },
  );
});

// Vários setores (C4): TI e Operação, além de Produção e Logística.
const TI = 's-ti';
const OP = 's-op';
const NAMES: Record<string, string> = {
  [TI]: 'TI',
  [OP]: 'Operação',
  [PROD]: 'Produção',
  [LOG]: 'Logística',
};
const COORD = { id: 'lvl-coord', name: 'Coordenador' };
const givenNamedSectors = () => {
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(sector({ id, name: NAMES[id] })),
  );
};

describe('targets.levels (C4)', () => {
  it('targets.levels só ativos: os de listActive, nunca a lista do cadastro', async () => {
    h.repo.listEligibleChannels.mockResolvedValue([]);
    h.repo.listSectors.mockResolvedValue([]);
    h.levels.listActive.mockResolvedValue([COORD]);
    const out = await h.service.targets(ADMIN.id);
    expect(out.levels).toEqual([COORD]);
    expect(h.levels.list.mock.calls).toHaveLength(0);
    expect(teamTargetsResponseSchema.parse(out)).toEqual(out);
  });
});

describe('roster por data', () => {
  it('sectorId sozinho = sectorIds [sectorId]: setor principal sem quem está em outro setor, mais quem vem de fora', async () => {
    const query = RosterQueryDto.schema.parse({ sectorId: PROD, date: DATE });
    const out = await h.service.roster(ADMIN.id, query);
    expect(h.repo.loadDayPeople.mock.calls).toEqual([[PROD, DATE]]);
    expect(out.sectors.map((s) => [s.sectorId, s.name])).toEqual([
      [PROD, 'Produção'],
    ]);
    const work = (shiftId: string, source: string) => ({
      kind: 'WORK',
      sectorId: PROD,
      shiftId,
      source,
    });
    expect(
      out.sectors[0].members.map((m) => [m.id, m.fromOtherSector, m.situation]),
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
      h.service.roster(LOG_MANAGER.id, { sectorIds: [PROD], date: DATE }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
  });
});

describe('roster de vários setores (C4)', () => {
  beforeEach(givenNamedSectors);

  it('roster de TI + Operação devolve sectors por nome com members[].level', async () => {
    const bia = dayPerson({ id: 'bia', name: 'Bia', sectorId: OP });
    const leo = dayPerson({
      id: 'leo',
      name: 'Léo',
      sectorId: TI,
      levelId: COORD.id,
      level: COORD,
    });
    h.repo.loadDayPeople.mockImplementation((id) =>
      Promise.resolve(id === TI ? [leo] : [bia]),
    );
    const out = await h.service.roster(ADMIN.id, {
      sectorIds: [TI, OP],
      date: DATE,
    });
    expect(
      out.sectors.map((s) => [
        s.sectorId,
        s.name,
        s.members.map((m) => [m.id, m.level]),
      ]),
    ).toEqual([
      [OP, 'Operação', [['bia', null]]],
      [TI, 'TI', [['leo', COORD]]],
    ]);
    expect(teamRosterResponseSchema.parse(out)).toEqual(out);
  });

  it('Produção + Logística: cada pessoa aparece em um setor só no dia', async () => {
    const out = await h.service.roster(ADMIN.id, {
      sectorIds: [PROD, LOG],
      date: DATE,
    });
    expect(
      out.sectors.map((s) => [s.name, s.members.map((m) => m.id)]),
    ).toEqual([
      ['Logística', ['davi']],
      ['Produção', ['ana', 'beto', 'joao', 'maria', 'caio']],
    ]);
  });
});

describe('roster de vários setores — política (GC6)', () => {
  beforeEach(givenNamedSectors);

  it('gestor de Operação pedindo roster de Operação + TI → 403 antes de ler pessoas', async () => {
    h.repo.findActor.mockResolvedValue({
      ...LOG_MANAGER,
      managedSectorIds: [OP],
    });
    await expect(
      h.service.roster(LOG_MANAGER.id, { sectorIds: [OP, TI], date: DATE }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.loadDayPeople.mock.calls).toHaveLength(0);
    expect(h.repo.listActiveShifts.mock.calls).toHaveLength(0);
  });
});

describe('seleção fora da escala da data → 422 sem efeito', () => {
  it.each<[string, SectorExtra]>([
    ['Noite + Ana (outro turno)', { shiftIds: [NOITE.id], userIds: ['ana'] }],
    ['Noite + Maria (de férias)', { shiftIds: [NOITE.id], userIds: ['maria'] }],
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
    expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
    expectNothingCreated();
  });

  it.each([
    ['inativo', 'shift_old'],
    ['inexistente', 'nao-existe'],
  ])(
    'shiftId %s → 422 team_whatsapp.invalid_shift, sem createDispatch',
    async (_caso, shiftId) => {
      await expect(
        send({ shiftIds: [shiftId], userIds: ['joao'] }),
      ).rejects.toMatchObject({
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
    await send({ shiftIds: [NOITE.id], userIds: ['joao'] });
    expect(created()).toMatchObject({
      targetLabel: 'Produção · Noite · 21/10 · seleção de 1',
      rosterDate: DATE,
      includeOff: false,
      shiftId: NOITE.id,
      shiftName: 'Noite',
      shiftStartTime: '22:00',
      shiftEndTime: '06:00',
    });
    // T8b (C6): a foto leva o setor em que a pessoa entrou e o nível na hora.
    const person = (userId: string, name: string, jobTitle: string) => ({
      userId,
      name,
      jobTitle,
      sectorName: 'Produção',
      levelName: null,
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

// Número de cada área e estado ao vivo (C2, D2, D7).
const EXP = 's3';
const GBR = {
  id: 'ch-gbr',
  name: 'GBR',
  phoneE164: '+5592999991111',
  provider: 'GOZAP' as const,
  evolutionInstanceName: null,
};
const OBSERVED_AT = new Date('2026-10-21T15:00:00.000Z');
const liveCheck = (channelId: string, state: 'open' | 'close' | 'unknown') => ({
  channelId,
  state,
  checkedAt: OBSERVED_AT,
});
const givenChannels = (byId: Record<string, typeof GBR | null>) => {
  h.repo.findSectorChannels.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, byId[id] ?? null]))),
  );
};
const channelsOf = async (sectorIds: string[]) => {
  const out = await h.service.roster(ADMIN.id, { sectorIds, date: DATE });
  return out.sectors.map((s) => [s.sectorId, s.channel] as const);
};
const givenLive = (ch: typeof GBR, state: 'open' | 'close' | 'unknown') =>
  h.live.checkMany.mockResolvedValue(
    new Map([[ch.id, liveCheck(ch.id, state)]]),
  );
const GBR_PREVIEW = {
  id: GBR.id,
  name: 'GBR',
  phoneE164: GBR.phoneE164,
  provider: 'GOZAP',
  live: { state: 'open', checkedAt: OBSERVED_AT.toISOString() },
};

describe('roster — número de cada área (C2)', () => {
  beforeEach(() => {
    givenNamedSectors();
    givenLive(GBR, 'open');
  });

  it('setor com número → channel com live.state open e checkedAt ISO, sem a instância Evolution', async () => {
    givenChannels({ [PROD]: GBR });
    const out = await h.service.roster(ADMIN.id, {
      sectorIds: [PROD],
      date: DATE,
    });
    expect(out.sectors[0].channel).toEqual(GBR_PREVIEW);
    expect(teamRosterResponseSchema.parse(out)).toEqual(out);
  });

  it('setor com canal inativo ou fora do envio (sem número efetivo) → channel null e nenhuma consulta', async () => {
    givenChannels({});
    expect(await channelsOf([PROD])).toEqual([[PROD, null]]);
    expect(h.live.checkMany.mock.calls).toHaveLength(0);
  });

  it('Logística e Expedição no mesmo número → checkMany com um canal; Produção sem número', async () => {
    NAMES[EXP] = 'Expedição';
    givenChannels({ [LOG]: GBR, [EXP]: GBR });
    const out = await channelsOf([LOG, EXP, PROD]);
    expect(h.live.checkMany.mock.calls).toEqual([
      [[{ id: GBR.id, provider: 'GOZAP', evolutionInstanceName: null }]],
    ]);
    expect(out.map(([id, c]) => [id, c?.id ?? null])).toEqual([
      [EXP, GBR.id],
      [LOG, GBR.id],
      [PROD, null],
    ]);
  });

  it.each(['close', 'unknown'] as const)(
    'número %s aparece como %s na prévia, nunca como liberado',
    async (state) => {
      givenChannels({ [PROD]: GBR });
      givenLive(GBR, state);
      const [[, channel]] = await channelsOf([PROD]);
      expect(channel?.live.state).toBe(state);
    },
  );
});

const EXPEDICAO = { id: EXP, name: 'Expedição', isActive: true };
const EXP_REF = { id: EXP, name: 'Expedição' };
const NO_ROUTE = { userId: 'nelson', sector: null, channel: null };
const GOZAP_EXP = { ...GBR, id: 'ch-exp', name: 'Expedição GoZap' };
const nelson = dayPerson({ id: 'nelson', name: 'Nelson', sectorId: LOG });
const LOG_MANAGER_OF_PROD = { ...LOG_MANAGER, managedSectorIds: [PROD] };

function primePersonRoute(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T15:00:00Z'));
  h.repo.findTargetUser.mockResolvedValue(nelson);
  h.repo.loadPersonSchedule.mockResolvedValue({ cycle: null, exceptions: [] });
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(id === EXP ? EXPEDICAO : sector({ id, name: 'Logística' })),
  );
  givenChannels({ [EXP]: GOZAP_EXP });
  givenLive(GOZAP_EXP, 'open');
}

// Nelson, do cadastro em Logística, remanejado hoje para a Expedição.
const givenMovedToExpedicao = () =>
  h.repo.loadPersonSchedule.mockResolvedValue({
    cycle: null,
    exceptions: [otherSector(EXP, SHIFT_FIRST.id)],
  });

describe('personRoute (C2): número da área onde a pessoa atua hoje', () => {
  beforeEach(primePersonRoute);

  it('remanejado hoje para Expedição → sector Expedição e o número dela', async () => {
    givenMovedToExpedicao();
    const out = await h.service.personRoute(ADMIN.id, 'nelson');
    expect(out).toMatchObject({
      userId: 'nelson',
      sector: EXP_REF,
      channel: { id: GOZAP_EXP.id, live: { state: 'open' } },
    });
    expect(h.repo.findSectorChannels.mock.calls).toEqual([[[EXP]]]);
    expect(teamPersonRouteResponseSchema.parse(out)).toEqual(out);
  });

  it('sem setor no cadastro nem na escala → sector e channel null, sem consultar o provedor', async () => {
    h.repo.findTargetUser.mockResolvedValue({ ...nelson, sectorId: null });
    expect(await h.service.personRoute(ADMIN.id, 'nelson')).toEqual(NO_ROUTE);
    expect(h.live.checkMany.mock.calls).toHaveLength(0);
  });

  it('sem exceção, vale o setor do cadastro; sem número → channel null', async () => {
    h.repo.findSector.mockResolvedValue(sector({ id: LOG, name: 'Logística' }));
    expect(await h.service.personRoute(ADMIN.id, 'nelson')).toEqual({
      userId: 'nelson',
      sector: { id: LOG, name: 'Logística' },
      channel: null,
    });
  });

  it('gestor de outro setor → 403 team_whatsapp.forbidden, sem ler escala nem consultar o provedor', async () => {
    h.repo.findActor.mockResolvedValue(LOG_MANAGER_OF_PROD);
    await expect(
      h.service.personRoute(LOG_MANAGER.id, 'nelson'),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.loadPersonSchedule.mock.calls).toHaveLength(0);
    expect(h.live.checkMany.mock.calls).toHaveLength(0);
  });

  it('personSectorOn(userId, data) → o setor naquela data; pessoa inexistente → null', async () => {
    givenMovedToExpedicao();
    expect(await h.service.personSectorOn('nelson', DATE)).toEqual(EXP_REF);
    h.repo.findTargetUser.mockResolvedValue(null);
    expect(await h.service.personSectorOn('x', DATE)).toBeNull();
  });
});
