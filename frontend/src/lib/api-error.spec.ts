// frontend/src/lib/api-error.spec.ts
import { describe, it, expect } from 'vitest';
import { HTTPError } from 'ky';
import { extractApiError, readErrorBody } from './api-error';

function makeKyError(status: number, body: unknown): HTTPError {
  const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' },
  });
  // ky's HTTPError takes (response, request, options)
  return new HTTPError(
    response as never,
    new Request('http://localhost/x') as never,
    {} as never,
  );
}

describe('extractApiError', () => {
  it('reads ProblemDetails JSON body from HTTPError', async () => {
    const err = makeKyError(409, {
      type: 'urn:picoa:error:template.in_use',
      title: 'Template is in use',
      status: 409,
      detail: 'Template em uso em 3 campanhas ativas',
      code: 'template.in_use',
      instance: '/templates/abc',
      traceId: 't-1',
    });

    const out = await extractApiError(err);
    expect(out).toEqual({
      code: 'template.in_use',
      title: 'Template is in use',
      message: 'Template em uso em 3 campanhas ativas',
      status: 409,
    });
  });

  it('falls back to response statusText when HTTPError body is not JSON', async () => {
    const err = makeKyError(500, 'Bad Gateway');
    const out = await extractApiError(err);
    expect(out.status).toBe(500);
    expect(out.title).toBe('Erro');
    expect(out.message).toContain('500');
    expect(out.code).toBeUndefined();
  });

  it('formats validation errors when ProblemDetails lacks a detail field', async () => {
    const err = makeKyError(400, {
      type: 'urn:picoa:error:validation_failed',
      title: 'Validation failed',
      status: 400,
      code: 'validation_failed',
      errors: [
        { path: 'name', message: 'Required' },
        { path: 'email', message: 'Invalid' },
      ],
    });
    const out = await extractApiError(err);
    expect(out).toEqual({
      code: 'validation_failed',
      title: 'Validation failed',
      message: 'name: Required; email: Invalid',
      status: 400,
    });
  });

  it('handles a plain Error', async () => {
    const out = await extractApiError(new Error('boom'));
    expect(out).toEqual({ title: 'Erro', message: 'boom' });
  });

  it('handles unknown thrown values', async () => {
    const out = await extractApiError('string thrown');
    expect(out).toEqual({ title: 'Erro', message: 'Falha desconhecida' });
  });
});

/** HTTPError como o ky 2 entrega: corpo do Response já consumido, corpo parseado em `data`. */
async function ky2Error(status: number, data: unknown): Promise<HTTPError> {
  const response = new Response(JSON.stringify(data), { status });
  await response.text();
  const err = new HTTPError(response, new Request('http://localhost/x'), {} as never);
  err.data = data as HTTPError['data'];
  return err;
}

describe('readErrorBody / extractApiError com o corpo em error.data (ky 2)', () => {
  const problem = { code: 'shifts.name_taken', title: 'Shift name taken', status: 409 };

  it('extractApiError lê code e title de error.data quando o corpo já foi consumido', async () => {
    const out = await extractApiError(await ky2Error(409, problem));
    expect(out.code).toBe('shifts.name_taken');
    expect(out.title).toBe('Shift name taken');
    expect(out.status).toBe(409);
  });

  it('readErrorBody devolve error.data e, sem data, cai no corpo intacto', async () => {
    await expect(readErrorBody(await ky2Error(409, problem))).resolves.toEqual(problem);
    await expect(readErrorBody(makeKyError(409, problem))).resolves.toEqual(problem);
  });

  it('readErrorBody devolve undefined sem data e com o corpo ilegível ou consumido', async () => {
    await expect(readErrorBody(makeKyError(500, 'Bad Gateway'))).resolves.toBeUndefined();
    const consumed = await ky2Error(500, problem);
    consumed.data = undefined;
    await expect(readErrorBody(consumed)).resolves.toBeUndefined();
  });

  it('extractApiError trata data em texto (resposta não JSON) como corpo genérico', async () => {
    const out = await extractApiError(await ky2Error(502, 'Bad Gateway'));
    expect(out).toEqual({ title: 'Erro', message: 'Falha HTTP 502', status: 502 });
  });
});
