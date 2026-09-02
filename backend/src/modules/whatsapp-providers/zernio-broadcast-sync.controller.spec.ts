import { describe, it, expect, vi } from 'vitest';
import { ZernioBroadcastSyncController } from './zernio-broadcast-sync.controller';
import { INDETERMINATE_DELIVERY_MARK } from './zernio-broadcast-send.service';

function harness(rows: unknown[] = []) {
  const prisma = {
    message: { findMany: vi.fn(async () => rows) },
  };
  const queue = { add: vi.fn(async () => ({ id: 'j' })) };
  const ctrl = new ZernioBroadcastSyncController(
    queue as never,
    prisma as never,
  );
  return { ctrl, prisma, queue };
}

/**
 * ★ POR QUE ESTE ENDPOINT EXISTE
 *
 * Quando o `POST /send` do Zernio não responde, o lote fica SENT sem que
 * ninguém saiba se foi entregue (ver `settleIndeterminateSend`). O código
 * mandava o operador "conferir o painel do Zernio antes de redisparar" — só que
 * SENT conta como RECEBIDO em todo recorte do produto: o "Disparar novamente"
 * (modo `unreached`) e o tick recorrente pulam justamente essas pessoas, e o
 * único modo que as alcança (`full`) reenviaria para a audiência INTEIRA.
 *
 * A instrução era, portanto, uma ordem que o operador não conseguia executar.
 * Este recorte é o que a torna executável: ele LISTA nome e telefone de quem
 * ficou na dúvida, para virar uma campanha nova só com essas pessoas.
 */
describe('GET indeterminate-deliveries — o recorte que torna a instrução executável', () => {
  it('★ seleciona pelo MARCADOR, não por "SENT sem wamid" (que é toda mensagem recém-disparada)', async () => {
    const h = harness();

    await h.ctrl.indeterminateDeliveries('camp1');

    const [arg] = h.prisma.message.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; select?: unknown },
    ];
    expect(arg.where).toMatchObject({
      campaignId: 'camp1',
      status: 'SENT',
      errorMessage: { startsWith: INDETERMINATE_DELIVERY_MARK },
    });
    // O vínculo com o disparo é o que permite conferir ESTE broadcast no painel
    // do Zernio — sem ele o operador não sabe qual disparo procurar.
    expect(arg.where.zernioBroadcastId).toEqual({ not: null });
  });

  it('★ devolve o que o operador precisa para agir: telefone e nome de cada pessoa', async () => {
    const h = harness([
      {
        id: 'm1',
        sentAt: new Date('2026-08-10T10:00:00Z'),
        contact: { id: 'c1', name: 'Maria', phoneE164: '+5592991110001' },
        zernioBroadcast: { zernioId: 'bc_9', name: 'Campanha MG · orgamind 1234' },
      },
    ]);

    const res = await h.ctrl.indeterminateDeliveries('camp1');

    expect(res.total).toBe(1);
    expect(res.contacts[0]).toMatchObject({
      messageId: 'm1',
      contactId: 'c1',
      name: 'Maria',
      phoneE164: '+5592991110001',
      zernioBroadcastId: 'bc_9',
    });
    // E o remédio vem junto com a lista — em texto que descreve algo que o
    // produto de fato oferece.
    expect(res.comoAgir).toEqual(expect.stringContaining('campanha nova'));
  });
});
