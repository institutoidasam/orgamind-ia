import { describe, it, expect } from 'vitest';
import type { TeamWhatsappRecipientStatus } from '@prisma/client';
import { failureStatus, isRepeatable } from './team-whatsapp.outcome';

describe('failureStatus (D5)', () => {
  it.each([
    ['team_whatsapp.indeterminate', () => true, 'UNCERTAIN'],
    ['gozap.timeout', () => false, 'UNCERTAIN'],
    ['gozap.not_on_whatsapp', () => true, 'FAILED'],
    ['team_whatsapp.channel_disconnected', () => true, 'FAILED'],
  ])('%s → %s', (code, redispatchable, expected) => {
    expect(failureStatus(code, redispatchable)).toBe(expected);
  });

  it('channel.provider_disabled é FAILED mesmo com redispatchable falso', () => {
    expect(failureStatus('channel.provider_disabled', () => false)).toBe(
      'FAILED',
    );
  });
});

describe('isRepeatable (C4)', () => {
  it.each<[TeamWhatsappRecipientStatus, string | null, boolean]>([
    ['FAILED', 'team_whatsapp.channel_disconnected', true],
    ['FAILED', 'gozap.not_on_whatsapp', false],
    ['FAILED', 'evolution.number_not_on_whatsapp', false],
    ['FAILED', 'team_whatsapp.message_missing', false],
    ['FAILED', 'channel.provider_disabled', false],
    ['FAILED', 'x.timeout', false],
    ['FAILED', null, false],
    ['UNCERTAIN', 'team_whatsapp.indeterminate', false],
    ['SENT', null, false],
  ])('%s + %s → %s', (status, code, expected) => {
    expect(isRepeatable(status, code)).toBe(expected);
  });
});
