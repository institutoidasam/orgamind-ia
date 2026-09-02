import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import {
  normalizeForCompare,
  electCanonicalLabel,
  normalizeContactLabels,
} from './normalize-contact-labels';

/**
 * NORMALIZAÇÃO RETROATIVA de cidade/grupo/tags (spec 2026-08-25, §2.2). O
 * combobox do frontend impede duplicata NOVA; este script fecha a lacuna
 * das que JÁ EXISTEM no banco. O mock do Prisma IGNORA `where` — por isso
 * todo teste aqui asserta o ARGUMENTO da chamada, nunca o retorno.
 */
describe('normalizeForCompare', () => {
  it('mesma regra do combobox do frontend: ignora caixa, acento e espaçamento', () => {
    expect(normalizeForCompare('Manaus')).toBe(normalizeForCompare('manaus'));
    expect(normalizeForCompare('São Paulo')).toBe(normalizeForCompare('Sao Paulo'));
    expect(normalizeForCompare('  Manaus  ')).toBe(normalizeForCompare('Manaus'));
  });
});

describe('electCanonicalLabel', () => {
  it('o rótulo mais frequente vence', () => {
    const winner = electCanonicalLabel([
      { label: 'Manaus', count: 40, oldestCreatedAt: new Date('2026-01-01') },
      { label: 'manaus', count: 2, oldestCreatedAt: new Date('2025-06-01') },
    ]);
    expect(winner).toBe('Manaus');
  });

  it('empate em frequência: o rótulo mais ANTIGO vence', () => {
    const winner = electCanonicalLabel([
      { label: 'Manaus', count: 5, oldestCreatedAt: new Date('2026-03-01') },
      { label: 'MANAUS', count: 5, oldestCreatedAt: new Date('2025-01-01') },
    ]);
    expect(winner).toBe('MANAUS');
  });

  it('empate total: ordem alfabética (pt-BR) decide, de forma reproduzível', () => {
    const same = new Date('2026-01-01');
    const winner = electCanonicalLabel([
      { label: 'zulu', count: 1, oldestCreatedAt: same },
      { label: 'alfa', count: 1, oldestCreatedAt: same },
    ]);
    expect(winner).toBe('alfa');
  });
});

describe('normalizeContactLabels — cidade/grupo (campo escalar)', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockImplementation((args: any) => {
      if (args?.select?.city !== undefined) {
        return Promise.resolve([
          { city: 'Manaus', createdAt: new Date('2026-01-01') },
          { city: 'Manaus', createdAt: new Date('2026-01-02') },
          { city: 'manaus', createdAt: new Date('2025-06-01') },
        ] as never);
      }
      return Promise.resolve([] as never); // group e tags: vazio neste teste
    });
    db.contact.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it('dry-run (padrão) não escreve nada e reporta o cluster com a contagem certa', async () => {
    const r = await normalizeContactLabels(db);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(r.city.clusters).toHaveLength(1);
    expect(r.city.clusters[0]).toEqual(
      expect.objectContaining({ canonical: 'Manaus', contactsAffected: 1 }),
    );
  });

  it('--apply escreve updateMany por VARIANTE (não por contato) — "manaus" vira "Manaus"', async () => {
    await normalizeContactLabels(db, { apply: true });
    expect(db.contact.updateMany).toHaveBeenCalledWith({
      where: { city: 'manaus' },
      data: { city: 'Manaus' },
    });
    // O rótulo já majoritário NUNCA é reescrito — sem isso o script tocaria
    // linhas que já estão certas a cada execução (quebraria idempotência).
    expect(db.contact.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { city: 'Manaus' } }),
    );
  });
});

describe('normalizeContactLabels — tags (campo LISTA, não escalar)', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockImplementation((args: any) => {
      if (args?.select?.tags !== undefined) {
        return Promise.resolve([
          { id: 'c1', tags: ['vip', 'prio'], createdAt: new Date('2026-01-01') },
          { id: 'c2', tags: ['VIP'], createdAt: new Date('2026-03-01') },
          // Canonicalização cria duplicata exata DENTRO do mesmo array
          // ('vip' + 'VIP' → 'vip' + 'vip') — tem que ser removida, não só
          // reescrita. É por isso que tags precisa de lógica própria.
          { id: 'c4', tags: ['vip', 'VIP'], createdAt: new Date('2026-02-01') },
          { id: 'c5', tags: ['vip'], createdAt: new Date('2026-01-05') },
        ] as never);
      }
      return Promise.resolve([] as never); // city/group: vazio neste teste
    });
    db.contact.update.mockResolvedValue({} as never);
  });

  it('elege "vip" por frequência (3×2) e reescreve só quem tem a variante perdedora', async () => {
    const r = await normalizeContactLabels(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c2' },
      data: { tags: ['vip'] },
    });
    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c4' },
      data: { tags: ['vip'] }, // ['vip','VIP'] -> ['vip','vip'] -> dedupe -> ['vip']
    });
    // c1 e c5 já têm só "vip" — não são tocados.
    expect(db.contact.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } }),
    );
    expect(db.contact.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c5' } }),
    );
    expect(r.tags.contactsUpdated).toBe(2);
  });

  it('dry-run (padrão) não chama contact.update', async () => {
    await normalizeContactLabels(db);
    expect(db.contact.update).not.toHaveBeenCalled();
  });
});
