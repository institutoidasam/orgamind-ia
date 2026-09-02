import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import { repairCampaignMessageContent } from './repair-campaign-message-content';

/**
 * REPARO DAS MENSAGENS JÁ ENVIADAS — o fix do worker só cobre envios futuros; as
 * campanhas que já saíram continuam com `content` NULL (a bolha vazia que o
 * operador vê hoje). Este script reconstrói o texto pelas MESMAS funções do
 * envio e reavança o resumo das conversas afetadas.
 */
describe('repairCampaignMessageContent', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.conversation.findUnique.mockResolvedValue({ lastMessageAt: null } as never);
    db.message.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-11T12:02:00Z'), content: 'Olá Andre', direction: 'OUTBOUND',
    } as never);
  });

  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'm1',
      variables: { nome: 'Andre' },
      conversationId: 'conv-1',
      contact: { name: 'Andre Lima', city: 'Manaus', group: null, phoneE164: '+5592995550101' },
      campaign: { template: { body: 'Olá {{nome}}, tudo bem?', metaName: 'bem_vindo_mg', variables: ['nome'] } },
      ...over,
    };
  }

  it('reconstrói o corpo renderizado do template na Message', async () => {
    db.message.findMany.mockResolvedValue([row()] as never);

    const res = await repairCampaignMessageContent(db);

    expect(res.repaired).toBe(1);
    expect(db.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' }, data: { content: 'Olá Andre, tudo bem?' },
    });
  });

  it('completa a variável que o variableMap não cobriu, do jeito que o worker faz', async () => {
    db.message.findMany.mockResolvedValue([row({ variables: {} })] as never);

    await repairCampaignMessageContent(db);

    expect(db.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' }, data: { content: 'Olá Andre Lima, tudo bem?' },
    });
  });

  it('sem corpo renderizável (mídia pura/interativo), grava o placeholder — nunca bolha muda', async () => {
    db.message.findMany.mockResolvedValue([
      row({ campaign: { template: { body: '', metaName: 'bem_vindo_mg', variables: [] } } }),
    ] as never);

    await repairCampaignMessageContent(db);

    expect(db.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' }, data: { content: '[Template: bem_vindo_mg]' },
    });
  });

  it('reavança o resumo das conversas tocadas (a linha sem preview/horário na lista lateral)', async () => {
    db.message.findMany.mockResolvedValue([row()] as never);

    const res = await repairCampaignMessageContent(db);

    expect(res.conversations).toBe(1);
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: {
        lastMessageAt: new Date('2026-07-11T12:02:00Z'),
        lastMessagePreview: 'Olá Andre',
        lastMessageDirection: 'OUTBOUND',
      },
    });
  });

  it('só busca mensagens de campanha OUTBOUND com content NULL (nunca sobrescreve texto existente)', async () => {
    db.message.findMany.mockResolvedValue([] as never);

    await repairCampaignMessageContent(db);

    const where = (db.message.findMany.mock.calls[0][0] as any).where;
    expect(where).toEqual(
      expect.objectContaining({ direction: 'OUTBOUND', content: null, campaignId: { not: null } }),
    );
  });
});
