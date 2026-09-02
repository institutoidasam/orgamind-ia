import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import type { Env } from '../../../shared/config/env.schema';

function makeAdapter() {
  const config = mockDeep<ConfigService<Env>>();
  config.get.mockImplementation((k: unknown) => k === 'EVOLUTION_INSTANCE_NAME' ? 'orgamind' : k === 'EVOLUTION_BASE_URL' ? 'http://x' : k === 'EVOLUTION_API_KEY' ? 'key' : undefined);
  const a = new EvolutionApiAdapter(config);
  const http = { post: vi.fn() };
  (a as unknown as { http: typeof http }).http = http;
  return { a, http };
}

describe('EvolutionApiAdapter history', () => {
  let a: EvolutionApiAdapter; let http: { post: ReturnType<typeof vi.fn> };
  beforeEach(() => { ({ a, http } = makeAdapter()); });

  it('findChats maps the chat list', async () => {
    http.post.mockResolvedValue({ data: [
      { remoteJid: '55@s.whatsapp.net', pushName: 'Maria', profilePicUrl: 'http://p', unreadCount: 2 },
      { remoteJid: '120@g.us', name: 'Grupo', unreadCount: 0 },
    ] });
    const chats = await a.findChats('orgamind');
    expect(http.post).toHaveBeenCalledWith('/chat/findChats/orgamind', {});
    expect(chats[0]).toEqual({ remoteJid: '55@s.whatsapp.net', name: 'Maria', profilePicUrl: 'http://p', unreadCount: 2, altJid: null });
    expect(chats[1].name).toBe('Grupo');
  });

  it('findChats extracts remoteJidAlt (real phone JID) into altJid for @lid chats', async () => {
    http.post.mockResolvedValue({ data: [
      { remoteJid: '192410374131731@lid', pushName: 'Jonathan', unreadCount: 0, lastMessage: { key: { remoteJidAlt: '559293550101@s.whatsapp.net' } } },
    ] });
    const chats = await a.findChats('orgamind');
    expect(chats[0].altJid).toBe('559293550101@s.whatsapp.net');
  });

  it('findMessages posts the query and returns records+paging', async () => {
    http.post.mockResolvedValue({ data: { messages: { total: 3, pages: 1, currentPage: 1, records: [{ key: { id: 'A' } }] } } });
    const r = await a.findMessages('orgamind', '55@s.whatsapp.net', 1, 50);
    expect(http.post).toHaveBeenCalledWith('/chat/findMessages/orgamind', { where: { key: { remoteJid: '55@s.whatsapp.net' } }, page: 1, offset: 50, sort: 'asc' });
    expect(r).toEqual({ records: [{ key: { id: 'A' } }], total: 3, pages: 1, currentPage: 1 });
  });
});
