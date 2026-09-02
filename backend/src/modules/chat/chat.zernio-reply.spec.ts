import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

/**
 * O bug vivido em produção: o único canal do cliente é ZERNIO e o inbox NÃO
 * deixava responder — 16 pessoas que responderam à campanha ficaram falando
 * sozinhas. Este spec trava o caminho de resposta manual por ZERNIO de ponta a
 * ponta: dentro da janela ENVIA (pelo mesmo trilho do Twilio, o registry, com o
 * accountId do canal); fora da janela o backend RECUSA ANTES de criar a
 * mensagem (mandar free-form fora da janela é 131047 garantido e queima de
 * cota num número cuja qualidade já está fragilizada).
 */

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MSG = 'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.';
// A mensagem do 131026 vem do zernio-error-mapper e é ACIONÁVEL (o remédio é
// UTILITY, não template de marketing). O chat não pode sobrescrevê-la.
const MARKETING_OFF_MSG =
  'Mensagem não entregável: o destinatário provavelmente DESLIGOU as mensagens de marketing no WhatsApp. Templates UTILITY continuam funcionando.';
// Erro transitório (429/5xx) num canal cloud: o chat NÃO tem reenvio automático,
// então a mensagem do mapper ("— retentando.") seria uma mentira na bolha.
const TRY_AGAIN_MSG =
  'Não foi possível enviar agora (limite de taxa ou instabilidade do provedor). A mensagem NÃO foi enviada — tente novamente em instantes.';

const zernioInstance = {
  id: 'iz', evolutionInstanceName: null, provider: 'ZERNIO',
  phoneE164: '+5592988887777', twilioMessagingServiceSid: null,
  zernioAccountId: 'acc_zernio_123',
};

const openConv = {
  id: 'cz', instanceId: 'iz', phoneE164: '+5592999', remoteJid: '5592999@s.whatsapp.net',
  contactId: 'ct1', unreadCount: 1, instance: zernioInstance,
  lastInboundAt: new Date(Date.now() - 2 * HOUR_MS),
};

describe('ChatService — resposta manual por ZERNIO', () => {
  let repo: MockProxy<ChatRepository>;
  let events: MockProxy<ChatEventsService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatService;

  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    events = mockDeep<ChatEventsService>();
    wa = mockDeep<WhatsappProvidersService>();
    // O ChatService recusa a resposta quando o provider do canal não declara
    // `inboxChat` (fail-closed). O mock profundo devolveria `undefined` — que é
    // recusa — então o suporte é declarado aqui explicitamente.
    wa.supportsInboxChatFor.mockReturnValue(true);
    svc = new ChatService(repo, events, wa, mockDeep<PrismaService>(), mockDeep<AuditService>());
    repo.getConversationForSend.mockResolvedValue(openConv as never);
    repo.createOutboundMessage.mockResolvedValue('mz');
    repo.getMessageById.mockResolvedValue({ id: 'mz', status: 'SENT' } as never);
  });

  // (a) DENTRO da janela → envia e persiste.
  it('dentro da janela: envia pelo registry (sendChatTextVia) com o canal ZERNIO e persiste SENT', async () => {
    wa.sendChatTextVia.mockResolvedValue({ providerMessageId: 'wamid.Z1', acceptedAt: new Date() } as never);

    const out = await svc.sendReply('cz', 'u1', { text: 'Obrigado, Maria!' });

    expect(wa.sendChatTextVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ZERNIO', zernioAccountId: 'acc_zernio_123' }),
      expect.objectContaining({ toE164: '+5592999', text: 'Obrigado, Maria!' }),
    );
    // NUNCA pelo caminho Evolution (que estouraria ChannelNotEvolutionError).
    expect(wa.sendChatText).not.toHaveBeenCalled();
    expect(repo.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cz', instanceId: 'iz', contactId: 'ct1', content: 'Obrigado, Maria!', authorUserId: 'u1' }),
    );
    expect(repo.markChatSent).toHaveBeenCalledWith('mz', 'iz', 'wamid.Z1', expect.any(Date));
    expect(repo.touchConversationOutbound).toHaveBeenCalled();
    expect(out.status).toBe('SENT');
  });

  // (b) FORA da janela → RECUSA (não tenta e falha).
  it('fora da janela (>24h): recusa com 409 chat.twilio_window_closed ANTES de criar a mensagem', async () => {
    repo.getConversationForSend.mockResolvedValue({
      ...openConv, lastInboundAt: new Date(Date.now() - 25 * HOUR_MS),
    } as never);

    await expect(svc.sendReply('cz', 'u1', { text: 'oi' })).rejects.toMatchObject({
      code: 'chat.twilio_window_closed',
      status: 409,
      message: WINDOW_MSG,
    });
    expect(repo.createOutboundMessage).not.toHaveBeenCalled();
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
    expect(wa.sendChatText).not.toHaveBeenCalled();
  });

  it('sem nenhum inbound registrado: recusa (janela nunca abriu)', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...openConv, lastInboundAt: null } as never);
    await expect(svc.sendReply('cz', 'u1', { text: 'oi' })).rejects.toMatchObject({
      code: 'chat.twilio_window_closed',
    });
    expect(repo.createOutboundMessage).not.toHaveBeenCalled();
  });

  it('mapeia o 131047 da Meta (corrida com o fechamento) para a mesma mensagem PT-BR', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError('Fora da janela de 24h — é necessário um template aprovado para reabrir a conversa.', '131047', 'raw', true),
    );
    repo.getMessageById.mockResolvedValue({ id: 'mz', status: 'FAILED' } as never);
    const out = await svc.sendReply('cz', 'u1', { text: 'oi' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('mz', WINDOW_MSG, '131047');
    expect(out.status).toBe('FAILED');
  });

  // 131026 NÃO é "janela fechada". Medido ao vivo (zernio-error-mapper.ts): num
  // broadcast de 120, 36 das 37 falhas foram 131026 = o destinatário DESLIGOU
  // marketing. Se a bolha disser "envie um template", o operador dispara
  // template de MARKETING atrás de template contra uma parede — queimando cota e
  // a qualidade de um número cujo display name a Meta já reprovou.
  it('131026 NÃO vira mensagem de janela: preserva o texto acionável do mapper (marketing desligado)', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError(MARKETING_OFF_MSG, '131026', 'Message Undeliverable', true),
    );
    repo.getMessageById.mockResolvedValue({ id: 'mz', status: 'FAILED' } as never);

    await svc.sendReply('cz', 'u1', { text: 'oi' });

    expect(repo.markChatFailed).toHaveBeenCalledWith('mz', MARKETING_OFF_MSG, '131026');
    expect(repo.markChatFailed).not.toHaveBeenCalledWith('mz', WINDOW_MSG, '131026');
  });

  // O chat NÃO retenta (ver chatFailureMessage). A mensagem do mapper para 429 é
  // "Rate limit do Zernio — retentando." — que na bolha é falso: nada retenta e
  // o operador acha que a mensagem vai sair. Esse é o "envio que falha em
  // silêncio" que o negócio proíbe.
  it('429 do Zernio: a bolha NÃO promete retentativa — diz que não foi enviada e para tentar de novo', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError('Rate limit do Zernio — retentando.', '429', 'Too Many Requests', false),
    );
    repo.getMessageById.mockResolvedValue({ id: 'mz', status: 'FAILED' } as never);

    await svc.sendReply('cz', 'u1', { text: 'oi' });

    const [, msg] = repo.markChatFailed.mock.calls[0] as [string, string];
    expect(msg).toBe(TRY_AGAIN_MSG);
    expect(msg).not.toMatch(/retentando/i);
  });

  it('5xx transitório do Zernio: mesma mensagem honesta (o chat não tem reenvio automático)', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError('Erro interno do Zernio (500) — retentando com backoff.', '500', 'boom', false),
    );
    repo.getMessageById.mockResolvedValue({ id: 'mz', status: 'FAILED' } as never);

    await svc.sendReply('cz', 'u1', { text: 'oi' });

    const [, msg] = repo.markChatFailed.mock.calls[0] as [string, string];
    expect(msg).toBe(TRY_AGAIN_MSG);
    expect(msg).not.toMatch(/retentando/i);
  });
});

// (c) REGRESSÃO: EVOLUTION e TWILIO seguem exatamente como antes.
describe('ChatService — EVOLUTION e TWILIO não regridem', () => {
  let repo: MockProxy<ChatRepository>;
  let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatService;

  const twilio = {
    id: 'i2', evolutionInstanceName: null, provider: 'TWILIO',
    phoneE164: '+14155238886', twilioMessagingServiceSid: null, zernioAccountId: null,
  };

  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    wa = mockDeep<WhatsappProvidersService>();
    // O ChatService recusa a resposta quando o provider do canal não declara
    // `inboxChat` (fail-closed). O mock profundo devolveria `undefined` — que é
    // recusa — então o suporte é declarado aqui explicitamente.
    wa.supportsInboxChatFor.mockReturnValue(true);
    svc = new ChatService(repo, mockDeep<ChatEventsService>(), wa, mockDeep<PrismaService>(), mockDeep<AuditService>());
    repo.createOutboundMessage.mockResolvedValue('m1');
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'SENT' } as never);
  });

  it('EVOLUTION: segue pelo sendChatText por instanceName, sem janela', async () => {
    repo.getConversationForSend.mockResolvedValue({
      id: 'c1', instanceId: 'i1', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: null,
      instance: { id: 'i1', evolutionInstanceName: 'picoa', provider: 'EVOLUTION' },
    } as never);
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);

    const out = await svc.sendReply('c1', 'u1', { text: 'olá' });

    expect(wa.sendChatText).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'picoa', toE164: '+5592999', text: 'olá' }));
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
    expect(out.status).toBe('SENT');
  });

  // EVOLUTION não é canal cloud: a mensagem crua do erro continua chegando ao
  // operador exatamente como antes (nada de mensagem genérica de rate limit).
  it('EVOLUTION: erro do provedor mantém a mensagem crua (comportamento anterior)', async () => {
    repo.getConversationForSend.mockResolvedValue({
      id: 'c1', instanceId: 'i1', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: null,
      instance: { id: 'i1', evolutionInstanceName: 'picoa', provider: 'EVOLUTION' },
    } as never);
    wa.sendChatText.mockRejectedValue(new WhatsappSendError('Evolution sendText returned no message id'));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);

    await svc.sendReply('c1', 'u1', { text: 'olá' });

    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', 'Evolution sendText returned no message id', null);
  });

  it('TWILIO: segue pelo sendChatTextVia dentro da janela e é recusado fora dela', async () => {
    repo.getConversationForSend.mockResolvedValue({
      id: 'c2', instanceId: 'i2', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: new Date(Date.now() - HOUR_MS), instance: twilio,
    } as never);
    wa.sendChatTextVia.mockResolvedValue({ providerMessageId: 'SM1', acceptedAt: new Date() } as never);
    await expect(svc.sendReply('c2', 'u1', { text: 'olá' })).resolves.toBeDefined();
    expect(wa.sendChatTextVia).toHaveBeenCalled();

    vi.clearAllMocks();
    repo.getConversationForSend.mockResolvedValue({
      id: 'c2', instanceId: 'i2', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: new Date(Date.now() - 25 * HOUR_MS), instance: twilio,
    } as never);
    await expect(svc.sendReply('c2', 'u1', { text: 'olá' })).rejects.toMatchObject({
      code: 'chat.twilio_window_closed',
    });
  });

  // O 131026 da TWILIO também tem mensagem própria no twilio-error-mapper e
  // chegava ao operador via chatFailureMessage — engoli-la pela mensagem de
  // janela seria uma MUDANÇA de comportamento do Twilio, que já funciona.
  it('TWILIO: 131026 preserva a mensagem do twilio-error-mapper (não vira mensagem de janela)', async () => {
    const twilioMsg = 'Mensagem não entregável (janela expirada / re-engajamento necessário) — use um template aprovado.';
    repo.getConversationForSend.mockResolvedValue({
      id: 'c2', instanceId: 'i2', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: new Date(Date.now() - HOUR_MS), instance: twilio,
    } as never);
    wa.sendChatTextVia.mockRejectedValue(new WhatsappSendError(twilioMsg, '131026', 'Message Undeliverable', true));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);

    await svc.sendReply('c2', 'u1', { text: 'olá' });

    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', twilioMsg, '131026');
  });

  // 63016 (Twilio) continua sendo a janela — este é o código REAL de free-form
  // fora da janela na Twilio, e o remédio (template) é o certo.
  it('TWILIO: 63016 continua mapeando para a mensagem de janela fechada', async () => {
    repo.getConversationForSend.mockResolvedValue({
      id: 'c2', instanceId: 'i2', phoneE164: '+5592999', remoteJid: 'r', contactId: null, unreadCount: 0,
      lastInboundAt: new Date(Date.now() - HOUR_MS), instance: twilio,
    } as never);
    wa.sendChatTextVia.mockRejectedValue(new WhatsappSendError('raw twilio 63016', '63016', 'out of window', true));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);

    await svc.sendReply('c2', 'u1', { text: 'olá' });

    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', WINDOW_MSG, '63016');
  });
});
