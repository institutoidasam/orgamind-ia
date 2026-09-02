import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import { backfillContactValidity } from './backfill-contact-validity';
import { DELIVERY_PROVEN_STATUSES } from '../src/shared/contact-validity';

/**
 * O backfill PASSIVO: quem já recebeu (DELIVERED/READ) e continua com
 * `whatsappValid` NULL passa a valer como válido, sem consultar provedor
 * nenhum. É o que faz o filtro "válidos" deixar de ser vazio no dia 1.
 *
 * O mock do Prisma IGNORA `where` — por isso todo teste aqui asserta o
 * ARGUMENTO da chamada, nunca o retorno.
 */
describe('backfillContactValidity', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneE164: '+5592995550101' },
      { id: 'c2', phoneE164: '+5592986550101' },
    ] as never);
    db.contact.updateMany.mockResolvedValue({ count: 2 } as never);
  });

  it('procura só quem tem entrega DELIVERED/READ e whatsappValid NULL', async () => {
    await backfillContactValidity(db, { apply: true });

    expect(db.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          whatsappValid: null,
          messages: {
            some: {
              direction: 'OUTBOUND',
              status: { in: DELIVERY_PROVEN_STATUSES },
            },
          },
        },
        select: { id: true, phoneE164: true },
      }),
    );
  });

  // IDEMPOTÊNCIA + "não toca em quem já é false": o `whatsappValid: null` é
  // REPETIDO no update, e não só no select. Entre as duas queries um envio
  // pode ter marcado a linha como false; sem esta guarda o backfill
  // RESSUSCITARIA um inválido confirmado como válido.
  it('só escreve em quem ainda está NULL, e escreve true + whatsappCheckedAt', async () => {
    await backfillContactValidity(db, { apply: true });

    expect(db.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['c1', 'c2'] },
          whatsappValid: null,
        }),
        data: expect.objectContaining({ whatsappValid: true }),
      }),
    );
    const call = db.contact.updateMany.mock.calls[0][0] as {
      data: { whatsappCheckedAt: Date };
    };
    expect(call.data.whatsappCheckedAt).toBeInstanceOf(Date);
  });

  it('dry-run (padrão) NÃO escreve nada e ainda assim conta os candidatos', async () => {
    const r = await backfillContactValidity(db);
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(r).toEqual(
      expect.objectContaining({ candidates: 2, updated: 0 }),
    );
  });

  it('sem candidato nenhum, não chama updateMany (idempotente numa base já corrigida)', async () => {
    db.contact.findMany.mockResolvedValue([] as never);
    const r = await backfillContactValidity(db, { apply: true });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    expect(r.candidates).toBe(0);
    expect(r.updated).toBe(0);
  });

  it('as amostras trazem telefone + id (o log do deploy as mascara)', async () => {
    const r = await backfillContactValidity(db, { apply: true });
    expect(r.samples[0]).toBe('+5592995550101 [c1]');
  });
});
