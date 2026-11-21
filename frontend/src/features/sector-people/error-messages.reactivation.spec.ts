import { HTTPError } from 'ky';
import { describe, expect, it } from 'vitest';
import { describeSectorPeopleError } from './error-messages';

const httpError = (code: string) =>
  new HTTPError(new Response(JSON.stringify({ code }), { status: 409 }), new Request('https://x'), {} as never);

describe('describeSectorPeopleError: reativação recusada (E10)', () => {
  it.each([
    ['user.sector_inactive', 'O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.'],
    ['user.level_inactive', 'O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.'],
  ])('aceite 18: %s com o mesmo texto na tela de pessoas do setor', async (code, message) => {
    expect(await describeSectorPeopleError(httpError(code))).toBe(message);
  });
});
