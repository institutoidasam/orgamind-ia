import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { teamDispatchDetailResponseSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import type { TeamActor } from './team-whatsapp.policy';
import type {
  DispatchDetailRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';

const FULL: TeamActor = {
  ...actorWith('ADMIN', { id: 'a' }),
  managedSectorIds: [],
};
const MASKED: TeamActor = {
  ...actorWith('ADMIN', { id: 'a', revoke: ['telefone.ver_completo'] }),
  managedSectorIds: [],
};

const OLD_COLUMNS = {
  purpose: null,
  audienceBase: null,
  includeOff: false,
  rosterDate: null,
  activityDate: null,
  activityTime: null,
  activityPlace: null,
  urgencyReason: null,
  audienceRule: null,
  audienceExcluded: null,
  schedulePolicy: null,
};

const RULE = {
  shifts: null,
  levels: [{ id: 'n1', name: 'Pleno' }],
  withoutLevel: false,
  selectedUserIds: null,
};

const person = (userId: string, name: string, reason: string) => ({
  userId,
  name,
  sectorId: 's1',
  sectorName: 'Financeiro',
  shiftName: '1º turno',
  levelName: null,
  reason,
});

// Gravado na ordem do nome real; o telefone que sobrou no Json não pode sair.
const EXCLUDED = [
  { ...person('u-z', '+55 92 98000-0009', 'day_off'), phone: '+5592991110009' },
  person('u-b', '+55 92 99111-0001', 'vacation'),
  person('u-a', 'Ana Lima', 'other_shift'),
];

const WITH_PURPOSE = {
  purpose: 'MEETING' as const,
  audienceBase: 'ASSIGNED' as const,
  includeOff: true,
  rosterDate: new Date('2026-11-25T00:00:00.000Z'),
  activityDate: new Date('2026-11-25T00:00:00.000Z'),
  activityTime: '09:00',
  activityPlace: 'Sala 2',
  audienceRule: RULE,
  audienceExcluded: EXCLUDED,
};

const detailRow = (
  over: Partial<DispatchDetailRow> = {},
): DispatchDetailRow => ({
  ...OLD_COLUMNS,
  id: 'd1',
  targetLabel: 'Financeiro',
  text: 'Reunião',
  state: 'DISPATCHED',
  createdAt: new Date('2026-11-20T12:00:00.000Z'),
  scheduledFor: null,
  firedAt: null,
  roster: null,
  author: null,
  sectors: [{ sectorId: 's1', sectorName: 'Financeiro' }],
  ...over,
});

let repo: DeepMockProxy<TeamWhatsappRepository>;
let service: TeamWhatsappResultsService;

function given(actor: TeamActor, row: DispatchDetailRow): void {
  repo.findActor.mockResolvedValue(actor);
  repo.findDispatchForActor.mockResolvedValue({
    id: 'd1',
    authorId: 'a',
    targetType: 'SECTOR',
    targetId: 's1',
    state: 'DISPATCHED',
    sectors: [{ sectorId: 's1' }],
  });
  repo.findDispatchDetail.mockResolvedValue(row);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  repo = mockDeep<TeamWhatsappRepository>();
  service = new TeamWhatsappResultsService(repo);
  repo.countByStatus.mockResolvedValue([]);
  repo.channelsByDispatch.mockResolvedValue([]);
  repo.findRecipientUserIds.mockResolvedValue([]);
});

const detailOf = async () =>
  teamDispatchDetailResponseSchema.parse(await service.detail('a', 'd1'));

describe('TeamWhatsappResultsService.detail — envio sem finalidade (GF13)', () => {
  it('aceite 13: envio sem finalidade devolve purpose, base e rule nulos e excluded vazio', async () => {
    given(FULL, detailRow());
    const out = await service.detail('a', 'd1');
    expect(out).toMatchObject({
      purpose: null,
      base: null,
      rule: null,
      excluded: [],
    });
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(['purpose', 'base', 'rule', 'excluded']),
    );
    expect(teamDispatchDetailResponseSchema.safeParse(out).success).toBe(true);
  });

  it('JSON fora do formato vira excluded vazio, sem 500', async () => {
    const audienceExcluded = [{ userId: 'u1', name: 'Ana Lima', reason: 'x' }];
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    given(FULL, detailRow({ ...WITH_PURPOSE, audienceExcluded }));
    const out = await detailOf();
    expect(out.excluded).toEqual([]);
    expect(out.rule).not.toBeNull();
    // O aviso traz só o envio e a coluna, nunca o nome nem o conteúdo gravado.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('d1');
    expect(message).toContain('audienceExcluded');
    expect(message).not.toMatch(/Ana Lima|u1/);
  });
});

describe('TeamWhatsappResultsService.detail — regra e excluídos gravados (F3)', () => {
  it('detalhe devolve painel e excluídos lidos do JSON, sem recalcular', async () => {
    given(FULL, detailRow(WITH_PURPOSE));
    const out = await detailOf();
    expect(out).toMatchObject({ purpose: 'meeting', base: 'assigned' });
    expect(out.rule).toEqual({
      purpose: 'meeting',
      base: 'assigned',
      includeOff: true,
      rosterDate: '2026-11-25',
      sectors: [{ id: 's1', name: 'Financeiro' }],
      shifts: null,
      levels: RULE.levels,
      withoutLevel: false,
      selectedCount: null,
      activity: { date: '2026-11-25', time: '09:00', place: 'Sala 2' },
      urgencyReason: null,
      when: 'now',
      scheduledFor: null,
      schedulePolicy: null,
    });
    expect(out.excluded.map((p) => [p.userId, p.reason])).toEqual([
      ['u-z', 'day_off'],
      ['u-b', 'vacation'],
      ['u-a', 'other_shift'],
    ]);
    expect(JSON.stringify(out)).not.toContain('5592991110009');
    for (const read of [
      'findMembersForDay',
      'loadDayPeopleMany',
      'loadDayPeople',
      'loadPersonSchedule',
    ] as const) {
      expect(repo[read].mock.calls).toHaveLength(0);
    }
  });

  it('sem telefone.ver_completo nomes dos excluídos mascarados e ordenados pelo nome exibido', async () => {
    given(MASKED, detailRow(WITH_PURPOSE));
    const out = await detailOf();
    expect(out.excluded.map((p) => [p.userId, p.name])).toEqual([
      ['u-b', '•••• 0001'],
      ['u-z', '•••• 0009'],
      ['u-a', 'Ana Lima'],
    ]);
  });
});
