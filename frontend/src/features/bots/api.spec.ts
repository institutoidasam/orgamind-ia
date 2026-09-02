import { describe, it, expect } from 'vitest';
import { difyAppSchema, assignBotInputSchema } from './schemas';

describe('bots schemas (Dify-direct)', () => {
  it('difyAppSchema maps id -> difyAppId', () => {
    const parsed = difyAppSchema.parse({ id: 'app-1', name: 'Vendas', mode: 'chat' });
    expect(parsed.difyAppId).toBe('app-1');
    expect(parsed.name).toBe('Vendas');
    expect(parsed.mode).toBe('chat');
    expect(parsed).not.toHaveProperty('id');
  });

  it('assignBotInputSchema accepts null difyAppId (unassign)', () => {
    expect(assignBotInputSchema.safeParse({ instanceId: 'inst1', difyAppId: null }).success).toBe(true);
    expect(assignBotInputSchema.safeParse({ instanceId: 'inst1', difyAppId: 'app-1' }).success).toBe(true);
    expect(assignBotInputSchema.safeParse({ difyAppId: 'app-1' }).success).toBe(false); // missing instanceId
  });
});
