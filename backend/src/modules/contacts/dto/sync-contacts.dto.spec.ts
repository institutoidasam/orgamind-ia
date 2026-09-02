import { describe, it, expect } from 'vitest';

import { syncProgressQuerySchema } from './sync-contacts.dto';

describe('syncProgressQuerySchema.since', () => {
  it('aceita uma string ISO-8601 (o `startedAt` que POST /contacts/sync devolveu)', () => {
    const parsed = syncProgressQuerySchema.parse({
      since: '2026-08-25T04:00:00.000Z',
    });
    expect(parsed.since).toBe('2026-08-25T04:00:00.000Z');
  });

  it('rejeita uma string que não é ISO-8601 (400, não um `Invalid Date` calado)', () => {
    expect(() =>
      syncProgressQuerySchema.parse({ since: 'ontem' }),
    ).toThrow();
  });
});
