import { describe, expect, it } from 'vitest';
import { loginResponseSchema, meResponseSchema } from './schemas';

const USER = { id: 'u1', email: 'a@b.com', name: 'A', role: 'OPERATOR' as const };
const LOGIN = { accessToken: 'tok', mustChangePassword: false, user: USER };

describe('loginResponseSchema permissions', () => {
  it('aceita login de back antigo, sem permissions', () => {
    const parsed = loginResponseSchema.parse(LOGIN);

    expect(parsed.user.permissions).toBeUndefined();
  });

  it('descarta chave desconhecida e mantém as conhecidas', () => {
    const parsed = loginResponseSchema.parse({
      ...LOGIN,
      user: { ...USER, permissions: ['escala.alterar', 'futuro.nova_chave'] },
    });

    expect(parsed.user.permissions).toEqual(['escala.alterar']);
  });
});

describe('meResponseSchema', () => {
  it('valida usuário com permissions e o aviso de troca de senha', () => {
    const parsed = meResponseSchema.parse({
      user: { ...USER, permissions: ['pessoas.editar', 'outra.chave'] },
      mustChangePassword: true,
    });

    expect(parsed.user.permissions).toEqual(['pessoas.editar']);
    expect(parsed.user.isActive).toBe(true);
    expect(parsed.mustChangePassword).toBe(true);
  });

  it('rejeita resposta sem o usuário', () => {
    expect(() => meResponseSchema.parse({ mustChangePassword: false })).toThrow();
  });
});
