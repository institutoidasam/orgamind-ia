import { describe, expect, it } from 'vitest';
import { contactAuthorizationInputSchema } from './contact-authorization.schema';

describe('contactAuthorizationInputSchema', () => {
  it('aceita NAO_AUTORIZADO sem outros campos', () => {
    const parsed = contactAuthorizationInputSchema.parse({
      status: 'NAO_AUTORIZADO',
    });

    expect(parsed).toEqual({ status: 'NAO_AUTORIZADO' });
  });

  it('recusa CADASTRO_ANTERIOR como origem', () => {
    const result = contactAuthorizationInputSchema.safeParse({
      status: 'AUTORIZADO',
      source: 'CADASTRO_ANTERIOR',
    });

    expect(result.success).toBe(false);
  });

  it('recusa OUTRO sem nota e nota acima de 120', () => {
    const withoutNote = contactAuthorizationInputSchema.safeParse({
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: '   ',
    });
    const longNote = contactAuthorizationInputSchema.safeParse({
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
      note: 'x'.repeat(121),
    });

    expect(withoutNote.success).toBe(false);
    expect(longNote.success).toBe(false);
  });

  it('aceita TERMO_ASSINADO sem data (o serviço usa hoje)', () => {
    const parsed = contactAuthorizationInputSchema.parse({
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
    });

    expect(parsed).toEqual({ status: 'AUTORIZADO', source: 'TERMO_ASSINADO' });
  });
});
