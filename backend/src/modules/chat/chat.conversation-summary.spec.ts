import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

// Characterization tests for the conversation-summary shape produced by BOTH
// ChatService.getConversation and ChatRepository.listConversations. They pin the
// exact mapping (display-name fallback chain, ISO date, null-coalesced relations)
// so the shared toConversationSummary() refactor is behavior-identical.

const fullRow = {
  id: 'c1',
  instanceId: 'i1',
  instance: { name: 'Orgamind BR', botId: 'b1', provider: 'TWILIO', bot: { id: 'b1', name: 'Atendente' } },
  remoteJid: '5592999@s.whatsapp.net',
  phoneE164: '+5592999',
  contactId: 'ct1',
  contact: { name: 'Maria' },
  waName: 'Mary WA',
  profilePicUrl: 'https://pic',
  lastMessageAt: new Date('2026-06-15T12:00:00.000Z'),
  lastMessagePreview: 'oi',
  lastMessageDirection: 'INBOUND',
  unreadCount: 3,
  assignedUserId: 'u9',
  assignedUser: { name: 'Ana' },
  botPausedAt: null,
  // T6 (twilio-platform): último inbound → janela de 24h (TWILIO).
  lastInboundAt: new Date('2026-06-15T12:00:00.000Z'),
};

const expectedFull = {
  id: 'c1',
  instanceId: 'i1',
  instanceName: 'Orgamind BR',
  provider: 'TWILIO',
  remoteJid: '5592999@s.whatsapp.net',
  phoneE164: '+5592999',
  contactId: 'ct1',
  displayName: 'Maria',
  waName: 'Mary WA',
  profilePicUrl: 'https://pic',
  lastMessageAt: '2026-06-15T12:00:00.000Z',
  lastMessagePreview: 'oi',
  lastMessageDirection: 'INBOUND',
  unreadCount: 3,
  assignedUserId: 'u9',
  assignedUserName: 'Ana',
  botId: 'b1',
  botName: 'Atendente',
  botPaused: false,
  // lastInboundAt + 24h, ISO — o inbox usa para o countdown da janela.
  twilioWindowExpiresAt: '2026-06-16T12:00:00.000Z',
};

describe('ChatService.getConversation — conversation-summary shape', () => {
  let repo: MockProxy<ChatRepository>;
  let svc: ChatService;
  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    svc = new ChatService(repo, mockDeep<ChatEventsService>(), mockDeep<WhatsappProvidersService>(), mockDeep<PrismaService>(), mockDeep<AuditService>());
  });

  it('maps a fully-populated row to the full summary shape', async () => {
    repo.findConversation.mockResolvedValue({ ...fullRow } as never);
    const out = await svc.getConversation('c1');
    expect(out).toEqual(expectedFull);
  });

  it('falls back instanceName -> "", displayName chain, dates -> null, relations -> null', async () => {
    repo.findConversation.mockResolvedValue({
      id: 'c2', instanceId: 'i1', instance: null, remoteJid: 'r', phoneE164: null,
      contactId: null, contact: null, waName: null, profilePicUrl: null,
      lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null,
      unreadCount: 0, assignedUserId: null, assignedUser: null,
    } as never);
    const out = await svc.getConversation('c2');
    expect(out).toMatchObject({
      instanceName: '',
      provider: 'EVOLUTION',
      displayName: 'Número desconhecido',
      lastMessageAt: null,
      assignedUserId: null,
      assignedUserName: null,
      twilioWindowExpiresAt: null,
    });
  });

  // A janela de 24h é da META, não da Twilio: ZERNIO tem a MESMA regra, e sem
  // este campo a UI não teria como mostrar o countdown nem travar o composer.
  it('twilioWindowExpiresAt é calculado para ZERNIO com lastInboundAt (mesma janela da Meta)', async () => {
    repo.findConversation.mockResolvedValue({
      ...fullRow,
      instance: { ...fullRow.instance, provider: 'ZERNIO' },
    } as never);
    expect((await svc.getConversation('c1')).twilioWindowExpiresAt).toBe('2026-06-16T12:00:00.000Z');
  });

  it('twilioWindowExpiresAt é null para canal ZERNIO sem nenhum inbound (janela nunca abriu)', async () => {
    repo.findConversation.mockResolvedValue({
      ...fullRow, lastInboundAt: null,
      instance: { ...fullRow.instance, provider: 'ZERNIO' },
    } as never);
    expect((await svc.getConversation('c1')).twilioWindowExpiresAt).toBeNull();
  });

  // EVOLUTION (Baileys) não tem janela de sessão — o campo continua null.
  it('twilioWindowExpiresAt é null para provider sem janela (EVOLUTION) mesmo com lastInboundAt', async () => {
    repo.findConversation.mockResolvedValue({
      ...fullRow,
      instance: { ...fullRow.instance, provider: 'EVOLUTION' },
    } as never);
    expect((await svc.getConversation('c1')).twilioWindowExpiresAt).toBeNull();
  });

  it('twilioWindowExpiresAt é null para canal TWILIO sem nenhum inbound', async () => {
    repo.findConversation.mockResolvedValue({ ...fullRow, lastInboundAt: null } as never);
    expect((await svc.getConversation('c1')).twilioWindowExpiresAt).toBeNull();
  });

  it('displayName falls back to waName, then phoneE164', async () => {
    repo.findConversation.mockResolvedValue({
      ...fullRow, contact: null, contactId: null, waName: 'Mary WA',
    } as never);
    expect((await svc.getConversation('c1')).displayName).toBe('Mary WA');

    repo.findConversation.mockResolvedValue({
      ...fullRow, contact: null, contactId: null, waName: null, phoneE164: '+5592999',
    } as never);
    expect((await svc.getConversation('c1')).displayName).toBe('+5592999');
  });

  it('throws NotFound when the conversation does not exist', async () => {
    repo.findConversation.mockResolvedValue(null as never);
    await expect(svc.getConversation('missing')).rejects.toThrow();
  });
});

describe('ChatRepository.listConversations — conversation-summary shape (shared with getConversation)', () => {
  let prisma: MockProxy<PrismaService>;
  let repo: ChatRepository;
  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new ChatRepository(prisma);
  });

  it('maps a fully-populated row identically to getConversation', async () => {
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...fullRow }]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const page = await repo.listConversations({ filter: 'all', page: 1, pageSize: 30 } as never);
    expect(page.items[0]).toEqual(expectedFull);
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 30 });
  });

  it('applies the same fallback chain on a sparse row', async () => {
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: 'c2', instanceId: 'i1', instance: null, remoteJid: 'r', phoneE164: null,
      contactId: null, contact: null, waName: null, profilePicUrl: null,
      lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null,
      unreadCount: 0, assignedUserId: null, assignedUser: null,
    }]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const page = await repo.listConversations({ filter: 'all', page: 1, pageSize: 30 } as never);
    expect(page.items[0]).toMatchObject({
      instanceName: '',
      provider: 'EVOLUTION',
      displayName: 'Número desconhecido',
      lastMessageAt: null,
      assignedUserName: null,
    });
  });
});
