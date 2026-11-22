import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type { AuditService } from '../../shared/audit/audit.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import { todayIn } from '../staff-schedule/civil-date';
import { recheckAudience } from './scheduled-recheck.runner';
import type { RecheckPlan } from './scheduled-recheck';
import { DATE, S1, on, person } from './team-audience.test-fixtures';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type {
  ClaimedDispatch,
  TeamMemberWithSchedule,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import { SHIFT_FIRST, SHIFT_SECOND } from './team-whatsapp.test-fixtures';

// Lote G, T6b: reconferência ligada ao claim, vencimento e trilhas do disparo,
// sobre dublês (o banco real fica em team-whatsapp.schedule-recheck.integration).
// 23h30 em Manaus de DATE: o dia civil do tick é DATE, não o do UTC.
const NOW = new Date('2026-11-21T03:30:00.000Z');
const LEVEL = { id: 'lv1', name: 'Nível 1' };
const RULE = {
  shifts: [{ id: SHIFT_FIRST.id, name: SHIFT_FIRST.name }],
  levels: [],
  withoutLevel: false,
  selectedUserIds: null,
  when: 'at',
};

const claimed = (over: Partial<ClaimedDispatch> = {}): ClaimedDispatch => ({
  id: 'd1',
  schedulePolicy: 'FROZEN_RECHECK',
  audienceBase: 'ASSIGNED',
  includeOff: false,
  rosterDate: DATE,
  sectors: [{ id: S1.id, name: S1.name }],
  audienceRule: RULE,
  frozen: [{ id: 'r1', userId: 'u1', userActive: true }],
  recipientUserIds: ['u1'],
  ...over,
});

/** Repositório só com a leitura das pessoas: qualquer outra consulta quebraria. */
const peopleRepo = (people: TeamMemberWithSchedule[]) => ({
  loadDayPeopleMany: vi
    .fn<TeamWhatsappRepository['loadDayPeopleMany']>()
    .mockResolvedValue(new Map([[S1.id, people]])),
});

function harness() {
  const repo = mockDeep<TeamWhatsappRepository>();
  const audit = mockDeep<AuditService>();
  const queue = mockDeep<Queue<TeamWhatsappSendJob>>();
  const service = new TeamWhatsappScheduleService(repo, audit, queue);
  return { repo, audit, queue, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fireOne — reconferência no claim (DG2/DG5)', () => {
  it('fireOne passa a reconferência ao claim', async () => {
    const { repo, service } = harness();
    repo.loadDayPeopleMany.mockResolvedValue(
      new Map([[S1.id, [person('u1')]]]),
    );
    let plan: RecheckPlan | undefined;
    repo.claimScheduled.mockImplementation(async (_id, _now, recheck) => {
      plan = await recheck?.(claimed());
      return { queuedIds: [], skipped: 0, failed: 0, rechecked: null };
    });

    await expect(service.fireOne('d1', NOW)).resolves.toBe('fired');

    expect(repo.claimScheduled.mock.calls).toEqual([
      ['d1', NOW, expect.any(Function)],
    ]);
    // A função fecha sobre o `now` do tick: o dia civil dele vai para a leitura.
    expect(repo.loadDayPeopleMany.mock.calls).toEqual([
      [[S1.id], DATE, todayIn(NOW)],
    ]);
    expect(plan).toEqual({ skips: [], lateJoined: [] });
    expect(repo.expireScheduled.mock.calls).toEqual([]);
  });

  it('recheckAudience repassa todayIn(now) a loadDayPeopleMany, não o relógio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-25T15:00:00.000Z'));
    const repo = peopleRepo([person('u1')]);

    await recheckAudience(repo, claimed(), NOW);

    const [[, date, today]] = repo.loadDayPeopleMany.mock.calls;
    expect(date).toBe(DATE);
    expect(today).toBe('2026-11-20');
    expect(today).not.toBe(todayIn(new Date()));
  });
});

describe('fireOne — vencimento (DG5)', () => {
  it('claim null e vencimento — expired e trilha scheduled_expired só com ids e contagens', async () => {
    const { repo, audit, queue, service } = harness();
    repo.claimScheduled.mockResolvedValue(null);
    repo.expireScheduled.mockResolvedValue({ skipped: 3 });

    await expect(service.fireOne('d1', NOW)).resolves.toBe('expired');

    expect(repo.expireScheduled.mock.calls).toEqual([['d1', NOW]]);
    expect(audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.scheduled_expired',
        'TeamWhatsappDispatch',
        'd1',
        { dispatchId: 'd1', skipped: 3 },
      ],
    ]);
    expect(queue.addBulk.mock.calls).toEqual([]);
  });

  it('claim e vencimento null (cancelado, já disparado ou antes da hora) — skipped, sem trilha', async () => {
    const { repo, audit, service } = harness();
    repo.claimScheduled.mockResolvedValue(null);
    repo.expireScheduled.mockResolvedValue(null);

    await expect(service.fireOne('d1', NOW)).resolves.toBe('skipped');

    expect(audit.log.mock.calls).toEqual([]);
  });
});

describe('fireOne — trilha scheduled_fire (GG8)', () => {
  it.each([
    [
      'reconferido',
      { skipped: 2, lateJoined: 1 },
      { policy: 'frozen_recheck', recheckSkipped: 2, lateJoined: 1 },
    ],
    ['regra antiga', null, { policy: null, recheckSkipped: 0, lateJoined: 0 }],
  ])(
    'scheduled_fire com policy, recheckSkipped e lateJoined, sem nome nem telefone (%s)',
    async (_label, rechecked, expected) => {
      const { repo, audit, queue, service } = harness();
      queue.addBulk.mockResolvedValue([]);
      repo.claimScheduled.mockResolvedValue({
        queuedIds: ['r1'],
        skipped: 1,
        failed: 0,
        rechecked,
      });

      await expect(service.fireOne('d1', NOW)).resolves.toBe('fired');

      // `toEqual` exato: a trilha não leva nenhuma chave além de ids e contagens.
      expect(audit.log.mock.calls).toEqual([
        [
          'team_whatsapp.scheduled_fire',
          'TeamWhatsappDispatch',
          'd1',
          { dispatchId: 'd1', queued: 1, skipped: 1, failed: 0, ...expected },
        ],
      ]);
    },
  );
});

describe('recheckAudience — regra gravada (DG3/DG4)', () => {
  it('recheckAudience monta o filtro da regra gravada sem consultar níveis nem alcance', async () => {
    const inLevel = { levelId: LEVEL.id, level: LEVEL };
    const repo = peopleRepo([
      person('u1', SHIFT_FIRST, inLevel),
      person('u2', SHIFT_FIRST, {
        levelId: 'lv2',
        level: { id: 'lv2', name: 'Nível 2' },
      }),
      person('u3', SHIFT_SECOND, inLevel),
      person('u4', SHIFT_FIRST, { ...inLevel, ...on('VACATION') }),
      person('u5', SHIFT_FIRST, inLevel),
      person('u6', SHIFT_FIRST, inLevel),
    ]);
    const frozen = ['u1', 'u2', 'u3', 'u4'].map((u) => ({
      id: `r-${u}`,
      userId: u,
      userActive: true,
    }));
    const rule = { ...RULE, levels: [LEVEL] };
    // u6 tem linha no envio (pulada na criação): não "entrou depois".
    const recipientUserIds = ['u1', 'u2', 'u3', 'u4', 'u6'];

    const plan = await recheckAudience(
      repo,
      claimed({ audienceRule: rule, frozen, recipientUserIds }),
      NOW,
    );

    expect(plan).toEqual({
      skips: [
        { recipientId: 'r-u2', reason: 'LEFT_SECTOR' },
        { recipientId: 'r-u3', reason: 'LEFT_SECTOR' },
        { recipientId: 'r-u4', reason: 'VACATION' },
      ],
      lateJoined: [
        {
          userId: 'u5',
          name: 'Pessoa u5',
          sectorId: S1.id,
          sectorName: S1.name,
          shiftName: SHIFT_FIRST.name,
          levelName: LEVEL.name,
        },
      ],
    });
  });
});

describe('recheckAudience — seleção nominal e regra inválida', () => {
  it('seleção nominal gravada (não nula): ninguém "entra depois"; inativa sai como Inativa', async () => {
    const repo = peopleRepo([person('u1'), person('u2'), person('u3')]);
    // u3 foi marcado, ficou sem linha no envio (fora na criação) e agora se
    // enquadra: com seleção nominal, mesmo assim não "entra depois".
    const rule = { ...RULE, selectedUserIds: ['u1', 'u2', 'u3'] };
    const frozen = ['u1', 'u2'].map((u) => ({
      id: `r-${u}`,
      userId: u,
      userActive: u === 'u1',
    }));

    const plan = await recheckAudience(
      repo,
      claimed({ audienceRule: rule, frozen, recipientUserIds: ['u1', 'u2'] }),
      NOW,
    );

    expect(plan).toEqual({
      skips: [{ recipientId: 'r-u2', reason: 'INACTIVE' }],
      lateJoined: [],
    });
  });

  it.each([
    ['audienceRule fora do formato', { audienceRule: { shifts: 'x' } }],
    ['audienceRule nulo', { audienceRule: null }],
    ['base nula', { audienceBase: null }],
    ['data de referência nula', { rosterDate: null }],
  ])('audienceRule inválido lança (%s)', async (_label, over) => {
    const repo = peopleRepo([person('u1')]);

    const error = await recheckAudience(repo, claimed(over), NOW).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    // Só o id do envio na mensagem (GG8); nada é lido antes de validar a regra.
    expect((error as Error).message).toBe(
      'Agendado d1 sem regra gravada para reconferir',
    );
    expect(repo.loadDayPeopleMany).not.toHaveBeenCalled();
  });
});
