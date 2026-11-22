import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import { TeamWhatsappService } from './team-whatsapp.service';
import type {
  TeamMember,
  TeamMemberWithSchedule,
  TeamSector,
  TeamSectorChannelRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import type { TeamActor } from './team-whatsapp.policy';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ConsentService } from '../consent/consent.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import type {
  ChannelLiveStateService,
  LiveState,
} from '../whatsapp-providers/channel-live-state.service';

/** Dublês compartilhados pelos specs do serviço (não é spec: não roda sozinho). */
export const PHONE = '+5592991234567';
export const SUPPRESSED = '+5592988887777';
export const ADMIN: TeamActor = {
  id: 'a',
  role: 'ADMIN',
  isActive: true,
  hasAccess: true,
  managedSectorIds: [],
};
export const MANAGER: TeamActor = {
  id: 'm',
  role: 'OPERATOR',
  isActive: true,
  hasAccess: true,
  managedSectorIds: ['s1'],
};

/** Turnos migrados pela T1 (ids fixos). */
export const SHIFT_FIRST = {
  id: 'shift_first',
  name: '1º turno',
  startTime: '06:00',
  endTime: '14:00',
};
export const SHIFT_SECOND = {
  id: 'shift_second',
  name: '2º turno',
  startTime: '14:00',
  endTime: '22:00',
};

/** Colunas de snapshot do envio sem filtro de turno (todos os turnos ou alvo pessoa). */
export const NO_SNAPSHOT = {
  shiftId: null,
  shiftName: null,
  shiftStartTime: null,
  shiftEndTime: null,
};
/** Turno gravado no destinatário sem turno no cadastro. */
export const NO_SHIFT = { shiftId: null, shiftName: null };
/** Snapshot de setor/nível do destinatário no alvo pessoa (C6). */
export const NO_SECTOR = { sectorId: null, sectorName: null, levelName: null };

/** Destinatário gravado direto no repositório, sem número (D3: coluna e snapshot nulos). */
export const NO_CHANNEL = {
  channelId: null,
  channelName: null,
  channelPhoneE164: null,
};

/** Campos de turno do cadastro de um membro; `null` = sem turno. */
export const onShift = (
  shift: { id: string; name: string } | null,
): Pick<TeamMember, 'shiftId' | 'workShift'> => ({
  shiftId: shift?.id ?? null,
  workShift: shift ? { name: shift.name } : null,
});

export const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  id: 'u1',
  name: 'Ana',
  email: 'ana@idasam.org',
  isActive: true,
  sectorId: 's1',
  sector: { isActive: true },
  phoneE164: PHONE,
  contact: null,
  shiftId: null,
  workShift: null,
  ...over,
});

/** Pessoa do envio por data: membro + função + nível + escala (padrão: sem nível, ciclo nem exceção). */
export const dayPerson = (
  over: Partial<TeamMemberWithSchedule> = {},
): TeamMemberWithSchedule => ({
  ...member(),
  jobTitle: null,
  levelId: null,
  level: null,
  cycle: null,
  exceptions: [],
  ...over,
});

export const sector = (over: Partial<TeamSector> = {}): TeamSector => ({
  id: 's1',
  name: 'Financeiro',
  isActive: true,
  ...over,
});

/** Número efetivo de uma área (D2) como o repositório o devolve; padrão: o `c1` do envio de hoje. */
export const numberRow = (
  over: Partial<TeamSectorChannelRow> = {},
): TeamSectorChannelRow => ({
  id: 'c1',
  name: 'Canal equipe',
  phoneE164: '+559230001111',
  provider: 'GOZAP',
  evolutionInstanceName: null,
  ...over,
});

export type Harness = {
  repo: DeepMockProxy<TeamWhatsappRepository>;
  consent: DeepMockProxy<ConsentService>;
  audit: DeepMockProxy<AuditService>;
  queue: DeepMockProxy<Queue<TeamWhatsappSendJob>>;
  levels: DeepMockProxy<LevelsRepository>;
  live: DeepMockProxy<ChannelLiveStateService>;
  service: TeamWhatsappService;
};

/** Áreas sem número, só SUPPRESSED em supressão, sem níveis ativos e `createDispatch` ecoando ids r1, r2… */
export function createHarness(): Harness {
  const repo = mockDeep<TeamWhatsappRepository>();
  const consent = mockDeep<ConsentService>();
  const audit = mockDeep<AuditService>();
  const queue = mockDeep<Queue<TeamWhatsappSendJob>>();
  const levels = mockDeep<LevelsRepository>();
  const live = mockDeep<ChannelLiveStateService>();
  levels.listActive.mockResolvedValue([]);
  // Por padrão as áreas ficam sem número: os specs que precisam dele dizem qual.
  repo.findSectorChannels.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, null]))),
  );
  live.checkMany.mockResolvedValue(new Map());
  consent.isSuppressed.mockImplementation((p) =>
    Promise.resolve(p === SUPPRESSED),
  );
  repo.loadPersonSchedule.mockResolvedValue({ cycle: null, exceptions: [] });
  repo.listActiveShifts.mockResolvedValue([SHIFT_FIRST, SHIFT_SECOND]);
  repo.countByStatus.mockResolvedValue([]);
  repo.channelsByDispatch.mockResolvedValue([]);
  // A lista do dia chega numa rodada (`loadDayPeopleMany`); os specs ainda
  // dizem as pessoas de cada setor por `loadDayPeople`, e esta ponte junta as duas.
  repo.loadDayPeopleMany.mockImplementation(async (sectorIds, date) => {
    const days = await Promise.all(
      sectorIds.map((id) => repo.loadDayPeople(id, date)),
    );
    return new Map(sectorIds.map((id, i) => [id, days[i]]));
  });
  repo.createDispatch.mockImplementation((data) =>
    Promise.resolve({
      id: 'd1',
      recipients: data.recipients.map((r, i) => ({
        id: `r${i + 1}`,
        status: r.status,
      })),
    }),
  );
  const service = new TeamWhatsappService(repo, consent, audit, queue);
  // `levels` e `live` são injetados por propriedade no Nest; aqui, à mão.
  Object.assign(service, { levels, live });
  return { repo, consent, audit, queue, levels, live, service };
}

/** Alvo setor: o setor (`findSector`) e as pessoas do dia, sem escala (`loadDayPeople`). */
export function givenSector(
  h: Harness,
  members: readonly TeamMember[],
  over: Partial<TeamSector> = {},
): void {
  h.repo.findSector.mockResolvedValue(sector(over));
  h.repo.loadDayPeople.mockResolvedValue(members.map((m) => dayPerson(m)));
}

/** Estado ao vivo que a porta devolve por canal (D7); o que não está no mapa vale `open`. */
export function givenLive(
  h: Harness,
  states: Readonly<Record<string, LiveState>> = {},
): void {
  h.live.checkMany.mockImplementation((channels) =>
    Promise.resolve(
      new Map(
        channels.map((c) => [
          c.id,
          {
            channelId: c.id,
            state: states[c.id] ?? 'open',
            checkedAt: new Date(),
          },
        ]),
      ),
    ),
  );
}

/** Número de cada área (D2); área fora do mapa fica sem número. Canais `open`. */
export function givenNumbers(
  h: Harness,
  bySector: Readonly<Record<string, TeamSectorChannelRow | null>>,
): void {
  h.repo.findSectorChannels.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, bySector[id] ?? null]))),
  );
  givenLive(h);
}

/** Toda área tem o mesmo número (`c1`): o envio de hoje, quando o corpo mandava o canal. */
export function givenNumber(
  h: Harness,
  row: TeamSectorChannelRow = numberRow(),
): void {
  h.repo.findSectorChannels.mockImplementation((ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, row]))),
  );
  givenLive(h);
}
