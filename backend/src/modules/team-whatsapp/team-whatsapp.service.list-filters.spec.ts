import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  MANAGER,
  createHarness,
  type Harness,
} from './team-whatsapp.test-fixtures';

const PAGE = { page: 2, pageSize: 20 };

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.repo.listDispatches.mockResolvedValue({ rows: [], total: 0 });
});

// DG14/GG7: os filtros vão ao repositório já em instantes de Manaus (-04:00),
// sempre somados ao autor; quem não é ADMIN continua só com os próprios.
describe('TeamWhatsappService.listDispatches — filtros (DG14)', () => {
  it('aceite 31: lista repassa período, finalidade e situação; gestor continua só com os próprios', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    const out = await h.service.listDispatches('m', {
      ...PAGE,
      from: '2026-11-01',
      to: '2026-11-10',
      purpose: 'meeting',
      state: 'EXPIRED',
    });
    expect(h.repo.listDispatches.mock.calls).toEqual([
      [
        'm',
        PAGE,
        {
          createdFrom: new Date('2026-11-01T00:00:00-04:00'),
          createdBefore: new Date('2026-11-11T00:00:00-04:00'),
          purpose: 'MEETING',
          state: 'EXPIRED',
        },
      ],
    ]);
    // Os filtros não voltam na resposta: só a página.
    expect(out).toEqual({ items: [], total: 0, ...PAGE });
  });

  it('to inclui o dia inteiro em Manaus', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    await h.service.listDispatches('a', { ...PAGE, to: '2026-11-30' });
    const [authorId, , filter] = h.repo.listDispatches.mock.calls[0];
    const before = filter?.createdBefore?.getTime() ?? 0;
    expect(authorId).toBeNull();
    expect(filter?.createdFrom).toBeUndefined();
    // 23:59:59 de 30/11 em Manaus entra; 00:00 de 01/12 já fica de fora.
    expect(new Date('2026-11-30T23:59:59.999-04:00').getTime()).toBeLessThan(
      before,
    );
    expect(before).toBe(new Date('2026-12-01T00:00:00-04:00').getTime());
  });
});
