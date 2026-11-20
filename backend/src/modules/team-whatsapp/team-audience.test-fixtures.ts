import { vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import type { StaffExceptionKind } from '@prisma/client';
import type { TeamAudiencePreview } from '../../schemas/contracts/team-whatsapp.schema';
import type { Env } from '../../shared/config/env.schema';
import type { ConsentService } from '../consent/consent.service';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import { TeamAudienceService } from './team-audience.service';
import type {
  TeamMemberWithSchedule,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import {
  ADMIN,
  SHIFT_FIRST,
  SHIFT_SECOND,
  dayPerson,
  numberRow,
  onShift,
  sector,
} from './team-whatsapp.test-fixtures';

/** Dublês dos specs do serviço do público (não é spec: não roda sozinho). */
export const DATE = '2026-11-20';
export const S1 = sector({ id: 's1', name: 'Financeiro' });
export const S2 = sector({ id: 's2', name: 'Logística' });
export const NIGHT = {
  id: 'shift_night',
  name: 'Noturno',
  startTime: '22:00',
  endTime: '06:00',
};
const SECRET = 'segredo-de-teste-da-impressao-0123456789';

export type AudienceHarness = {
  repo: DeepMockProxy<TeamWhatsappRepository>;
  consent: DeepMockProxy<ConsentService>;
  levels: DeepMockProxy<LevelsRepository>;
  service: TeamAudienceService;
};

/** Ator ADMIN, setores s1 e s2 ativos e com número, nada suprimido, ninguém na escala. */
export function createAudienceHarness(): AudienceHarness {
  const repo = mockDeep<TeamWhatsappRepository>();
  const consent = mockDeep<ConsentService>();
  const levels = mockDeep<LevelsRepository>();
  const config = { get: vi.fn(() => SECRET) };
  const sectors = new Map([S1, S2].map((s) => [s.id, s]));
  repo.findActor.mockResolvedValue(ADMIN);
  repo.findSector.mockImplementation((id) =>
    Promise.resolve(sectors.get(id) ?? null),
  );
  repo.listActiveSectorIds.mockResolvedValue([S1.id, S2.id]);
  repo.listActiveShifts.mockResolvedValue([SHIFT_FIRST, SHIFT_SECOND, NIGHT]);
  repo.findSectorChannels.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, numberRow()]))),
  );
  repo.loadDayPeopleMany.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, []]))),
  );
  consent.isSuppressed.mockResolvedValue(false);
  levels.listActive.mockResolvedValue([]);
  const service = new TeamAudienceService(
    repo,
    consent,
    levels,
    config as unknown as ConfigService<Env>,
  );
  return { repo, consent, levels, service };
}

/** Pessoas que `loadDayPeopleMany` devolve para cada setor (sem filtrar nada). */
export function givenPeople(
  h: AudienceHarness,
  bySector: Record<string, TeamMemberWithSchedule[]>,
): void {
  h.repo.loadDayPeopleMany.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, bySector[id] ?? []]))),
  );
}

let phoneSeq = 0;

/** Pessoa com vínculo em s1 no turno dado (sem ciclo: o turno do cadastro vale todo dia). */
export const person = (
  id: string,
  shift: { id: string; name: string } | null = SHIFT_FIRST,
  over: Partial<TeamMemberWithSchedule> = {},
): TeamMemberWithSchedule =>
  dayPerson({
    id,
    name: `Pessoa ${id}`,
    phoneE164: `+559299111${String(++phoneSeq % 10000).padStart(4, '0')}`,
    ...onShift(shift),
    ...over,
  });

/** Ciclo de um dia que repete `shiftId` (null = folga) desde antes da data. */
export const cycleOf = (shiftId: string | null) => ({
  cycle: { startDate: '2026-01-01', cycleLength: 1, days: [shiftId] },
});

/** Exceção que cobre só a data `date`. */
export const on = (
  kind: StaffExceptionKind,
  extra: Partial<ScheduleExceptionInput> = {},
  date = DATE,
) => ({
  exceptions: [
    {
      id: `x-${kind}`,
      kind,
      startDate: date,
      endDate: date,
      shiftId: null,
      sectorId: null,
      ...extra,
    },
  ],
});

type RequestOver = Partial<Omit<TeamAudienceRequest, 'target'>> & {
  target?: Partial<TeamAudienceRequest['target']>;
};

/** Pedido de prévia: Aviso de turno para s1 na data, todos os turnos, texto vazio. */
export const request = (over: RequestOver = {}): TeamAudienceRequest => ({
  text: '',
  purpose: 'shift_notice',
  ...over,
  target: { type: 'sector', sectorIds: [S1.id], date: DATE, ...over.target },
});

/** Público resumido: id → motivo (`in` = recebe), para comparar de uma vez. */
export const verdict = (
  p: Pick<TeamAudiencePreview, 'included' | 'excluded'>,
) =>
  Object.fromEntries<string>([
    ...p.included.map((x): [string, string] => [x.userId, 'in']),
    ...p.excluded.map((x): [string, string] => [x.userId, x.reason]),
  ]);

/** Códigos das travas, sem o prefixo. */
export const blockCodes = (p: Pick<TeamAudiencePreview, 'blocks'>) =>
  p.blocks.map((b) => b.code.replace('team_whatsapp.', ''));
