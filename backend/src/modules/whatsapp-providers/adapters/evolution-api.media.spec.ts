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

describe('EvolutionApiAdapter media', () => {
  let a: EvolutionApiAdapter; let http: { post: ReturnType<typeof vi.fn> };
  beforeEach(() => { ({ a, http } = makeAdapter()); });

  it('getMediaBase64 posts the message key and returns base64+mime', async () => {
    http.post.mockResolvedValue({ data: { base64: 'QUJD', mimetype: 'image/jpeg', fileName: 'x.jpg' } });
    const r = await a.getMediaBase64('orgamind', { id: 'WA1', remoteJid: '55@s.whatsapp.net', fromMe: false });
    expect(http.post).toHaveBeenCalledWith(
      '/chat/getBase64FromMediaMessage/orgamind',
      { message: { key: { id: 'WA1', remoteJid: '55@s.whatsapp.net', fromMe: false } }, convertToMp4: false },
      expect.objectContaining({ maxContentLength: expect.any(Number), maxBodyLength: expect.any(Number) }),
    );
    expect(r).toEqual({ base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'x.jpg' });
  });

  it('sendMedia posts the flat body and returns providerMessageId', async () => {
    http.post.mockResolvedValue({ data: { key: { id: 'WA2' } } });
    const r = await a.sendMedia({ instanceName: 'orgamind', toE164: '+5592', mediatype: 'image', mimetype: 'image/png', mediaBase64: 'QQ==', fileName: 'a.png', caption: 'oi' });
    expect(http.post).toHaveBeenCalledWith('/message/sendMedia/orgamind', expect.objectContaining({ number: '5592', mediatype: 'image', mimetype: 'image/png', media: 'QQ==', fileName: 'a.png', caption: 'oi', delay: 0 }));
    expect(r.providerMessageId).toBe('WA2');
  });

  it('sendWhatsAppAudio posts audio and returns providerMessageId', async () => {
    http.post.mockResolvedValue({ data: { key: { id: 'WA3' } } });
    const r = await a.sendWhatsAppAudio({ instanceName: 'orgamind', toE164: '+5592', audioBase64: 'QQ==' });
    expect(http.post).toHaveBeenCalledWith('/message/sendWhatsAppAudio/orgamind', expect.objectContaining({ number: '5592', audio: 'QQ==', delay: 0 }));
    expect(r.providerMessageId).toBe('WA3');
  });
});
