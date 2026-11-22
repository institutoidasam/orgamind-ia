import { describe, expect, it } from 'vitest';
import { liveBlock } from './channel-availability';

describe('liveBlock', () => {
  // Só `open` libera o envio imediato (D7); `connecting` conta como desconectado, como no servidor.
  it.each([
    ['open', null],
    ['close', 'disconnected'],
    ['connecting', 'disconnected'],
    ['unknown', 'unverified'],
  ] as const)('estado %s → %s', (state, expected) => {
    expect(liveBlock(state)).toBe(expected);
  });
});
