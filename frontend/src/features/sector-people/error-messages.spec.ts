import { HTTPError } from 'ky';
import { describe, expect, it } from 'vitest';
import { describeSectorPeopleError } from './error-messages';

const httpError = (code: string, status: number) =>
  new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never);

describe('describeSectorPeopleError', () => {
  it.each([
    ['sector_people.has_access', 422, 'Quem tem acesso muda de setor pelo cadastro em Usuários.'],
    ['user.sector_invalid', 409, 'O setor da pessoa está inativo. Escolha outro em Editar.'],
    ['user.sector_required', 422, 'Defina o setor da pessoa em Editar antes de dar acesso a este perfil.'],
  ])('%s vira a mensagem em pt-BR', async (code, status, message) => {
    expect(await describeSectorPeopleError(httpError(code, status))).toBe(message);
  });

  it('código desconhecido ou erro sem corpo: undefined (o chamador usa o erro genérico)', async () => {
    expect(await describeSectorPeopleError(httpError('outro.codigo', 500))).toBeUndefined();
    expect(await describeSectorPeopleError(new Error('falhou'))).toBeUndefined();
  });
});
