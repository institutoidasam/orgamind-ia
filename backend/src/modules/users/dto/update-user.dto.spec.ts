import { describe, expect, it } from 'vitest';
import { updateUserSchema } from './update-user.dto';

describe('updateUserSchema (A1, A2, A4)', () => {
  it('aceita matrícula (inclusive null), autorização e motivo aparado', () => {
    const parsed = updateUserSchema.parse({
      registration: null,
      contactAuthorization: { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' },
      reason: ' ajuste ',
    });
    expect(parsed).toMatchObject({ registration: null, reason: 'ajuste' });
  });

  it('CADASTRO_ANTERIOR nunca entra pela API (GC6)', () => {
    const result = updateUserSchema.safeParse({
      contactAuthorization: { status: 'CADASTRO_ANTERIOR' },
    });
    expect(result.success).toBe(false);
  });

  it('o motivo sozinho não edita nada: pede ao menos um campo da pessoa', () => {
    expect(updateUserSchema.safeParse({ reason: 'ajuste' }).success).toBe(
      false,
    );
    expect(
      updateUserSchema.safeParse({ isActive: false, reason: 'ajuste' }).success,
    ).toBe(true);
  });

  it('motivo com mais de 200 caracteres é recusado', () => {
    expect(
      updateUserSchema.safeParse({ name: 'Ana', reason: 'x'.repeat(201) })
        .success,
    ).toBe(false);
  });
});
