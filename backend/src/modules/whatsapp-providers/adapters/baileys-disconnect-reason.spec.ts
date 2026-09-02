import { describe, it, expect } from 'vitest';
import { describeDisconnectReason } from './baileys-disconnect-reason';

describe('describeDisconnectReason', () => {
  it('returns null when there is no reason code (null/undefined)', () => {
    expect(describeDisconnectReason(null)).toBeNull();
    expect(describeDisconnectReason(undefined)).toBeNull();
  });

  it('401 (logged out / device removed) explains the anti-spam enforcement and points to Twilio', () => {
    const r = describeDisconnectReason(401);
    expect(r?.code).toBe(401);
    expect(r?.message).toMatch(/deslogada|removeu.*dispositivo/i);
    // The guidance must steer cold outreach to the official provider.
    expect(r?.guidance).toMatch(/Twilio/i);
    expect(r?.guidance).toMatch(/anti-spam|opt-in|frio/i);
  });

  it('403 (forbidden) warns about a probable ban and says do not resend', () => {
    const r = describeDisconnectReason(403);
    expect(r?.message).toMatch(/bloqueada|forbidden/i);
    expect(r?.guidance).toMatch(/ban/i);
  });

  it('515 (restart required) is framed as normal / self-healing', () => {
    const r = describeDisconnectReason(515);
    expect(r?.message).toMatch(/reinício|normal/i);
    expect(r?.guidance).toMatch(/automaticamente|nenhuma ação/i);
  });

  it('440 (connection replaced) tells the operator to avoid parallel WhatsApp Web', () => {
    const r = describeDisconnectReason(440);
    expect(r?.message).toMatch(/assumiu|WhatsApp Web/i);
    expect(r?.guidance).toMatch(/paralelo|reconecte/i);
  });

  it('unknown non-null codes fall back to a generic message that echoes the code', () => {
    const r = describeDisconnectReason(4242);
    expect(r).not.toBeNull();
    expect(r?.code).toBe(4242);
    expect(r?.message).toContain('4242');
    expect(r?.guidance).toMatch(/QR/i);
  });
});
