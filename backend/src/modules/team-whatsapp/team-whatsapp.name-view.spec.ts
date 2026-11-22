import { beforeEach, describe, expect, it } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type { AuditService } from '../../shared/audit/audit.service';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import type { TeamActor } from './team-whatsapp.policy';
import type {
  DispatchDetailRow,
  DispatchRecipientRow,
  ScheduledRow,
  TeamDispatchRow,
  TeamMember,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import {
  ADMIN,
  MANAGER,
  PHONE,
  SHIFT_FIRST,
  createHarness,
  dayPerson,
  givenNumber,
  givenSector,
  member,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';
import { withAudienceKey } from './team-whatsapp.sector-send.test-fixtures';

// D11: pessoa criada de contato sem nome tem o número como nome. Sem a chave
// `telefone.ver_completo` a SAÍDA mostra a máscara; o que é gravado fica real.
const NUM = PHONE;
const MASKED = '•••• 4567';
// Ordem real x ordem da máscara (últimos 4 dígitos): A1 < B < A2 no número, B < A no 0001/0002.
const A1 = '+5592991110002';
const A2 = '+5592993330002';
const B = '+5592992220001';
const DATE = '2026-10-21';
const PAGE = { page: 1, pageSize: 20 };

const SUPERVISOR: TeamActor = {
  ...actorWith('SUPERVISOR', { id: 'sv' }),
  managedSectorIds: ['s1'],
};
const NO_KEY: TeamActor = {
  ...actorWith('OPERATOR', { id: 'sk', revoke: ['telefone.ver_completo'] }),
  managedSectorIds: ['s1'],
};
type Viewer = [label: string, actor: TeamActor, full: boolean];
const OPERATOR: Viewer = ['OPERATOR (matriz inicial)', MANAGER, true];
const WITHOUT: Viewer = ['OPERATOR sem a chave', NO_KEY, false];
const ALL_VIEWERS: Viewer[] = [
  ['ADMIN', ADMIN, true],
  ['SUPERVISOR (matriz inicial)', SUPERVISOR, true],
  OPERATOR,
  WITHOUT,
];
const PAIR: Viewer[] = [OPERATOR, WITHOUT];

const shown = (full: boolean) => (full ? NUM : MASKED);
// O id nunca carrega o número: o JSON da resposta inteira não pode conter os dígitos.
const idOf = (name: string) => `p${name.slice(-4)}`;
/** Sem a chave, nenhum dos números aparece na resposta inteira (com ou sem o `+`). */
const expectNoNumber = (out: unknown, full: boolean) => {
  if (full) return;
  const json = JSON.stringify(out);
  for (const n of [NUM, A1, A2, B]) expect(json).not.toContain(n.slice(1));
};

let h: Harness;
let repo: DeepMockProxy<TeamWhatsappRepository>;
let results: TeamWhatsappResultsService;
beforeEach(() => {
  h = createHarness();
  givenNumber(h);
  h.repo.findSector.mockResolvedValue(sector());
  repo = mockDeep<TeamWhatsappRepository>();
  results = new TeamWhatsappResultsService(repo);
});

describe('nome-telefone na saída — roster', () => {
  const roster = async (actor: TeamActor, names: string[]) => {
    h.repo.findActor.mockResolvedValue(actor);
    h.repo.loadDayPeople.mockResolvedValue(
      names.map((name) => dayPerson({ id: idOf(name), name })),
    );
    return h.service.roster(actor.id, { sectorIds: ['s1'], date: DATE });
  };
  const ids = async (actor: TeamActor, names: string[]) =>
    (await roster(actor, names)).sectors[0].members.map((m) => m.id);

  it.each(ALL_VIEWERS)(
    '%s: members[].name sai como gravado só com a chave; nome normal nunca muda',
    async (_label, actor, full) => {
      const out = await roster(actor, [NUM, 'Ana']);
      expect(out.sectors[0].members.map((m) => m.name)).toEqual([
        shown(full),
        'Ana',
      ]);
      expectNoNumber(out, full);
    },
  );

  it.each([[A1], [A2]])(
    'sem a chave: ordem pela máscara; trocar o número mantendo os 4 últimos não muda a posição (%s)',
    async (a) => {
      expect(await ids(NO_KEY, [a, B])).toEqual([idOf(B), idOf(a)]);
    },
  );

  it.each<[string, string[]]>([
    [A1, [A1, B]],
    [A2, [B, A2]],
  ])('com a chave: ordem pelo nome real, como hoje (%s)', async (a, order) => {
    expect(await ids(MANAGER, [a, B])).toEqual(order.map(idOf));
  });
});

// Sem telefone no cadastro, o nome é o número que a pessoa tinha: vai para `skipped`.
const noPhone = (id: string, name: string): TeamMember =>
  member({ id, name, phoneE164: null, ...onShift(SHIFT_FIRST) });
const ana = member({ id: 'ana', name: 'Ana', ...onShift(SHIFT_FIRST) });
const toSector = async (actor: TeamActor, people: TeamMember[]) => {
  h.repo.findActor.mockResolvedValue(actor);
  givenSector(h, people);
  const input: CreateTeamDispatchInput = {
    text: 'Oi',
    purpose: 'shift_notice',
    target: { type: 'sector', sectorIds: ['s1'], date: DATE },
  };
  return h.service.dispatch(
    actor.id,
    await withAudienceKey(h, actor.id, input),
  );
};
const saved = () => h.repo.createDispatch.mock.calls[0][0];

describe('nome-telefone na saída — POST do envio, skipped', () => {
  it.each(PAIR)('%s: skipped[].name', async (_label, actor, full) => {
    const people = [noPhone('u1', NUM), noPhone('u2', 'Bia'), ana];
    const out = await toSector(actor, people);
    expect(out.skipped.map((s) => s.name)).toEqual([shown(full), 'Bia']);
    expectNoNumber(out, full);
  });

  it.each<[string, TeamActor, string[]]>([
    ['sem a chave: pela máscara', NO_KEY, ['u2', 'u1']],
    ['com a chave: pelo nome real', MANAGER, ['u1', 'u2']],
  ])('skipped em ordem %s', async (_label, actor, order) => {
    const people = [noPhone('u1', A1), noPhone('u2', B), ana];
    const out = await toSector(actor, people);
    expect(out.skipped.map((s) => s.userId)).toEqual(order);
  });
});

describe('nome-telefone na saída — POST do envio, gravado', () => {
  it('userName real mesmo quando quem envia não tem a chave', async () => {
    await toSector(NO_KEY, [noPhone('u1', NUM), ana]);
    expect(saved().recipients.map((r) => r.userName)).toEqual([NUM, 'Ana']);
  });

  it('alvo pessoa: targetLabel e userName gravados com o nome real, sem a chave', async () => {
    h.repo.findActor.mockResolvedValue(NO_KEY);
    h.repo.findTargetUser.mockResolvedValue(member({ id: 'u1', name: NUM }));
    await h.service.dispatch(NO_KEY.id, {
      text: 'Oi',
      target: { type: 'user', userId: 'u1' },
    });
    expect(saved().targetLabel).toBe(NUM);
    expect(saved().recipients.map((r) => r.userName)).toEqual([NUM]);
  });
});

const dispatchRow = (): TeamDispatchRow => ({
  id: 'd1',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
  targetType: 'USER',
  targetId: 'u1',
  targetLabel: NUM,
  shiftId: null,
  shiftName: null,
  shiftStartTime: null,
  shiftEndTime: null,
  rosterDate: null,
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  purpose: null,
  audienceBase: null,
  activityDate: null,
  activityTime: null,
  activityPlace: null,
  urgencyReason: null,
  author: { id: 'sk', name: NUM, email: null },
  sectors: [],
});
const scheduledRow = (): ScheduledRow => ({
  id: 'd1',
  scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
  rosterDate: new Date('2026-10-21T00:00:00.000Z'),
  targetLabel: NUM,
  shiftId: 'shift_night',
  shiftName: 'Noite',
  shiftStartTime: '22:00',
  shiftEndTime: '06:00',
  author: { id: 'sk', name: NUM, email: null },
  channel: { id: 'c1', name: 'Canal equipe' },
  recipientCount: 2,
});

describe('nome-telefone na saída — histórico e agendados', () => {
  it.each(PAIR)(
    '%s: histórico items[].target.label e author.name',
    async (_label, actor, full) => {
      h.repo.findActor.mockResolvedValue(actor);
      h.repo.listDispatches.mockResolvedValue({
        rows: [dispatchRow()],
        total: 1,
      });
      const out = await h.service.listDispatches(actor.id, PAGE);
      expect(out.items[0].target.label).toBe(shown(full));
      expect(out.items[0].author?.name).toBe(shown(full));
      expectNoNumber(out, full);
    },
  );

  it.each(PAIR)(
    '%s: agendados items[].label e author.name',
    async (_label, actor, full) => {
      const service = new TeamWhatsappScheduleService(
        repo,
        mockDeep<AuditService>(),
        mockDeep<Queue>(),
      );
      repo.findActor.mockResolvedValue(actor);
      repo.listScheduled.mockResolvedValue({
        rows: [scheduledRow()],
        total: 1,
      });
      const out = await service.listScheduled(actor.id, PAGE);
      expect(out.items[0].label).toBe(shown(full));
      expect(out.items[0].author?.name).toBe(shown(full));
      expectNoNumber(out, full);
    },
  );
});

const detailRow = (
  roster: DispatchDetailRow['roster'] = null,
): DispatchDetailRow => ({
  id: 'd1',
  targetLabel: NUM,
  text: 'Reunião às 9h',
  state: 'DISPATCHED',
  createdAt: new Date('2026-11-10T12:00:00.000Z'),
  scheduledFor: null,
  firedAt: null,
  roster,
  rosterDate: null,
  includeOff: false,
  purpose: null,
  audienceBase: null,
  activityDate: null,
  activityTime: null,
  activityPlace: null,
  urgencyReason: null,
  audienceRule: null,
  audienceExcluded: null,
  schedulePolicy: null,
  author: { id: 'sk', name: NUM },
  sectors: [],
});
const photoPerson = (name: string, over: Record<string, unknown> = {}) => ({
  userId: idOf(name),
  name,
  jobTitle: null,
  shiftName: '2º turno',
  reason: null,
  sectorName: 'Financeiro',
  levelName: null,
  ...over,
});
const recipientRow = (): DispatchRecipientRow => ({
  id: 'r1',
  userName: NUM,
  sectorName: 'Financeiro',
  levelName: null,
  shiftName: '2º turno',
  status: 'QUEUED',
  errorCode: null,
  skipReason: null,
  attempts: 0,
  channel: { name: 'GBR', phoneE164: '+559230001111' },
  acceptedAt: null,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
});

const as = (actor: TeamActor) => {
  repo.findActor.mockResolvedValue(actor);
  repo.findDispatchForActor.mockResolvedValue({
    id: 'd1',
    authorId: actor.id,
    targetType: 'USER',
    targetId: 'u1',
    state: 'DISPATCHED',
    sectors: [],
  });
  repo.findDispatchDetail.mockResolvedValue(detailRow());
  repo.countByStatus.mockResolvedValue([]);
  repo.channelsByDispatch.mockResolvedValue([]);
  repo.findRecipientUserIds.mockResolvedValue([]);
  repo.listDispatchRecipients.mockResolvedValue({
    rows: [recipientRow()],
    total: 1,
  });
};
const leftOutOf = async (actor: TeamActor, working: string[]) => {
  as(actor);
  const roster = {
    working: working.map((n) => photoPerson(n)),
    off: [photoPerson(B, { shiftName: null, reason: 'DAY_OFF' })],
  };
  repo.findDispatchDetail.mockResolvedValue(detailRow(roster));
  return results.detail(actor.id, 'd1');
};

describe('nome-telefone na saída — resultado do envio', () => {
  it.each(PAIR)(
    '%s: detalhe targetLabel, author.name e leftOut[].name',
    async (_label, actor, full) => {
      const out = await leftOutOf(actor, [NUM, 'Caio']);
      expect(out.targetLabel).toBe(shown(full));
      expect(out.author?.name).toBe(shown(full));
      expect(out.leftOut.unselected.map((p) => p.name)).toEqual([
        shown(full),
        'Caio',
      ]);
      expect(out.leftOut.off.map((p) => p.name)).toEqual([
        full ? B : '•••• 0001',
      ]);
      expectNoNumber(out, full);
    },
  );

  it.each(PAIR)(
    '%s: destinatários items[].userName',
    async (_label, actor, full) => {
      as(actor);
      const out = await results.recipients(actor.id, 'd1', { ...PAGE });
      expect(out.items.map((i) => i.userName)).toEqual([shown(full)]);
      expectNoNumber(out, full);
    },
  );
});

describe('nome-telefone na saída — ordem do leftOut', () => {
  it.each<[string, string[]]>([
    [A1, [A1, B]],
    [A2, [B, A2]],
  ])(
    'sem a chave: pela máscara, a posição não muda com o número (%s)',
    async (a, stored) => {
      const out = await leftOutOf(NO_KEY, stored);
      expect(out.leftOut.unselected.map((p) => p.userId)).toEqual([
        idOf(B),
        idOf(a),
      ]);
    },
  );

  it('com a chave: a ordem da foto gravada, como hoje', async () => {
    const out = await leftOutOf(MANAGER, [A1, B]);
    expect(out.leftOut.unselected.map((p) => p.name)).toEqual([A1, B]);
  });
});

// Mesma máscara (`•••• 0002`) para as três pessoas; o id é o único que as separa.
// Real: A1 < A2 e `u-z` (A1) < `u-a` (A2) ao contrário do id, para o desempate aparecer.
const A1_SWAPPED = '+5592999990002';
type Person = [id: string, name: string];
const VARIANTS: [string, Person[]][] = [
  [
    'entrada na ordem do nome real',
    [
      ['u-z', A1],
      ['u-a', A2],
    ],
  ],
  [
    'entrada invertida',
    [
      ['u-a', A2],
      ['u-z', A1],
    ],
  ],
  [
    'número real trocado, mesmos 4 últimos',
    [
      ['u-z', A1_SWAPPED],
      ['u-a', A2],
    ],
  ],
];
const orderIn = {
  roster: async (people: Person[]) => {
    h.repo.findActor.mockResolvedValue(NO_KEY);
    h.repo.loadDayPeople.mockResolvedValue(
      people.map(([id, name]) => dayPerson({ id, name })),
    );
    const out = await h.service.roster(NO_KEY.id, {
      sectorIds: ['s1'],
      date: DATE,
    });
    return out.sectors[0].members.map((m) => m.id);
  },
  skipped: async (people: Person[]) => {
    const out = await toSector(NO_KEY, [
      ...people.map(([id, name]) => noPhone(id, name)),
      ana,
    ]);
    return out.skipped.map((s) => s.userId);
  },
  leftOut: async (people: Person[]) => {
    as(NO_KEY);
    const working = people.map(([userId, name]) =>
      photoPerson(name, { userId }),
    );
    repo.findDispatchDetail.mockResolvedValue(detailRow({ working, off: [] }));
    const out = await results.detail(NO_KEY.id, 'd1');
    return out.leftOut.unselected.map((p) => p.userId);
  },
};

describe('nome-telefone na saída — empate de máscara sem a chave: desempate por id', () => {
  it.each(Object.entries(orderIn))(
    '%s: mesma máscara, a posição segue o id (não a ordem de entrada nem o número real)',
    async (_point, orderOf) => {
      for (const [, people] of VARIANTS) {
        expect(await orderOf(people)).toEqual(['u-a', 'u-z']);
      }
    },
  );

  it('leftOut de foto antiga (sem userId): desempata pelo que o leitor já vê, não pelo nome real', async () => {
    as(NO_KEY);
    const orderOfTitles = async (names: string[]) => {
      const working = names.map((name, i) =>
        photoPerson(name, {
          userId: null,
          jobTitle: i % 2 ? 'Analista' : 'Zelador',
        }),
      );
      repo.findDispatchDetail.mockResolvedValue(
        detailRow({ working, off: [] }),
      );
      const out = await results.detail(NO_KEY.id, 'd1');
      return out.leftOut.unselected.map((p) => p.jobTitle);
    };
    // Zelador/Analista trocam de nome real (e de ordem de entrada) sem mudar a saída.
    expect(await orderOfTitles([A1, A2])).toEqual(['Analista', 'Zelador']);
    expect(await orderOfTitles([A2, A1])).toEqual(['Analista', 'Zelador']);
    expect(await orderOfTitles([A1_SWAPPED, A2])).toEqual([
      'Analista',
      'Zelador',
    ]);
  });
});

describe('nome-telefone na saída — ordem dos setores do leftOut', () => {
  const sectorsOf = async (actor: TeamActor, sectors: string[]) => {
    as(actor);
    const working = sectors.map((sectorName, i) =>
      photoPerson(i ? B : A1, { userId: `u${i}`, sectorName }),
    );
    repo.findDispatchDetail.mockResolvedValue(detailRow({ working, off: [] }));
    const out = await results.detail(actor.id, 'd1');
    return out.leftOut.unselected.map((p) => p.sectorName);
  };

  it.each([[['Financeiro', 'Almoxarifado']], [['Almoxarifado', 'Financeiro']]])(
    'sem a chave: setores pelo nome, não pela primeira aparição na foto (%s)',
    async (entry) => {
      expect(await sectorsOf(NO_KEY, entry)).toEqual([
        'Almoxarifado',
        'Financeiro',
      ]);
    },
  );

  it('com a chave: setores na ordem da foto gravada, como hoje', async () => {
    const entry = ['Financeiro', 'Almoxarifado'];
    expect(await sectorsOf(MANAGER, entry)).toEqual(entry);
  });
});
