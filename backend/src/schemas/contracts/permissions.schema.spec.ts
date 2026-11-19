import { describe, expect, it } from 'vitest';
import { savePermissionMatrixSchema } from './permissions.schema';

describe('savePermissionMatrixSchema', () => {
  it('aceita SUPERVISOR e OPERATOR, com ADMIN e VIEWER opcionais (o 422 é do serviço)', () => {
    const body = {
      roles: {
        SUPERVISOR: ['pessoas.editar'],
        OPERATOR: [],
        ADMIN: ['estrutura.manter'],
        VIEWER: [],
      },
    };

    expect(savePermissionMatrixSchema.parse(body)).toEqual(body);
    expect(
      savePermissionMatrixSchema.safeParse({
        roles: { SUPERVISOR: [], OPERATOR: ['escala.alterar'] },
      }).success,
    ).toBe(true);
  });

  it('recusa chave fora do catálogo (chave.inexistente)', () => {
    const result = savePermissionMatrixSchema.safeParse({
      roles: { SUPERVISOR: ['chave.inexistente'], OPERATOR: [] },
    });

    expect(result.success).toBe(false);
  });

  it('recusa campo extra na raiz e dentro de roles', () => {
    const extraRoot = savePermissionMatrixSchema.safeParse({
      roles: { SUPERVISOR: [], OPERATOR: [] },
      note: 'x',
    });
    const extraRole = savePermissionMatrixSchema.safeParse({
      roles: { SUPERVISOR: [], OPERATOR: [], GUEST: [] },
    });

    expect(extraRoot.success).toBe(false);
    expect(extraRole.success).toBe(false);
  });
});
