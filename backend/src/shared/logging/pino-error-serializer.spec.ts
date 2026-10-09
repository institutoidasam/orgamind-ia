import { AxiosError } from 'axios';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { serializeErrorForLog } from './pino-error-serializer';

describe('serializeErrorForLog', () => {
  const SECRET = 'credential-for-test-only-4c1d';

  it('com pino real mantém o diagnóstico do AxiosError sem registrar estruturas sensíveis', () => {
    const config = {
      url: `https://provider.invalid/instance/status?apikey=${SECRET}`,
      headers: { apikey: SECRET },
      data: { token: SECRET },
    };
    const request = {
      _header: `GET /instance/status?apikey=${SECRET} HTTP/1.1\r\napikey: ${SECRET}`,
    };
    const response = {
      status: 404,
      statusText: 'Not Found',
      headers: { 'set-cookie': SECRET },
      config,
      data: { token: SECRET },
    };
    const error = new AxiosError(
      `Request failed at https://provider.invalid/instance/status?apikey=${SECRET}`,
      'ERR_BAD_REQUEST',
      config,
      request,
      response,
    );
    error.stack = `AxiosError: ${error.message}\n    at https://provider.invalid/instance/status?apikey=${SECRET}`;
    error.cause = new Error(
      `upstream https://provider.invalid/retry?token=${SECRET}`,
    );

    const lines: string[] = [];
    const logger = pino(
      { serializers: { err: serializeErrorForLog } },
      { write: (line: string) => lines.push(line) },
    );

    logger.warn({ err: error }, 'connection state unavailable');

    const output = lines.join('');
    const logged = JSON.parse(output) as {
      err: {
        type: string;
        message: string;
        code?: string;
        status?: number;
        stack?: string;
        cause?: { message: string };
      };
    };

    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('"config"');
    expect(output).not.toContain('"request"');
    expect(output).not.toContain('"response"');
    expect(output).not.toContain('"headers"');
    expect(output).not.toContain('provider.invalid');
    expect(logged.err).toMatchObject({
      type: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      status: 404,
      message: 'Request failed at [URL omitida]',
      cause: { message: 'upstream [URL omitida]' },
    });
    expect(logged.err.stack).toContain('[URL omitida]');
  });

  it('continua seguro quando pino-http serializa o AxiosError antes do serializer customizado', () => {
    const error = new AxiosError(
      `Request failed at https://provider.invalid/status?apikey=${SECRET}`,
      'ERR_BAD_REQUEST',
      {
        headers: { apikey: SECRET },
        data: { token: SECRET },
      },
      { _header: `apikey: ${SECRET}` },
      {
        status: 404,
        headers: { apikey: SECRET },
        data: { token: SECRET },
      },
    );
    error.stack = `AxiosError: ${error.message}\n at https://provider.invalid/status?apikey=${SECRET}`;

    const lines: string[] = [];
    const middleware = pinoHttp(
      { serializers: { err: serializeErrorForLog } },
      { write: (line: string) => lines.push(line) },
    );
    middleware.logger.warn({ err: error }, 'connection state unavailable');

    const output = lines.join('');
    const logged = JSON.parse(output) as {
      err: { type: string; code?: string; status?: number; message: string };
    };

    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('"config"');
    expect(output).not.toContain('"request"');
    expect(output).not.toContain('"response"');
    expect(output).not.toContain('"headers"');
    expect(output).not.toContain('provider.invalid');
    expect(logged.err).toMatchObject({
      type: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      status: 404,
      message: 'Request failed at [URL omitida]',
    });
  });

  it('aceita objeto de erro simples sem copiar seus campos arbitrários', () => {
    const output = serializeErrorForLog({
      name: 'ProviderError',
      message: 'request failed',
      code: 'ECONNRESET',
      status: 503,
      url: `https://provider.invalid?token=${SECRET}`,
      payload: { token: SECRET },
      config: { headers: { apikey: SECRET } },
    }) as Record<string, unknown>;

    expect(output).toMatchObject({
      type: 'ProviderError',
      message: 'request failed',
      code: 'ECONNRESET',
      status: 503,
    });
    expect(output).not.toHaveProperty('url');
    expect(output).not.toHaveProperty('payload');
    expect(output).not.toHaveProperty('config');
  });

  it('redige URL e token mesmo quando o logger recebe uma causa textual', () => {
    const output = serializeErrorForLog(
      `upstream https://provider.invalid/retry?token=${SECRET}`,
    );

    expect(output.message).toBe('upstream [URL omitida]');
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it('com pino real redige credenciais Basic/Bearer e JSON textual em message, stack e cause', () => {
    const basic = 'basic-fixture-only-7d2c';
    const bearer = 'bearer-fixture-only-3a1f';
    const jsonCredential = 'json-fixture-only-9e4b';
    const message =
      `provider rejected Authorization: Basic ${basic}; ` +
      `Proxy-Authorization: Bearer ${bearer}; ` +
      `body={"authorization":"${jsonCredential}","apikey":"${jsonCredential}","token":"${jsonCredential}","password":"${jsonCredential}","secret":"${jsonCredential}"}`;
    const error = new Error(message);
    error.stack = `Error: ${message}`;
    error.cause = new Error(message);

    const lines: string[] = [];
    const logger = pino(
      { serializers: { err: serializeErrorForLog } },
      { write: (line: string) => lines.push(line) },
    );
    logger.warn({ err: error }, 'provider rejected request');

    const output = lines.join('');
    const logged = JSON.parse(output) as {
      err: { message: string; stack: string; cause: { message: string } };
    };

    for (const credential of [basic, bearer, jsonCredential]) {
      expect(output).not.toContain(credential);
    }
    expect(logged.err.message).toContain('provider rejected');
    expect(logged.err.message).toContain('Authorization: [Redacted]');
    expect(logged.err.message).toContain('Proxy-Authorization: [Redacted]');
    expect(logged.err.message).toContain('"authorization":"[Redacted]"');
    expect(logged.err.stack).toContain('[Redacted]');
    expect(logged.err.cause.message).toContain('[Redacted]');
  });

  it('com pino-http real redige credenciais Basic/Bearer e JSON textual', () => {
    const basic = 'basic-http-fixture-only-2a6e';
    const bearer = 'bearer-http-fixture-only-6f8b';
    const jsonCredential = 'json-http-fixture-only-5c4d';
    const message =
      `Authorization: Basic ${basic}; Proxy-Authorization: Bearer ${bearer}; ` +
      `payload={"authorization":"${jsonCredential}","token":"${jsonCredential}"}`;
    const error = new Error(message);
    error.stack = `Error: ${message}`;

    const lines: string[] = [];
    const middleware = pinoHttp(
      { serializers: { err: serializeErrorForLog } },
      { write: (line: string) => lines.push(line) },
    );
    middleware.logger.warn({ err: error }, 'provider rejected request');

    const output = lines.join('');
    const logged = JSON.parse(output) as {
      err: { message: string; stack: string };
    };

    for (const credential of [basic, bearer, jsonCredential]) {
      expect(output).not.toContain(credential);
    }
    expect(logged.err.message).toContain('Authorization: [Redacted]');
    expect(logged.err.message).toContain('Proxy-Authorization: [Redacted]');
    expect(logged.err.message).toContain('"authorization":"[Redacted]"');
    expect(logged.err.stack).toContain('[Redacted]');
  });
});
