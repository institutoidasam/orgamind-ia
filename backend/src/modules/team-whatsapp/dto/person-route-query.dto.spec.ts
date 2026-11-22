import { describe, expect, it } from 'vitest';
import { PersonRouteQueryDto } from './person-route-query.dto';

describe('personRouteQuerySchema (C2)', () => {
  it('userId obrigatório e não vazio', () => {
    const schema = PersonRouteQueryDto.schema;
    expect(schema.parse({ userId: 'u1' })).toEqual({ userId: 'u1' });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ userId: '' }).success).toBe(false);
  });
});
