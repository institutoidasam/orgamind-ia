// frontend/src/lib/api-error.spec.ts
import { describe, it, expect } from 'vitest';
import { HTTPError } from 'ky';
import { extractApiError } from './api-error';

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
