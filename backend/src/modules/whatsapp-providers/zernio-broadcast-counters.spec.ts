import { describe, it, expect } from 'vitest';
import {
  broadcastCountersFromStatuses,
  funnelToPartition,
} from './zernio-broadcast-counters';

describe('broadcastCountersFromStatuses — o funil das nossas Messages', () => {
  it('cada nível soma os de cima: sent ⊇ delivered ⊇ read; FAILED fora', () => {
    // Estados exclusivos de Message → funil cumulativo.
    const c = broadcastCountersFromStatuses({
      SENT: 1,
      DELIVERED: 7,
      READ: 31,
      FAILED: 6,
    });

    expect(c).toEqual({
      sentCount: 39, // 1 + 7 + 31
      deliveredCount: 38, // 7 + 31
      readCount: 31,
      failedCount: 6,
    });
  });
});

describe('funnelToPartition — a linha órfã tem de nascer na semântica da leitura', () => {
  it('inverte o funil de volta para a partição por status atual', () => {
    // O caso real de prod (13/07): a campanha apagada faz SetNull no
    // campaignId e a linha passa a ser LIDA como painel (partição). Sem a
    // conversão, o toFunnel do ZernioMetricsService re-somaria o funil e a
    // lida contaria duas vezes: (38+31)/45 = os 153% de volta.
    const partition = funnelToPartition({
      sentCount: 39,
      deliveredCount: 38,
      readCount: 31,
      failedCount: 6,
    });

    expect(partition).toEqual({
      sentCount: 1, // saiu e nunca confirmou entrega
      deliveredCount: 7, // entregue mas não lido
      readCount: 31,
      failedCount: 6,
    });
  });

  it('é o inverso exato do funil (round-trip sem perda)', () => {
    const byStatus = { SENT: 4, DELIVERED: 12, READ: 20, FAILED: 9 };
    const funnel = broadcastCountersFromStatuses(byStatus);
    const partition = funnelToPartition(funnel);

    expect(partition.sentCount).toBe(byStatus.SENT);
    expect(partition.deliveredCount).toBe(byStatus.DELIVERED);
    expect(partition.readCount).toBe(byStatus.READ);
    expect(partition.failedCount).toBe(byStatus.FAILED);
  });

  it('dado torto não vira contador negativo (clamp em 0)', () => {
    // O funil é monotônico por construção, mas a defesa vale: uma linha
    // corrompida (delivered > sent) não pode produzir -5 na tela.
    const partition = funnelToPartition({
      sentCount: 3,
      deliveredCount: 8,
      readCount: 10,
      failedCount: 0,
    });

    expect(partition.sentCount).toBe(0);
    expect(partition.deliveredCount).toBe(0);
    expect(partition.readCount).toBe(10);
  });
});
