import { describe, it, expect } from 'vitest';
import { qrRefetchInterval } from './api';

describe('qrRefetchInterval — stop polling the QR once connected', () => {
  it('stops polling (false) when the instance is open', () => {
    // Once paired, polling /qr would call /instance/connect on a stale cache
    // and spawn a competing Baileys socket → conflict/replaced storm. Stop.
    expect(qrRefetchInterval('open')).toBe(false);
  });

  it('keeps polling every 3s while connecting (waiting for scan)', () => {
    expect(qrRefetchInterval('connecting')).toBe(3_000);
  });

  it('keeps polling every 3s while closed', () => {
    expect(qrRefetchInterval('close')).toBe(3_000);
  });

  it('keeps polling when the state is not yet known (no data)', () => {
    expect(qrRefetchInterval(undefined)).toBe(3_000);
  });
});
