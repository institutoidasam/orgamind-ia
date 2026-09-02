import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import type { Env } from '../../../shared/config/env.schema';

function makeAdapter() {
  const config = mockDeep<ConfigService<Env>>();
  config.get.mockImplementation((k: unknown) =>
    k === 'EVOLUTION_BASE_URL' ? 'http://x' : k === 'EVOLUTION_API_KEY' ? 'key' : k === 'EVOLUTION_INSTANCE_NAME' ? 'orgamind' : undefined,
  );
  return new EvolutionApiAdapter(config);
}

const base = (data: Record<string, unknown>) => ({ event: 'messages.upsert', instance: 'picoa', data });

describe('EvolutionApiAdapter.parseInboundChatMessages', () => {
  let a: EvolutionApiAdapter;
  beforeEach(() => { a = makeAdapter(); });

  it('parses an inbound direct text message', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '5592999999999@s.whatsapp.net', fromMe: false, id: 'ABC' },
      pushName: 'Maria',
      message: { conversation: 'Olá' },
      messageTimestamp: 1749134001,
    }));
    expect(m.kind).toBe('TEXT');
    expect(m.text).toBe('Olá');
    expect(m.fromMe).toBe(false);
    expect(m.isGroup).toBe(false);
    expect(m.phoneE164).toBe('+5592999999999');
    expect(m.remoteJid).toBe('5592999999999@s.whatsapp.net');
    expect(m.providerMessageId).toBe('ABC');
    expect(m.pushName).toBe('Maria');
    expect(m.receivedAt.getTime()).toBe(1749134001 * 1000);
  });

  it('flags outbound echo with fromMe=true', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '5592999999999@s.whatsapp.net', fromMe: true, id: 'OUT1' },
      message: { conversation: 'oi' },
    }));
    expect(m.fromMe).toBe(true);
  });

  it('flags group messages', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '120363021234567890@g.us', fromMe: false, id: 'G1', participant: '5592777777777@s.whatsapp.net' },
      message: { conversation: 'bom dia' },
    }));
    expect(m.isGroup).toBe(true);
  });

  it('parses image with caption as kind IMAGE', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '5592999999999@s.whatsapp.net', fromMe: false, id: 'IMG1' },
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'doc', fileLength: '84213', height: 1280, width: 960 } },
      messageType: 'imageMessage',
    }));
    expect(m.kind).toBe('IMAGE');
    expect(m.text).toBe('doc');
    expect(m.media?.mimeType).toBe('image/jpeg');
    expect(m.media?.sizeBytes).toBe(84213);
    expect(m.media?.width).toBe(960);
  });

  it('parses audio with duration as kind AUDIO', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '5592999999999@s.whatsapp.net', fromMe: false, id: 'AUD1' },
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7, ptt: true } },
      messageType: 'audioMessage',
    }));
    expect(m.kind).toBe('AUDIO');
    expect(m.media?.durationSec).toBe(7);
  });

  it('extracts quoted message context', () => {
    const [m] = a.parseInboundChatMessages(base({
      key: { remoteJid: '5592999999999@s.whatsapp.net', fromMe: false, id: 'Q1' },
      message: { extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'ORIG', quotedMessage: { conversation: 'pergunta?' } } } },
    }));
    expect(m.text).toBe('sim');
    expect(m.quotedWaMessageId).toBe('ORIG');
    expect(m.quotedPreview).toBe('pergunta?');
  });

  it('returns [] when there is no data', () => {
    expect(a.parseInboundChatMessages({ event: 'messages.upsert' })).toEqual([]);
  });
});
