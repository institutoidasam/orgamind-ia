import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatHistorySyncService } from './chat-history-sync.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';

describe('ChatHistorySyncService.syncInstance', () => {
  let prisma: MockProxy<PrismaService>; let wa: MockProxy<WhatsappProvidersService>;
  let mediaQueue: { add: ReturnType<typeof vi.fn> }; let svc: ChatHistorySyncService;
  beforeEach(() => {
    prisma = mockDeep<PrismaService>(); wa = mockDeep<WhatsappProvidersService>();
    mediaQueue = { add: vi.fn() };
    svc = new ChatHistorySyncService(prisma, wa, mediaQueue as never);
    prisma.channel.findUnique.mockResolvedValue({ evolutionInstanceName: 'orgamind' } as never);
    prisma.contact.findUnique.mockResolvedValue(null as never);
    prisma.contact.findMany.mockResolvedValue([] as never);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1' } as never);
    prisma.message.findMany.mockResolvedValue([] as never);
    prisma.message.create.mockResolvedValue({ id: 'm1', media: null } as never);
    prisma.conversation.update.mockResolvedValue({} as never);
  });

  it('skips group chats and imports direct ones', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 },
      { remoteJid: '120@g.us', name: 'Grupo', profilePicUrl: null, unreadCount: 0 },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    const res = await svc.syncInstance('i1');
    expect(wa.findMessages).toHaveBeenCalledTimes(1);
    expect(wa.findMessages).toHaveBeenCalledWith('orgamind', '5592999@s.whatsapp.net', 1, 50);
    expect(prisma.conversation.upsert).toHaveBeenCalledTimes(1);
    expect(res.chats).toBe(1);
  });

  it('imports @lid-addressed chats (kept), still skipping groups/broadcasts', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 },
      { remoteJid: '192410374131731@lid', name: null, profilePicUrl: null, unreadCount: 0 },
      { remoteJid: '120@g.us', name: 'Grupo', profilePicUrl: null, unreadCount: 0 },
      { remoteJid: 'status@broadcast', name: null, profilePicUrl: null, unreadCount: 0 },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    const res = await svc.syncInstance('i1');
    expect(res.chats).toBe(2); // @s.whatsapp.net + @lid; @g.us and broadcast skipped
    expect(wa.findMessages).toHaveBeenCalledWith('orgamind', '192410374131731@lid', 1, 50);
  });

  it('resolves the real phone/number for @lid chats from remoteJidAlt (altJid)', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '192410374131731@lid', name: 'Jonathan', profilePicUrl: null, unreadCount: 0, altJid: '559293550101@s.whatsapp.net' },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    await svc.syncInstance('i1');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ phoneE164: '+559293550101', remoteJid: '192410374131731@lid', waName: 'Jonathan' }),
      }),
    );
  });

  it('dedups: skips the @lid chat when a phone-addressed chat for the same number exists', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '559293550101@s.whatsapp.net', name: 'Jonathan', profilePicUrl: null, unreadCount: 0, altJid: null },
      { remoteJid: '192410374131731@lid', name: 'Jonathan', profilePicUrl: null, unreadCount: 0, altJid: '559293550101@s.whatsapp.net' },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    const res = await svc.syncInstance('i1');
    expect(res.chats).toBe(1); // only the phone-addressed chat
    expect(wa.findMessages).toHaveBeenCalledWith('orgamind', '559293550101@s.whatsapp.net', 1, 50);
    expect(wa.findMessages).not.toHaveBeenCalledWith('orgamind', '192410374131731@lid', 1, 50);
  });

  it('upserts a parsed message idempotently (create when absent)', async () => {
    wa.findChats.mockResolvedValue([{ remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 }] as never);
    wa.findMessages.mockResolvedValue({ records: [{ key: { id: 'WA1', remoteJid: '5592999@s.whatsapp.net', fromMe: false }, message: { conversation: 'oi' }, messageTimestamp: 1700000000 }], total: 1, pages: 1, currentPage: 1 } as never);
    wa.parseInboundChatMessages.mockReturnValue([{ providerMessageId: 'WA1', remoteJid: '5592999@s.whatsapp.net', phoneE164: '+5592999', isGroup: false, fromMe: false, kind: 'TEXT', text: 'oi', receivedAt: new Date(1700000000000) }] as never);
    const res = await svc.syncInstance('i1');
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { providerMessageId: { in: ['WA1'] } } }));
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerMessageId: 'WA1', direction: 'INBOUND', conversationId: 'conv1' }) }));
    expect(res.messages).toBe(1);
  });

  it('stops importing at maxPagesPerChat even when more pages exist', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 },
    ] as never);
    // Always return one new record and report 999 total pages — never naturally terminates.
    wa.findMessages.mockImplementation((_evo: string, _jid: string, page: number) =>
      Promise.resolve({ records: [{ key: { id: `WA-p${page}`, remoteJid: '5592999@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' }, messageTimestamp: 1700000000 }], total: 999, pages: 999, currentPage: page } as never),
    );
    wa.parseInboundChatMessages.mockImplementation((_payload: unknown) => {
      const d = (_payload as { data?: { key?: { id?: string }; message?: Record<string, unknown>; messageTimestamp?: number } })?.data;
      const id = d?.key?.id ?? 'WA-unknown';
      return [{ providerMessageId: id, remoteJid: '5592999@s.whatsapp.net', phoneE164: '+5592999', isGroup: false, fromMe: false, kind: 'TEXT', text: 'hi', receivedAt: new Date(1700000000000) }] as never;
    });
    // No existing messages so every message triggers a create.
    prisma.message.findMany.mockResolvedValue([] as never);

    const cap = 2;
    await svc.syncInstance('i1', cap);

    // findMessages must have been called exactly `cap` times (once per page, capped).
    expect(wa.findMessages).toHaveBeenCalledTimes(cap);
  });

  it('does not re-create an already-imported message', async () => {
    wa.findChats.mockResolvedValue([{ remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 }] as never);
    wa.findMessages.mockResolvedValue({ records: [{ key: { id: 'WA1' } }], total: 1, pages: 1, currentPage: 1 } as never);
    wa.parseInboundChatMessages.mockReturnValue([{ providerMessageId: 'WA1', remoteJid: '5592999@s.whatsapp.net', phoneE164: '+5592999', isGroup: false, fromMe: false, kind: 'TEXT', text: 'oi', receivedAt: new Date() }] as never);
    prisma.message.findMany.mockResolvedValue([{ providerMessageId: 'WA1' }] as never);
    await svc.syncInstance('i1');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  // Bug 1: a re-sync of an @lid chat without altJid resolves phoneE164=null and
  // must NOT clobber a previously-resolved number on the existing conversation.
  it('does not overwrite phoneE164 with null on re-sync of an unresolved @lid chat', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '192410374131731@lid', name: 'Jonathan', profilePicUrl: null, unreadCount: 0, altJid: null },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    await svc.syncInstance('i1');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ phoneE164: undefined }) }),
    );
  });

  // Bug 2: link the conversation to a contact stored under either Brazilian
  // 9th-digit form (match via brazilianPhoneVariants, like the live path).
  it('links to a contact stored under the 9-digit variant when the chat resolves to the 8-digit form', async () => {
    wa.findChats.mockResolvedValue([
      { remoteJid: '559295550101@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 },
    ] as never);
    wa.findMessages.mockResolvedValue({ records: [], total: 0, pages: 1, currentPage: 1 } as never);
    // Exact findUnique would miss it; a busca sobre as variantes acha — e o
    // desempate entre gêmeos é o CANÔNICO (13 díg.), o mesmo do resto do sistema.
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-12', phoneE164: '+559295550101' },
      { id: 'c1', phoneE164: '+5592995550101' },
    ] as never);
    await svc.syncInstance('i1');
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneE164: { in: ['+559295550101', '+5592995550101'] } } }),
    );
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ contactId: 'c1' }) }),
    );
  });

  // Bug 3: importing older history must not drag lastMessageAt/preview below an
  // already-recorded newer (live) message.
  it('does not regress lastMessageAt below a newer already-stored message', async () => {
    wa.findChats.mockResolvedValue([{ remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 }] as never);
    // Conversation already carries a fresh live timestamp.
    const live = new Date('2026-07-01T12:00:00Z');
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', lastMessageAt: live } as never);
    // The imported historical message is OLDER than the live one.
    const old = new Date('2026-06-01T09:00:00Z');
    wa.findMessages.mockResolvedValue({ records: [{ key: { id: 'HIST1' } }], total: 1, pages: 1, currentPage: 1 } as never);
    wa.parseInboundChatMessages.mockReturnValue([{ providerMessageId: 'HIST1', remoteJid: '5592999@s.whatsapp.net', phoneE164: '+5592999', isGroup: false, fromMe: false, kind: 'TEXT', text: 'old msg', receivedAt: old }] as never);
    await svc.syncInstance('i1');
    expect(prisma.conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastMessageAt: old }) }),
    );
  });

  it('still advances lastMessageAt when the imported message is newer than the stored one', async () => {
    wa.findChats.mockResolvedValue([{ remoteJid: '5592999@s.whatsapp.net', name: 'Maria', profilePicUrl: null, unreadCount: 0 }] as never);
    const stored = new Date('2026-06-01T09:00:00Z');
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', lastMessageAt: stored } as never);
    const newer = new Date('2026-07-01T12:00:00Z');
    wa.findMessages.mockResolvedValue({ records: [{ key: { id: 'HIST2' } }], total: 1, pages: 1, currentPage: 1 } as never);
    wa.parseInboundChatMessages.mockReturnValue([{ providerMessageId: 'HIST2', remoteJid: '5592999@s.whatsapp.net', phoneE164: '+5592999', isGroup: false, fromMe: false, kind: 'TEXT', text: 'new msg', receivedAt: newer }] as never);
    await svc.syncInstance('i1');
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastMessageAt: newer }) }),
    );
  });
});
