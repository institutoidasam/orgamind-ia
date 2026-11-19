import { describe, expect, it } from 'vitest';
import { optionalReason, requireReason } from './change-reason';

const required = { status: 422, code: 'user.reason_required' };

describe('requireReason', () => {
  it('ausente, vazio ou com menos de 3 caracteres → 422 user.reason_required', () => {
    expect(() => requireReason(undefined)).toThrow(
      expect.objectContaining(required) as Error,
    );
    expect(() => requireReason('  ab ')).toThrow(
      expect.objectContaining(required) as Error,
    );
  });

  it('apara o texto e recusa mais de 200 caracteres', () => {
    expect(requireReason(' ajuste ')).toBe('ajuste');
    expect(() => requireReason('x'.repeat(201))).toThrow(
      expect.objectContaining(required) as Error,
    );
    expect(requireReason('x'.repeat(200))).toHaveLength(200);
  });
});

describe('optionalReason', () => {
  it('ausente ou só espaços → null; com texto válido → aparado', () => {
    expect(optionalReason(undefined)).toBeNull();
    expect(optionalReason('   ')).toBeNull();
    expect(optionalReason(' mudou de turno ')).toBe('mudou de turno');
  });

  it('1 ou 2 caracteres → 422 user.reason_required', () => {
    expect(() => optionalReason('ab')).toThrow(
      expect.objectContaining(required) as Error,
    );
  });
});
