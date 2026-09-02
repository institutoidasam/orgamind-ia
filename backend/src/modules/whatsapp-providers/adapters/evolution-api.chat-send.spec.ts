import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import type { Env } from '../../../shared/config/env.schema';

function makeAdapter() {
  const config = mockDeep<ConfigService<Env>>();
  config.get.mockImplementation((k: unknown) =>
    k === 'EVOLUTION_BASE_URL' ? 'http://x' : k === 'EVOLUTION_API_KEY' ? 'key' : k === 'EVOLUTION_INSTANCE_NAME' ? 'orgamind' : undefined,
  );
  const a = new EvolutionApiAdapter(config);
  const http = { post: vi.fn() };
  (a as unknown as { http: typeof http }).http = http;
  return { a, http };
}

describe('EvolutionApiAdapter chat-send methods', () => {
  let a: EvolutionApiAdapter;
  let http: { post: ReturnType<typeof vi.fn> };
  beforeEach(() => { ({ a, http } = makeAdapter()); });

  it('sendChatText posts to /message/sendText and returns providerMessageId', async () => {
    http.post.mockResolvedValue({ data: { key: { id: 'WA1' } } });
    const res = await a.sendChatText({ instanceName: 'orgamind', toE164: '+5592999', text: 'oi' });
    expect(http.post).toHaveBeenCalledWith('/message/sendText/orgamind', { number: '5592999', text: 'oi', delay: 0 });
    expect(res.providerMessageId).toBe('WA1');
  });

  it('sendChatText passes a full JID (e.g. @lid) through as the number, unmodified', async () => {
    http.post.mockResolvedValue({ data: { key: { id: 'WA9' } } });
    await a.sendChatText({ instanceName: 'orgamind', toE164: '192410374131731@lid', text: 'oi' });
    expect(http.post).toHaveBeenCalledWith('/message/sendText/orgamind', { number: '192410374131731@lid', text: 'oi', delay: 0 });
  });

  it('sendChatText includes quoted when replying', async () => {
    http.post.mockResolvedValue({ data: { key: { id: 'WA2' } } });
    await a.sendChatText({ instanceName: 'orgamind', toE164: '+5592999', text: 'sim', quotedWaMessageId: 'ORIG', quotedPreview: 'pergunta?' });
    expect(http.post).toHaveBeenCalledWith('/message/sendText/orgamind', expect.objectContaining({
      quoted: { key: { id: 'ORIG' }, message: { conversation: 'pergunta?' } },
    }));
  });

  it('markMessageAsRead posts readMessages (no-op on empty)', async () => {
    http.post.mockResolvedValue({ data: {} });
    await a.markMessageAsRead('orgamind', [{ remoteJid: '55@s.whatsapp.net', fromMe: false, id: 'M1' }]);
    expect(http.post).toHaveBeenCalledWith('/chat/markMessageAsRead/orgamind', { readMessages: [{ remoteJid: '55@s.whatsapp.net', fromMe: false, id: 'M1' }] });
    http.post.mockClear();
    await a.markMessageAsRead('orgamind', []);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('sendPresence posts flat body', async () => {
    http.post.mockResolvedValue({ data: {} });
    await a.sendPresence('orgamind', '+5592999', 'composing', 2000);
    expect(http.post).toHaveBeenCalledWith('/chat/sendPresence/orgamind', { number: '5592999', delay: 2000, presence: 'composing' });
  });

  it('markMessageAsRead/sendPresence swallow errors (best-effort)', async () => {
    http.post.mockRejectedValue(new Error('boom'));
    await expect(a.markMessageAsRead('orgamind', [{ remoteJid: 'x', fromMe: false, id: 'y' }])).resolves.toBeUndefined();
    await expect(a.sendPresence('orgamind', '+55', 'composing')).resolves.toBeUndefined();
  });
});
