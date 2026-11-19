import { describe, expect, it } from 'vitest';
import { listUsersQuerySchema } from './list-users.dto';

describe('listUsersQuerySchema', () => {
  it('sem parâmetro novo mantém o contrato antigo: status all, sem busca nem filtro', () => {
    expect(listUsersQuerySchema.parse({ hasAccess: 'true' })).toEqual({
      page: 1,
      pageSize: 20,
      hasAccess: true,
      status: 'all',
    });
  });

  it('q é aparada e aceita até 80 caracteres', () => {
    expect(listUsersQuerySchema.parse({ q: '  AB-12 ' }).q).toBe('AB-12');
    expect(listUsersQuerySchema.safeParse({ q: 'a'.repeat(80) }).success).toBe(
      true,
    );
    expect(listUsersQuerySchema.safeParse({ q: 'a'.repeat(81) }).success).toBe(
      false,
    );
  });

  it.each([
    { status: 'todos' },
    { status: '' },
    { authorization: 'AUTORIZADO' },
    { authorization: '' },
  ])('valor inválido %o → recusa (400)', (query) => {
    expect(listUsersQuerySchema.safeParse(query).success).toBe(false);
  });

  it('aceita status e autorização válidos', () => {
    expect(
      listUsersQuerySchema.parse({
        status: 'inactive',
        authorization: 'NOT_AUTHORIZED',
      }),
    ).toMatchObject({ status: 'inactive', authorization: 'NOT_AUTHORIZED' });
  });
});
