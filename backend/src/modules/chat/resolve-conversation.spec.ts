import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { resolveConversationForOutbound, jidFromPhone } from './resolve-conversation';

type Db = Parameters<typeof resolveConversationForOutbound>[0];

describe('resolveConversationForOutbound', () => {
  let db: MockProxy<Db>;

  beforeEach(() => {
    db = mockDeep<Db>();
  });

  it('reaproveita a conversa que o ingest criou com o JID LEGADO de 8 dígitos (BR)', async () => {
    // O contato está salvo com o 9 (+5592995550101), mas o WhatsApp/Meta reporta
    // o wa_id na forma legada — a conversa REAL tem remoteJid '559295550101@…'.
    db.conversation.findFirst.mockResolvedValue({
      id: 'conv-real', contactId: 'c1', lastMessageAt: new Date('2026-07-11T12:00:00Z'),
    });

    const conv = await resolveConversationForOutbound(db, {
      instanceId: 'inst-1', contactId: 'c1', phoneE164: '+5592995550101',
    });

    expect(conv.id).toBe('conv-real');
    // Não cria NADA: uma segunda conversa aqui é a linha duplicada na inbox.
    expect(db.conversation.upsert).not.toHaveBeenCalled();
    const where = (db.conversation.findFirst.mock.calls[0][0] as any).where;
    expect(where.instanceId).toBe('inst-1');
    // procura pelas DUAS variantes BR (com e sem o 9), pelo contato e pelos JIDs
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { contactId: 'c1' },
        { phoneE164: { in: ['+5592995550101', '+559295550101'] } },
        { remoteJid: { in: ['5592995550101@s.whatsapp.net', '559295550101@s.whatsapp.net'] } },
      ]),
    );
  });

  it('reaproveita a conversa @lid do Evolution (achada pelo contactId — o JID não é telefone)', async () => {
    db.conversation.findFirst.mockResolvedValue({
      id: 'conv-lid', contactId: 'c1', lastMessageAt: null,
    });

    const conv = await resolveConversationForOutbound(db, {
      instanceId: 'inst-1', contactId: 'c1', phoneE164: '+5592995550101',
    });

    expect(conv.id).toBe('conv-lid');
    expect(db.conversation.upsert).not.toHaveBeenCalled();
  });

  it('liga o contato à conversa achada pelo telefone quando ela ainda estava solta', async () => {
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-1', contactId: null, lastMessageAt: null });

    const conv = await resolveConversationForOutbound(db, {
      instanceId: 'inst-1', contactId: 'c1', phoneE164: '+5511999999999',
    });

    expect(conv.contactId).toBe('c1');
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' }, data: { contactId: 'c1' },
    });
  });

  it('NÃO rouba a conversa de outro contato', async () => {
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-1', contactId: 'outro', lastMessageAt: null });

    await resolveConversationForOutbound(db, {
      instanceId: 'inst-1', contactId: 'c1', phoneE164: '+5511999999999',
    });

    expect(db.conversation.update).not.toHaveBeenCalled();
  });

  it('só cria (upsert do JID canônico) quando NENHUMA conversa existe', async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    db.conversation.upsert.mockResolvedValue({ id: 'conv-nova', contactId: 'c1', lastMessageAt: null });

    const conv = await resolveConversationForOutbound(db, {
      instanceId: 'inst-1', contactId: 'c1', phoneE164: '+5511999999999',
    });

    expect(conv.id).toBe('conv-nova');
    const up = db.conversation.upsert.mock.calls[0][0] as any;
    expect(up.where).toEqual({
      instanceId_remoteJid: { instanceId: 'inst-1', remoteJid: '5511999999999@s.whatsapp.net' },
    });
  });
});

describe('jidFromPhone', () => {
  it('E.164 -> JID direto do WhatsApp', () => {
    expect(jidFromPhone('+55 (92) 99999-9999')).toBe('5592999999999@s.whatsapp.net');
  });
});
