import { beforeEach, describe, expect, it } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { teamDispatchRecipientPageSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import type {
  DispatchRecipientRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import { ADMIN } from './team-whatsapp.test-fixtures';

const CHECKED_AT = '2026-11-20T13:00:09.000Z';

let repo: DeepMockProxy<TeamWhatsappRepository>;
let service: TeamWhatsappResultsService;

const row = (
  over: Partial<DispatchRecipientRow> = {},
): DispatchRecipientRow => ({
  id: 'r1',
  userName: 'Pessoa A',
  sectorName: 'Logística',
  levelName: null,
  shiftName: 'Dia',
  status: 'SENT',
  errorCode: null,
  skipReason: null,
  attempts: 2,
  channel: { name: 'GBR', phoneE164: '+559230001111' },
  acceptedAt: null,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  channelCheckedAt: new Date(CHECKED_AT),
  manualRetries: 1,
  ...over,
});

beforeEach(() => {
  repo = mockDeep<TeamWhatsappRepository>();
  service = new TeamWhatsappResultsService(repo);
  repo.findActor.mockResolvedValue(ADMIN);
  repo.findDispatchForActor.mockResolvedValue({
    id: 'd1',
    authorId: ADMIN.id,
    targetType: 'SECTOR',
    targetId: 's1',
    state: 'DISPATCHED',
    sectors: [{ sectorId: 's1' }],
  });
});

/** Itens da página pelo contrato; com `q` a busca lê todos (DG13). */
async function itemsOf(rows: DispatchRecipientRow[], q?: string) {
  repo.listDispatchRecipients.mockResolvedValue({ rows, total: rows.length });
  repo.listAllDispatchRecipients.mockResolvedValue(rows);
  const out = await service.recipients(ADMIN.id, 'd1', {
    page: 1,
    pageSize: 50,
    q,
  });
  return teamDispatchRecipientPageSchema.parse(out).items;
}

describe('rastreio no item de destinatário (H1, H4)', () => {
  it('item traz manualRetries e channelCheckedAt em ISO', async () => {
    const [item] = await itemsOf([row()]);
    expect(item).toMatchObject({
      attempts: 2,
      manualRetries: 1,
      channelCheckedAt: CHECKED_AT,
    });
  });

  it('channelCheckedAt nulo vira null', async () => {
    const [item] = await itemsOf([
      row({ channelCheckedAt: null, manualRetries: 0 }),
    ]);
    expect(item.channelCheckedAt).toBeNull();
    expect(item.manualRetries).toBe(0);
  });

  it('busca por nome também devolve os campos novos', async () => {
    const rows = [row(), row({ id: 'r2', userName: 'Pessoa B' })];
    const items = await itemsOf(rows, 'pessoa a');
    expect(repo.listAllDispatchRecipients.mock.calls).toEqual([
      ['d1', undefined],
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        id: 'r1',
        manualRetries: 1,
        channelCheckedAt: CHECKED_AT,
      }),
    ]);
  });
});
