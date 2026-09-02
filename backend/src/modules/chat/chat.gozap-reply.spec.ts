import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { shouldReply } from '../bots/bot-reply.guard';

/**
 * N20/N21 — responder pelo inbox num canal GOZAP.
 *
 * `dispatchOutbound` roteava por `hasSessionWindow(provider)`: TWILIO/ZERNIO
 * pelo registry e TODO O RESTO no ramo Evolution, que exige
 * `evolutionInstanceName` e estourava `ChannelNotEvolutionError`. Num canal
 * GOZAP — cujo ENVIO funciona em produção, testado com mensagem real — o
 * operador levava um erro técnico na cara. E, assim que o parser de entrada
 * passou a viver (C9), o bot Dify também passou a ser acionado nesses canais:
 * sem este conserto, toda resposta automática falharia do mesmo jeito.
 */

const gozapInstance = {
  id: 'ig',
  evolutionInstanceName: null,
  provider: 'GOZAP',
  phoneE164: '+5592319979 92'.replace(/\s/g, ''),
  twilioMessagingServiceSid: null,
  zernioAccountId: null,
};

const conv = {
  id: 'cg',
  instanceId: 'ig',
  phoneE164: '+5592987654321',
  remoteJid: '5592987654321@s.whatsapp.net',
  contactId: 'ct1',
  unreadCount: 1,
  instance: gozapInstance,
  // GOZAP não tem janela de 24h (Baileys-like) — mas o valor está aqui para
  // provar que a resposta NÃO depende dela.
  lastInboundAt: new Date(Date.now() - 40 * 60 * 60 * 1000),
};

describe('ChatService — resposta manual por GOZAP', () => {
  let repo: MockProxy<ChatRepository>;
  let events: MockProxy<ChatEventsService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let prisma: MockProxy<PrismaService>;
  let svc: ChatService;

  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    events = mockDeep<ChatEventsService>();
    wa = mockDeep<WhatsappProvidersService>();
    prisma = mockDeep<PrismaService>();
    svc = new ChatService(repo, events, wa, prisma, mockDeep<AuditService>());
    repo.getConversationForSend.mockResolvedValue(conv as never);
    repo.createOutboundMessage.mockResolvedValue('mg');
    repo.getMessageById.mockResolvedValue({ id: 'mg', status: 'SENT' } as never);
    wa.supportsInboxChatFor.mockReturnValue(true);
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      gozapInstanceToken: 'CIPHERTEXT',
    } as never);
  });

  it('envia pelo registry com o canal GOZAP e o token cifrado da instância — nunca pelo ramo Evolution', async () => {
    wa.sendChatTextVia.mockResolvedValue({
      providerMessageId: 'MSGCHAT1',
      acceptedAt: new Date(),
    } as never);

    const out = await svc.sendReply('cg', 'u1', { text: 'Obrigado pela mensagem!' });

    expect(wa.sendChatTextVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'GOZAP', gozapInstanceToken: 'CIPHERTEXT' }),
      expect.objectContaining({ toE164: '+5592987654321', text: 'Obrigado pela mensagem!' }),
    );
    // O ramo Evolution estouraria ChannelNotEvolutionError.
    expect(wa.sendChatText).not.toHaveBeenCalled();
    expect(repo.markChatSent).toHaveBeenCalledWith('mg', 'ig', 'MSGCHAT1', expect.any(Date));
    expect(out.status).toBe('SENT');
  });

  /**
   * Só o canal GOZAP paga a consulta extra do token. Um canal ZERNIO/TWILIO já
   * carrega o remetente no próprio `conv.instance`.
   */
  it('não busca token nenhum para um canal sem token de instância (ZERNIO)', async () => {
    repo.getConversationForSend.mockResolvedValue({
      ...conv,
      lastInboundAt: new Date(),
      instance: { ...gozapInstance, provider: 'ZERNIO', zernioAccountId: 'acc_1' },
    } as never);
    wa.sendChatTextVia.mockResolvedValue({
      providerMessageId: 'wamid.Z1',
      acceptedAt: new Date(),
    } as never);

    await svc.sendReply('cg', 'u1', { text: 'oi' });

    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
  });

  /**
   * O timeout do GoZap é INDETERMINADO: o POST pode ter sido aceito. A mensagem
   * genérica de falha transitória diz "A mensagem NÃO foi enviada" e convida o
   * operador a reenviar — numa campanha eleitoral isso é uma pessoa real
   * recebendo a mesma mensagem duas vezes.
   */
  it('timeout do GoZap NÃO diz "não foi enviada" — avisa que o status é indeterminado', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError(
        'Timeout ao falar com o GoZap — status indeterminado, não reenviar automaticamente.',
        'gozap.timeout',
        'socket hang up',
        false,
      ),
    );
    repo.getMessageById.mockResolvedValue({ id: 'mg', status: 'FAILED' } as never);

    await svc.sendReply('cg', 'u1', { text: 'oi' });

    const [, message] = repo.markChatFailed.mock.calls[0];
    expect(message).not.toMatch(/NÃO foi enviada/);
    expect(message).toMatch(/pode ter sido enviada/i);
  });

  /**
   * Recusa CLARA na tela é melhor que erro técnico. Um provider sem a
   * capacidade `inboxChat` (META hoje) não deve produzir
   * `ChannelNotEvolutionError` — nem uma mensagem FAILED silenciosa.
   */
  it('provider sem inboxChat: recusa ANTES de criar a mensagem, com texto acionável', async () => {
    wa.supportsInboxChatFor.mockReturnValue(false);

    await expect(svc.sendReply('cg', 'u1', { text: 'oi' })).rejects.toMatchObject({
      code: 'chat.provider_no_inbox_reply',
      status: 409,
    });
    expect(repo.createOutboundMessage).not.toHaveBeenCalled();
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
    expect(wa.sendChatText).not.toHaveBeenCalled();
  });

  it('EVOLUTION continua pelo caminho por instanceName (nada regride)', async () => {
    repo.getConversationForSend.mockResolvedValue({
      ...conv,
      instance: { ...gozapInstance, provider: 'EVOLUTION', evolutionInstanceName: 'picoa' },
    } as never);
    wa.sendChatText.mockResolvedValue({
      providerMessageId: 'E1',
      acceptedAt: new Date(),
    } as never);

    await svc.sendReply('cg', 'u1', { text: 'oi' });

    expect(wa.sendChatText).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'picoa', toE164: '+5592987654321' }),
    );
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
  });

  /**
   * N21 — o bot Dify. `shouldReply` já libera GOZAP (é provider de sessão), e
   * até agora o ramo era morto porque nenhum INBOUND GOZAP era persistido. Com
   * o parser vivo o bot passa a ser acionado: o despacho tem de sair de verdade.
   */
  it('a resposta do BOT também sai pelo registry num canal GOZAP', async () => {
    wa.sendChatTextVia.mockResolvedValue({
      providerMessageId: 'BOT1',
      acceptedAt: new Date(),
    } as never);
    repo.createOutboundMessage.mockResolvedValue('mbot');

    await svc.sendBotReply('cg', 'Posso ajudar?', 'bot1');

    expect(wa.sendChatTextVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'GOZAP', gozapInstanceToken: 'CIPHERTEXT' }),
      expect.objectContaining({ text: 'Posso ajudar?' }),
    );
    expect(repo.markChatSent).toHaveBeenCalledWith('mbot', 'ig', 'BOT1', expect.any(Date));
    // "digitando…" é recurso Evolution/Baileys — num canal GOZAP é no-op.
    expect(wa.sendPresence).not.toHaveBeenCalled();
  });

  it('o guard do bot libera GOZAP (provider de sessão) — o buraco era só o despacho', () => {
    expect(
      shouldReply({
        channelProvider: 'GOZAP',
        hasBot: true,
        botIsActive: true,
        contactOptedOut: false,
        botPausedAt: null,
        direction: 'INBOUND',
        kind: 'TEXT',
      }),
    ).toBe(true);
  });
});
