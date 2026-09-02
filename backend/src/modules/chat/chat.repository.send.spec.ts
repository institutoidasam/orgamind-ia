import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatRepository } from './chat.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('ChatRepository send/read', () => {
  let prisma: MockProxy<PrismaService>;
  let repo: ChatRepository;
  beforeEach(() => { prisma = mockDeep<PrismaService>(); repo = new ChatRepository(prisma); });

  it('createOutboundMessage creates an OUTBOUND QUEUED message', async () => {
    prisma.message.create.mockResolvedValue({ id: 'm1' } as never);
    const id = await repo.createOutboundMessage({ conversationId: 'c1', instanceId: 'i1', contactId: null, content: 'oi', authorUserId: 'u1', botId: null, quotedWaMessageId: null, quotedPreview: null });
    expect(id).toBe('m1');
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ conversationId: 'c1', direction: 'OUTBOUND', kind: 'TEXT', content: 'oi', status: 'QUEUED', authorUserId: 'u1' }),
    }));
  });

  it('markChatSent updates SENT + increments instance sentToday', async () => {
    prisma.message.update.mockResolvedValue({} as never);
    prisma.channel.update.mockResolvedValue({} as never);
    const at = new Date();
    await repo.markChatSent('m1', 'i1', 'WA1', at);
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { status: 'SENT', providerMessageId: 'WA1', sentAt: at } });
    expect(prisma.channel.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { sentToday: { increment: 1 } } });
  });

  it('markChatFailed marks FAILED with truncated error', async () => {
    prisma.message.update.mockResolvedValue({} as never);
    await repo.markChatFailed('m1', 'x'.repeat(600));
    const call = prisma.message.update.mock.calls[0][0] as { data: { status: string; errorMessage: string } };
    expect(call.data.status).toBe('FAILED');
    expect(call.data.errorMessage.length).toBe(500);
  });

  /**
   * A CAUSA do bug relatado pelo cliente: `markChatFailed` gravava só a
   * mensagem já traduzida para PT-BR — o `errorCode` cru do provedor
   * (`gozap.no_token`, `gozap.invalid_recipient`, `gozap.timeout`…) se perdia,
   * e sem ele não havia como diagnosticar uma falha reportada sem acesso ao
   * log da aplicação. O caminho de campanha já persiste `errorCode`; este
   * teste trava que o caminho de chat passa a fazer o mesmo — verificando o
   * ARGUMENTO passado ao Prisma (o mock ignora `where`; é `data` que importa).
   */
  it('markChatFailed grava o errorCode do provedor no argumento passado ao Prisma', async () => {
    prisma.message.update.mockResolvedValue({} as never);
    await repo.markChatFailed('m1', 'Timeout ao falar com o GoZap', 'gozap.timeout');
    const call = prisma.message.update.mock.calls[0][0] as { data: { errorCode: string | null } };
    expect(call.data.errorCode).toBe('gozap.timeout');
  });

  it('markChatFailed grava um SEGUNDO errorCode distinto (não é um valor fixo/hardcoded)', async () => {
    prisma.message.update.mockResolvedValue({} as never);
    await repo.markChatFailed('m2', 'Canal sem token de instância', 'gozap.no_token');
    const call = prisma.message.update.mock.calls[0][0] as { data: { errorCode: string | null } };
    expect(call.data.errorCode).toBe('gozap.no_token');
  });

  it('markChatFailed grava errorCode NULL quando o erro não tem código (não omite o campo)', async () => {
    prisma.message.update.mockResolvedValue({} as never);
    await repo.markChatFailed('m3', 'down');
    const call = prisma.message.update.mock.calls[0][0] as { data: { errorCode: string | null } };
    expect(call.data.errorCode).toBeNull();
  });

  it('getUnreadInboundKeys maps inbound providerMessageIds to read keys (paginated)', async () => {
    prisma.message.findMany.mockResolvedValue([{ id: 'r1', providerMessageId: 'A' }, { id: 'r2', providerMessageId: 'B' }] as never);
    const { keys } = await repo.getUnreadInboundKeys('c1', '55@s.whatsapp.net', 200);
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'c1', direction: 'INBOUND', providerMessageId: { not: null } },
    }));
    expect(keys).toEqual([
      { remoteJid: '55@s.whatsapp.net', fromMe: false, id: 'A' },
      { remoteJid: '55@s.whatsapp.net', fromMe: false, id: 'B' },
    ]);
  });
});
