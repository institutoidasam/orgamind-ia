import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mockDeep,
  type MockProxy,
  type DeepMockProxy,
} from 'vitest-mock-extended';
import { ChatService, ChatProviderNoReplyError } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { resolveConversationForOutbound } from './resolve-conversation';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

vi.mock('./resolve-conversation', async (orig) => ({
  ...(await orig<object>()),
  resolveConversationForOutbound: vi.fn(),
}));

const PHONE = '+5592991234567';
const conv = {
  id: 'conv1',
  instanceId: 'ch1',
  phoneE164: PHONE,
  remoteJid: '5592991234567@s.whatsapp.net',
  contactId: 'c1',
  unreadCount: 0,
  instance: {
    id: 'ch1',
    evolutionInstanceName: 'orgamind',
    provider: 'EVOLUTION',
  },
};

let repo: MockProxy<ChatRepository>;
let events: MockProxy<ChatEventsService>;
let wa: MockProxy<WhatsappProvidersService>;
let prisma: DeepMockProxy<PrismaService>;
let svc: ChatService;

beforeEach(() => {
  vi.mocked(resolveConversationForOutbound).mockReset();
  repo = mockDeep<ChatRepository>();
  events = mockDeep<ChatEventsService>();
  wa = mockDeep<WhatsappProvidersService>();
  prisma = mockDeep<PrismaService>();
  wa.supportsInboxChatFor.mockReturnValue(true);
  repo.getConversationForSend.mockResolvedValue(conv as never);
  svc = new ChatService(repo, events, wa, prisma, mockDeep<AuditService>());
});

const prepareArgs = {
  instanceId: 'ch1',
  contactId: 'c1',
  phoneE164: PHONE,
  text: 'Oi equipe',
  authorUserId: 'u-admin',
};

describe('ChatService.prepareTeamMessage', () => {
  beforeEach(() => {
    vi.mocked(resolveConversationForOutbound).mockResolvedValue({
      id: 'conv1',
      contactId: 'c1',
      lastMessageAt: null,
    });
    repo.createOutboundMessage.mockResolvedValue('m1');
  });

  it('resolve a conversa, grava QUEUED com authorUserId e pausa o bot, sem chamar o provedor', async () => {
    await expect(svc.prepareTeamMessage(prepareArgs)).resolves.toEqual({
      messageId: 'm1',
    });
    expect(resolveConversationForOutbound).toHaveBeenCalledWith(prisma, {
      instanceId: 'ch1',
      contactId: 'c1',
      phoneE164: PHONE,
    });
    expect(repo.createOutboundMessage.mock.calls).toContainEqual([
      expect.objectContaining({
        conversationId: 'conv1',
        authorUserId: 'u-admin',
        botId: null,
        content: 'Oi equipe',
      }),
    ]);
    expect(repo.setBotPaused.mock.calls).toContainEqual(['conv1']);
    expect(wa.sendChatText.mock.calls).toHaveLength(0);
    expect(wa.sendChatTextVia.mock.calls).toHaveLength(0);
    expect(events.publish.mock.calls).toHaveLength(0);
  });

  it('canal sem chat recusa antes de gravar', async () => {
    wa.supportsInboxChatFor.mockReturnValue(false);
    await expect(svc.prepareTeamMessage(prepareArgs)).rejects.toBeInstanceOf(
      ChatProviderNoReplyError,
    );
    expect(repo.createOutboundMessage.mock.calls).toHaveLength(0);
    expect(repo.setBotPaused.mock.calls).toHaveLength(0);
  });
});

function primeSend(): void {
  prisma.message.findUnique.mockResolvedValue({
    conversationId: 'conv1',
  } as never);
  prisma.message.updateMany.mockResolvedValue({ count: 1 });
}

describe('ChatService.sendTeamMessage', () => {
  beforeEach(primeSend);

  it('envia a linha existente e publica', async () => {
    wa.sendChatText.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    const out = await svc.sendTeamMessage({
      messageId: 'm1',
      text: 'Oi equipe',
    });
    expect(out).toEqual({
      messageId: 'm1',
      sent: true,
      errorCode: null,
      retryable: false,
    });
    expect(repo.markChatSent.mock.calls).toContainEqual([
      'm1',
      'ch1',
      'p1',
      expect.any(Date),
    ]);
    expect(repo.createOutboundMessage.mock.calls).toHaveLength(0);
    expect(repo.setBotPaused.mock.calls).toHaveLength(0);
    expect(events.publish.mock.calls).toContainEqual([
      expect.objectContaining({
        type: 'message.created',
        conversationId: 'conv1',
        messageId: 'm1',
      }),
    ]);
    expect(events.publish.mock.calls).toContainEqual([
      expect.objectContaining({
        type: 'conversation.updated',
        conversationId: 'conv1',
      }),
    ]);
    expect(repo.touchConversationOutbound.mock.calls).toContainEqual([
      'conv1',
      'Oi equipe',
    ]);
  });
});

describe('ChatService.sendTeamMessage — claim', () => {
  beforeEach(primeSend);

  it('marca a linha como SENDING antes do provedor e reaproveita o id (QUEUED ou FAILED)', async () => {
    wa.sendChatText.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    await svc.sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' });
    expect(prisma.message.updateMany.mock.calls).toContainEqual([
      {
        where: { id: 'm1', status: { in: ['QUEUED', 'FAILED'] } },
        data: {
          status: 'SENDING',
          sendingAt: expect.any(Date) as Date,
          failedAt: null,
          errorMessage: null,
          errorCode: null,
        },
      },
    ]);
    const [claimOrder] = prisma.message.updateMany.mock.invocationCallOrder;
    const [sendOrder] = wa.sendChatText.mock.invocationCallOrder;
    expect(claimOrder).toBeLessThan(sendOrder);
    expect(repo.createOutboundMessage.mock.calls).toHaveLength(0);
  });

  it('claim com count 0 lança e não chama o provedor', async () => {
    prisma.message.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' }),
    ).rejects.toMatchObject({ code: 'team_whatsapp.not_claimed' });
    expect(wa.sendChatText.mock.calls).toHaveLength(0);
    expect(wa.sendChatTextVia.mock.calls).toHaveLength(0);
    expect(repo.markChatSent.mock.calls).toHaveLength(0);
    expect(repo.markChatFailed.mock.calls).toHaveLength(0);
    expect(events.publish.mock.calls).toHaveLength(0);
  });

  it('Message sem conversa lança NotFound sem claim nem provedor', async () => {
    prisma.message.findUnique.mockResolvedValue(null);
    await expect(
      svc.sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' }),
    ).rejects.toMatchObject({ code: 'message.not_found' });
    expect(prisma.message.updateMany.mock.calls).toHaveLength(0);
    expect(wa.sendChatText.mock.calls).toHaveLength(0);
  });
});

describe('ChatService.isRedispatchableFailure', () => {
  it.each([
    [null, false],
    ['gozap.timeout', false],
    ['zernio.timeout', false],
    ['twilio.timeout', false],
    ['sending_stuck', false],
    // Timeout da Evolution e o fallback `evolution.unknown` (socket hang up,
    // ECONNRESET, EAI_AGAIN…) não provam que nada saiu: nunca reenviar.
    ['evolution.timeout', false],
    ['evolution.unknown', false],
    ['qualquer.timeout', false],
    ['evolution.not_connected', true],
    ['evolution.unreachable', true],
  ])('%s → %s', (code, expected) => {
    expect(svc.isRedispatchableFailure(code)).toBe(expected);
  });
});

const send = () => svc.sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' });

describe('ChatService.sendTeamMessage — falha do provedor', () => {
  beforeEach(primeSend);

  it('falha transitória do provedor é retentável', async () => {
    wa.sendChatText.mockRejectedValue(
      new WhatsappSendError('down', 'evolution.not_connected', 'x', false),
    );
    await expect(send()).resolves.toEqual({
      messageId: 'm1',
      sent: false,
      errorCode: 'evolution.not_connected',
      retryable: true,
    });
    expect(repo.markChatFailed.mock.calls).toContainEqual([
      'm1',
      expect.any(String),
      'evolution.not_connected',
    ]);
    expect(events.publish.mock.calls).toContainEqual([
      expect.objectContaining({ type: 'message.created' }),
    ]);
    expect(events.publish.mock.calls).not.toContainEqual([
      expect.objectContaining({ type: 'conversation.updated' }),
    ]);
    expect(repo.touchConversationOutbound.mock.calls).toHaveLength(0);
  });
});

describe('ChatService.sendTeamMessage — falha não retentável', () => {
  beforeEach(primeSend);

  it.each([
    [
      'timeout do GoZap',
      new WhatsappSendError('t', 'gozap.timeout', 'x', false),
      'gozap.timeout',
    ],
    [
      'timeout da Evolution',
      new WhatsappSendError('t', 'evolution.timeout', 'x', false),
      'evolution.timeout',
    ],
    [
      'erro desconhecido da Evolution',
      new WhatsappSendError('u', 'evolution.unknown', 'x', false),
      'evolution.unknown',
    ],
    [
      'erro fatal',
      new WhatsappSendError('f', 'gozap.invalid_recipient', 'x', true),
      'gozap.invalid_recipient',
    ],
    ['erro que não é WhatsappSendError', new Error('db'), null],
    [
      'WhatsappSendError sem providerErrorCode',
      new WhatsappSendError('sem código'),
      null,
    ],
  ])('%s não é retentável', async (_name, err, errorCode) => {
    wa.sendChatText.mockRejectedValue(err);
    await expect(send()).resolves.toEqual({
      messageId: 'm1',
      sent: false,
      errorCode,
      retryable: false,
    });
    expect(repo.markChatFailed.mock.calls).toContainEqual([
      'm1',
      expect.any(String),
      errorCode,
    ]);
  });
});
