import { HTTPError } from 'ky';
import { describe, expect, it } from 'vitest';
import { describeScheduleError } from './error-messages';

const httpError = (body: Record<string, unknown>, status: number) =>
  new HTTPError(new Response(JSON.stringify(body), { status }), new Request('https://x'), {} as never);

describe('describeScheduleError: 403 de permissão (DB10)', () => {
  it('auth.permission_denied mostra o detail do servidor, que diz qual ação não é permitida', async () => {
    const detail = 'Você não tem permissão para alterar a escala.';
    const result = await describeScheduleError(httpError({ code: 'auth.permission_denied', detail }, 403));
    expect(result).toEqual({ code: 'auth.permission_denied', message: detail });
  });

  it('sem detail usa a mensagem de fallback, nunca o texto técnico do erro', async () => {
    const result = await describeScheduleError(httpError({ code: 'auth.permission_denied' }, 403), 'Falhou.');
    expect(result).toEqual({ code: 'auth.permission_denied', message: 'Falhou.' });
  });
});

describe('describeScheduleError: códigos da escala', () => {
  it('código conhecido vira o texto local; desconhecido, o fallback', async () => {
    expect((await describeScheduleError(httpError({ code: 'staff_schedule.forbidden' }, 403))).message).toBe(
      'Você não pode editar a escala desta pessoa.',
    );
    expect(await describeScheduleError(new Error('falhou'), 'Falhou.')).toEqual({ code: undefined, message: 'Falhou.' });
  });
});
