import { describe, it, expect } from 'vitest';
import { shouldReply, type BotReplyGuardInput } from './bot-reply.guard';

const ok: BotReplyGuardInput = {
  channelProvider: 'EVOLUTION',
  hasBot: true,
  botIsActive: true,
  contactOptedOut: false,
  botPausedAt: null,
  direction: 'INBOUND',
  kind: 'TEXT',
};

describe('shouldReply', () => {
  it('true for a clean inbound text on an active bot (evolution channel)', () => {
    expect(shouldReply(ok)).toBe(true);
  });
  it('true for IMAGE and AUDIO', () => {
    expect(shouldReply({ ...ok, kind: 'IMAGE' })).toBe(true);
    expect(shouldReply({ ...ok, kind: 'AUDIO' })).toBe(true);
  });
  it('false for unsupported kinds (DOCUMENT/VIDEO/STICKER)', () => {
    for (const kind of ['DOCUMENT', 'VIDEO', 'STICKER', 'LOCATION', 'CONTACT', 'UNSUPPORTED']) {
      expect(shouldReply({ ...ok, kind })).toBe(false);
    }
  });
  it('false for non-Evolution channels (TWILIO/ZERNIO/META)', () => {
    for (const channelProvider of ['TWILIO', 'ZERNIO', 'META'] as const) {
      expect(shouldReply({ ...ok, channelProvider })).toBe(false);
    }
  });
  it('false when no bot / bot inactive', () => {
    expect(shouldReply({ ...ok, hasBot: false })).toBe(false);
    expect(shouldReply({ ...ok, botIsActive: false })).toBe(false);
  });
  it('false when contact opted out', () => {
    expect(shouldReply({ ...ok, contactOptedOut: true })).toBe(false);
  });
  it('false when bot is paused (handoff)', () => {
    expect(shouldReply({ ...ok, botPausedAt: new Date() })).toBe(false);
  });
  it('false for outbound messages', () => {
    expect(shouldReply({ ...ok, direction: 'OUTBOUND' })).toBe(false);
  });
});
