import { HTTPError } from 'ky';
import { describe, expect, it, vi } from 'vitest';
import { reportUserPhoneError, userPhoneFieldError } from './phone-errors';

function httpError(status: number, body: unknown): HTTPError {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new HTTPError(new Response(raw, { status }), new Request('https://x'), {} as never);
}

describe('userPhoneFieldError', () => {
  it('maps user.phone_taken to the field message', async () => {
    await expect(userPhoneFieldError(httpError(409, { code: 'user.phone_taken' }))).resolves.toBe(
      'Este telefone já está em uso por outro usuário.',
    );
  });

  it('maps user.invalid_phone to the field message', async () => {
    await expect(userPhoneFieldError(httpError(400, { code: 'user.invalid_phone' }))).resolves.toBe(
      'Telefone inválido. Use DDD + número, com ou sem +55.',
    );
  });

  it('returns null for other codes, unreadable bodies and non-HTTP errors', async () => {
    await expect(userPhoneFieldError(httpError(400, { code: 'other' }))).resolves.toBeNull();
    await expect(userPhoneFieldError(httpError(500, 'not json'))).resolves.toBeNull();
    await expect(userPhoneFieldError(new Error('boom'))).resolves.toBeNull();
  });
});

describe('reportUserPhoneError', () => {
  it('sets the field error and reports handled for phone errors only', async () => {
    const setError = vi.fn();
    await expect(reportUserPhoneError({ setError }, httpError(409, { code: 'user.phone_taken' }))).resolves.toBe(true);
    expect(setError).toHaveBeenCalledWith('phone', { message: 'Este telefone já está em uso por outro usuário.' });
    await expect(reportUserPhoneError({ setError }, new Error('boom'))).resolves.toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
  });
});
