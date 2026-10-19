import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import { TeamWhatsappService } from './team-whatsapp.service';
import type {
  TeamChannel,
  TeamMember,
  TeamSector,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import type { TeamActor } from './team-whatsapp.policy';
import type { ConsentService } from '../consent/consent.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';

/** Dublês compartilhados pelos specs do serviço (não é spec: não roda sozinho). */
export const PHONE = '+5592991234567';
export const SUPPRESSED = '+5592988887777';
export const ADMIN: TeamActor = {
  id: 'a',
  role: 'ADMIN',
  isActive: true,
  managedSectorIds: [],
};
export const MANAGER: TeamActor = {
  id: 'm',
  role: 'OPERATOR',
  isActive: true,
  managedSectorIds: ['s1'],
};

export const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  id: 'u1',
  name: 'Ana',
  email: 'ana@idasam.org',
  isActive: true,
  sectorId: 's1',
  sector: { isActive: true },
  phoneE164: PHONE,
  contact: null,
  ...over,
});

export const sector = (over: Partial<TeamSector> = {}): TeamSector => ({
  id: 's1',
  name: 'Financeiro',
  isActive: true,
  members: [member()],
  ...over,
});

export const channel = (over: Partial<TeamChannel> = {}): TeamChannel => ({
  id: 'c1',
  name: 'Canal equipe',
  provider: 'GOZAP',
  isActive: true,
  connectionEvents: [{ state: 'open' }],
  ...over,
});

export type Harness = {
  repo: DeepMockProxy<TeamWhatsappRepository>;
  consent: DeepMockProxy<ConsentService>;
  audit: DeepMockProxy<AuditService>;
  queue: DeepMockProxy<Queue<TeamWhatsappSendJob>>;
  service: TeamWhatsappService;
};

/** Canal válido, só SUPPRESSED em supressão e `createDispatch` ecoando ids r1, r2… */
export function createHarness(): Harness {
  const repo = mockDeep<TeamWhatsappRepository>();
  const consent = mockDeep<ConsentService>();
  const audit = mockDeep<AuditService>();
  const queue = mockDeep<Queue<TeamWhatsappSendJob>>();
  consent.isSuppressed.mockImplementation((p) =>
    Promise.resolve(p === SUPPRESSED),
  );
  repo.findChannel.mockResolvedValue(channel());
  repo.countByStatus.mockResolvedValue([]);
  repo.listIssues.mockResolvedValue([]);
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
  return { repo, consent, audit, queue, service };
}
