import { describe, it, expect } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { WhatsappProvidersService } from './whatsapp-providers.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { InboundChatMessage } from './ports/message-provider.port';

const msg: InboundChatMessage = {
  providerMessageId: 'X',
  remoteJid: '55@s.whatsapp.net',
  phoneE164: '+55',
  isGroup: false,
  fromMe: false,
  kind: 'TEXT',
  text: 'oi',
  receivedAt: new Date(),
};

describe('WhatsappProvidersService.parseInboundChatMessages', () => {
  it('delegates to the adapter when supported', () => {
    const adapter = { name: 'evolution', parseInboundChatMessages: () => [msg] } as never;
    const repo = mockDeep<WhatsappProvidersRepository>();
    const svc = new WhatsappProvidersService(adapter, repo);
    expect(svc.parseInboundChatMessages({})).toEqual([msg]);
  });
  it('returns [] when the adapter does not support it', () => {
    const adapter = { name: 'meta' } as never;
    const repo = mockDeep<WhatsappProvidersRepository>();
    const svc = new WhatsappProvidersService(adapter, repo);
    expect(svc.parseInboundChatMessages({})).toEqual([]);
  });
});
