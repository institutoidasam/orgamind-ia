import { beforeEach, describe, expect, it } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import {
  teamDispatchDetailResponseSchema,
  teamDispatchRecipientPageSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { DispatchRecipientsQuery } from './dto/dispatch-recipients-query.dto';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import type { TeamActor } from './team-whatsapp.policy';
import type {
  DispatchDetailRow,
  DispatchRecipientRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';

// Gestor autor do envio, com e sem `telefone.ver_completo`.
const FULL: TeamActor = {
  ...actorWith('OPERATOR', { id: 'g', grant: ['telefone.ver_completo'] }),
  managedSectorIds: ['s1'],
};
const MASKED: TeamActor = {
  ...actorWith('OPERATOR', { id: 'g', revoke: ['telefone.ver_completo'] }),
  managedSectorIds: ['s1'],
};
// D11: contato sem nome tem o número como nome; sem a chave sai a máscara.
const NUMBER_NAME = '+55 92 99111-0001';
const OTHER_NUMBER_NAME = '+55 92 98000-0009';
const PHONE = '+5592991110001';

let repo: DeepMockProxy<TeamWhatsappRepository>;
let service: TeamWhatsappResultsService;

beforeEach(() => {
  repo = mockDeep<TeamWhatsappRepository>();
  service = new TeamWhatsappResultsService(repo);
  repo.channelsByDispatch.mockResolvedValue([]);
  repo.countByStatus.mockResolvedValue([]);
  repo.findRecipientUserIds.mockResolvedValue([]);
});

function given(actor: TeamActor): void {
  repo.findActor.mockResolvedValue(actor);
  repo.findDispatchForActor.mockResolvedValue({
    id: 'd1',
    authorId: 'g',
    sectors: [{ sectorId: 's1' }],
    state: 'DISPATCHED',
    targetId: 's1',
    targetType: 'SECTOR',
  });
}

const recipient = (
  id: string,
  userName: string,
  over: Partial<DispatchRecipientRow> = {},
): DispatchRecipientRow => ({
  acceptedAt: null,
  attempts: 1,
  channel: null,
  channelCheckedAt: null,
  deliveredAt: null,
  errorCode: null,
  id,
  levelName: null,
  manualRetries: 0,
  readAt: null,
  repliedAt: null,
  sectorName: 'Financeiro',
  shiftName: null,
  skipReason: null,
  status: 'SENT',
  userName,
  ...over,
});

/** Busca (DG13): o repositório devolve todos, na ordem do nome real. */
async function search(
  actor: TeamActor,
  rows: DispatchRecipientRow[],
  query: Partial<DispatchRecipientsQuery>,
) {
  given(actor);
  repo.listAllDispatchRecipients.mockResolvedValue(rows);
  const out = await service.recipients('g', 'd1', {
    page: 1,
    pageSize: 50,
    ...query,
  });
  return teamDispatchRecipientPageSchema.parse(out);
}

const namesOf = (page: { items: { userName: string }[] }) =>
  page.items.map((i) => i.userName);

describe('TeamWhatsappResultsService.recipients — busca por nome (DG13)', () => {
  it('busca acha sem acento e sem caixa', async () => {
    const rows = [
      recipient('r1', 'Ána Lúcia'),
      recipient('r2', 'Bruno'),
      recipient('r3', 'JOÃO Pedro'),
    ];
    expect(namesOf(await search(FULL, rows, { q: 'ana luc' }))).toEqual([
      'Ána Lúcia',
    ]);
    expect(namesOf(await search(FULL, rows, { q: 'joao' }))).toEqual([
      'JOÃO Pedro',
    ]);
    expect(repo.listAllDispatchRecipients.mock.calls).toEqual([
      ['d1', undefined],
      ['d1', undefined],
    ]);
    expect(repo.listDispatchRecipients.mock.calls).toHaveLength(0);
  });

  it('busca com status e paginação: total dos filtrados', async () => {
    const rows = ['Ana A', 'Ana B', 'Ana C', 'Ana D', 'Ana E', 'Bia', 'Caio'];
    const out = await search(
      FULL,
      rows.map((name, i) => recipient(`r${i}`, name, { status: 'FAILED' })),
      { q: 'ana', status: 'FAILED', page: 2, pageSize: 2 },
    );
    expect(namesOf(out)).toEqual(['Ana C', 'Ana D']);
    expect(out).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(repo.listAllDispatchRecipients.mock.calls).toEqual([
      ['d1', 'FAILED'],
    ]);
  });
});

describe('TeamWhatsappResultsService.recipients — busca e máscara (DG13)', () => {
  it('sem telefone.ver_completo a busca não acha pelo número um nome mascarado', async () => {
    const rows = [recipient('r1', NUMBER_NAME), recipient('r2', 'Ana')];
    const masked = await search(MASKED, rows, { q: '99111' });
    expect(masked).toMatchObject({ items: [], total: 0 });
    // Compara o nome EXIBIDO: o que a tela mostra da máscara ainda acha.
    expect(namesOf(await search(MASKED, rows, { q: '0001' }))).toEqual([
      '•••• 0001',
    ]);
    // Controle: com a chave o nome é o número e a mesma busca acha.
    expect(namesOf(await search(FULL, rows, { q: '99111' }))).toEqual([
      NUMBER_NAME,
    ]);
  });

  it('sem a chave os achados saem pelo nome exibido, não pelo real', async () => {
    const rows = [
      recipient('r9', OTHER_NUMBER_NAME),
      recipient('r1', NUMBER_NAME),
    ];
    expect(namesOf(await search(MASKED, rows, { q: '00' }))).toEqual([
      '•••• 0001',
      '•••• 0009',
    ]);
  });
});

describe('TeamWhatsappResultsService.recipients — telefone usado (G4)', () => {
  it('destinatário com phone por telefone.ver_completo; nulo no antigo', async () => {
    const rows = [
      recipient('r1', 'Ana', { phoneE164: PHONE }),
      // Envio antigo: o telefone da pessoa não foi gravado.
      recipient('r2', 'Bia'),
    ];
    repo.listDispatchRecipients.mockResolvedValue({ rows, total: 2 });
    const phones = async (actor: TeamActor) => {
      given(actor);
      const out = await service.recipients('g', 'd1', {
        page: 1,
        pageSize: 50,
      });
      return out.items.map((i) => i.phone);
    };
    expect(await phones(FULL)).toEqual([PHONE, null]);
    expect(await phones(MASKED)).toEqual(['•••• 0001', null]);
  });
});

const detailRow = (
  over: Partial<DispatchDetailRow> = {},
): DispatchDetailRow => ({
  activityDate: null,
  activityPlace: null,
  activityTime: null,
  audienceBase: null,
  audienceExcluded: null,
  audienceLateJoined: null,
  audienceRule: null,
  author: null,
  createdAt: new Date('2026-11-24T12:00:00.000Z'),
  firedAt: null,
  id: 'd1',
  includeOff: false,
  purpose: null,
  recheckedAt: null,
  roster: null,
  rosterDate: null,
  schedulePolicy: null,
  scheduledFor: null,
  sectors: [{ sectorId: 's1', sectorName: 'Financeiro' }],
  state: 'DISPATCHED',
  targetLabel: 'Financeiro',
  text: 'Aviso',
  urgencyReason: null,
  ...over,
});

async function detailOf(actor: TeamActor, row: DispatchDetailRow) {
  given(actor);
  repo.findDispatchDetail.mockResolvedValue(row);
  return teamDispatchDetailResponseSchema.parse(
    await service.detail('g', 'd1'),
  );
}

const late = (userId: string, name: string) => ({
  userId,
  name,
  sectorId: 's1',
  sectorName: 'Financeiro',
  shiftName: '1º turno',
  levelName: null,
});

const SCHEDULED_FOR = new Date('2026-11-25T11:00:00.000Z');

describe('TeamWhatsappResultsService.detail — reconferência (G3, CG3)', () => {
  it('detalhe com recheck: hora, pulados e entraram depois mascarados e ordenados', async () => {
    repo.countRecheckSkips.mockResolvedValue(3);
    // Gravado na ordem do nome real; o telefone que sobrou no Json não sai.
    const audienceLateJoined = [
      late('u-9', OTHER_NUMBER_NAME),
      { ...late('u-1', NUMBER_NAME), phone: PHONE },
      late('u-a', 'Ana Lima'),
    ];
    const recheckedAt = new Date('2026-11-25T10:59:00.000Z');
    const out = await detailOf(
      MASKED,
      detailRow({
        recheckedAt,
        audienceLateJoined,
        scheduledFor: SCHEDULED_FOR,
      }),
    );
    expect(out.recheck).toMatchObject({ at: recheckedAt.toISOString() });
    expect(out.recheck?.skipped).toBe(3);
    expect(out.recheck?.lateJoined.map((p) => [p.userId, p.name])).toEqual([
      ['u-1', '•••• 0001'],
      ['u-9', '•••• 0009'],
      ['u-a', 'Ana Lima'],
    ]);
    expect(JSON.stringify(out.recheck)).not.toContain('99111');
    expect(repo.countRecheckSkips.mock.calls).toEqual([['d1']]);
  });
});

describe('TeamWhatsappResultsService.detail — sem reconferência (CG3)', () => {
  it('detalhe sem reconferência: recheck nulo', async () => {
    // Agendado cancelado antes do disparo: nunca reconferido.
    const cancelled = detailRow({
      scheduledFor: SCHEDULED_FOR,
      state: 'CANCELLED',
    });
    const out = await detailOf(FULL, cancelled);
    expect(out.recheck).toBeNull();
    expect(repo.countRecheckSkips.mock.calls).toHaveLength(0);
  });

  it('detalhe e destinatários sempre trazem recheck e phone, nulos quando não há', async () => {
    given(FULL);
    repo.findDispatchDetail.mockResolvedValue(detailRow());
    repo.listAllDispatchRecipients.mockResolvedValue([recipient('r1', 'Ana')]);
    const detail = await service.detail('g', 'd1');
    const found = await service.recipients('g', 'd1', {
      page: 1,
      pageSize: 50,
      q: 'ana',
    });
    expect(detail).toHaveProperty('recheck', null);
    expect(found.items[0]).toHaveProperty('phone', null);
  });
});

describe('TeamWhatsappResultsService.detail — rule.when gravado (DG8)', () => {
  const RULE = { shifts: null, levels: [], withoutLevel: false };
  const meeting = (audienceRule: object) =>
    detailRow({
      audienceBase: 'ASSIGNED',
      audienceRule: { ...RULE, selectedUserIds: null, ...audienceRule },
      purpose: 'MEETING',
      rosterDate: new Date('2026-11-25T00:00:00.000Z'),
      scheduledFor: SCHEDULED_FOR,
      state: 'SCHEDULED',
    });

  it('rule.when at lido do gravado; ausente inferido', async () => {
    const at = await detailOf(FULL, meeting({ when: 'at' }));
    expect(at.rule?.when).toBe('at');
    // Envio anterior ao Lote G: sem `when` gravado, scheduledFor → início do turno.
    const old = await detailOf(FULL, meeting({}));
    expect(old.rule?.when).toBe('shift_start');
  });
});
