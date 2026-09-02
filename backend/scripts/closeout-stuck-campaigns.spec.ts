import { describe, it, expect, vi } from 'vitest';
import {
  decideCloseout,
  findStuckCampaigns,
  applyCloseout,
  type StuckCampaign,
} from './closeout-stuck-campaigns';

/**
 * O reparo das campanhas que JÁ estão presas em prod. A correção no código só
 * vale para disparos novos: a campanha do incidente (RUNNING para sempre, criada
 * antes do fix) não é reavaliada por nada — nem migração, nem worker, nem
 * getById. Este script é o close-out dela.
 */
describe('closeout-stuck-campaigns', () => {
  describe('decideCloseout', () => {
    it('100% pulado pelo gate → COMPLETED (o gate bloqueou; a campanha não FALHOU)', () => {
      expect(
        decideCloseout([{ status: 'SKIPPED_NO_CONSENT', count: 2 }]),
      ).toEqual({ action: 'close', status: 'COMPLETED' });
    });

    it('houve envio → COMPLETED', () => {
      expect(
        decideCloseout([
          { status: 'SENT', count: 3 },
          { status: 'FAILED', count: 1 },
        ]),
      ).toEqual({ action: 'close', status: 'COMPLETED' });
    });

    it('zero envio e falhas reais → FAILED', () => {
      expect(decideCloseout([{ status: 'FAILED', count: 4 }])).toEqual({
        action: 'close',
        status: 'FAILED',
      });
    });

    it('mensagem em voo → NÃO fecha (o worker ainda vai passar por ela)', () => {
      expect(
        decideCloseout([
          { status: 'QUEUED', count: 1 },
          { status: 'SENT', count: 5 },
        ]),
      ).toMatchObject({ action: 'skip' });
      expect(
        decideCloseout([{ status: 'WAITING_INSTANCE', count: 1 }]),
      ).toMatchObject({ action: 'skip' });
    });

    it('sem mensagem nenhuma → NÃO fecha (o dispatch pode estar no meio do caminho)', () => {
      expect(decideCloseout([])).toMatchObject({ action: 'skip' });
    });
  });

  describe('findStuckCampaigns', () => {
    const db = (campaigns: unknown[], grouped: unknown[], batches: number) =>
      ({
        campaign: { findMany: vi.fn().mockResolvedValue(campaigns) },
        message: { groupBy: vi.fn().mockResolvedValue(grouped) },
        campaignBatch: { count: vi.fn().mockResolvedValue(batches) },
      }) as never;

    it('acha a campanha do incidente: RUNNING, 2 pulados, nada em voo', async () => {
      const stuck = await findStuckCampaigns(
        db(
          [{ id: 'c1', name: 'Convite' }],
          [{ status: 'SKIPPED_NO_CONSENT', _count: 2 }],
          0,
        ),
      );
      expect(stuck).toHaveLength(1);
      expect(stuck[0]).toMatchObject({
        id: 'c1',
        decision: { action: 'close', status: 'COMPLETED' },
      });
    });

    it('campanha saudável em voo não entra na lista', async () => {
      const stuck = await findStuckCampaigns(
        db([{ id: 'c2', name: 'Em voo' }], [{ status: 'QUEUED', _count: 9 }], 0),
      );
      expect(stuck).toEqual([]);
    });
  });

  describe('applyCloseout', () => {
    it('fecha só as sem lote — em campanha EM LOTES, "nada em voo" é o intervalo entre lotes', async () => {
      const update = vi.fn().mockResolvedValue({});
      const stuck: StuckCampaign[] = [
        {
          id: 'c1',
          name: 'Sem lote',
          counts: [{ status: 'SKIPPED_NO_CONSENT', count: 2 }],
          batches: 0,
          decision: { action: 'close', status: 'COMPLETED' },
        },
        {
          id: 'c2',
          name: 'Em lotes',
          counts: [{ status: 'SENT', count: 50 }],
          batches: 3,
          decision: { action: 'close', status: 'COMPLETED' },
        },
      ];

      const closed = await applyCloseout({ campaign: { update } } as never, stuck);

      expect(closed.map((c) => c.id)).toEqual(['c1']);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      });
    });
  });
});
