import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError, z } from 'zod';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  DomainError,
  NotFoundError,
  ConflictError,
} from './domain.error';

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(),
}));

import * as Sentry from '@sentry/nestjs';

type CapturedResponse = {
  status: number;
  contentType?: string;
  body: Record<string, unknown>;
};

function makeHost(
  url = '/test',
  headers: Record<string, string> = {},
  opts: { headersSent?: boolean } = {},
) {
  const captured: CapturedResponse = { status: 0, body: {} };

  const res = {
    status: vi.fn().mockImplementation((s: number) => {
      captured.status = s;
      return res;
    }),
    type: vi.fn().mockImplementation((t: string) => {
      captured.contentType = t;
      return res;
    }),
    json: vi.fn().mockImplementation((b: Record<string, unknown>) => {
      captured.body = b;
      return res;
    }),
    headersSent: opts.headersSent ?? false,
    destroy: vi.fn(),
  } as unknown as Response;

  const req = {
    url,
    // Nenhuma chamada existente passa `?query`, então `path` cai igual a
    // `url` para todo teste já escrito — só diverge nos testes novos que
    // exercitam justamente essa diferença (query string com telefone).
    path: url.split('?')[0],
    headers: { 'x-request-id': 'trace-123', ...headers },
  } as unknown as Request;

  const host = mock<ArgumentsHost>();
  host.switchToHttp.mockReturnValue({
    getResponse: <T = Response>() => res as unknown as T,
    getRequest: <T = Request>() => req as unknown as T,
    getNext: <T = unknown>() => undefined as unknown as T,
  });

  return { host, captured, res };
}

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    vi.mocked(Sentry.captureException).mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('translates DomainError to RFC 9457 body with urn type and code', () => {
    const { host, captured } = makeHost('/contacts/x');
    const err = new DomainError({
      code: 'contact.invalid',
      message: 'Contact invalid',
      status: 422,
      detail: 'phone missing',
    });

    filter.catch(err, host);

    expect(captured.status).toBe(422);
    expect(captured.contentType).toBe('application/problem+json');
    expect(captured.body).toMatchObject({
      type: 'urn:picoa:error:contact.invalid',
      title: 'Contact invalid',
      status: 422,
      code: 'contact.invalid',
      detail: 'phone missing',
      instance: '/contacts/x',
      traceId: 'trace-123',
    });
  });

  it('returns 404 for NotFoundError', () => {
    const { host, captured } = makeHost('/users/u1');
    filter.catch(new NotFoundError('User', 'u1'), host);

    expect(captured.status).toBe(404);
    expect(captured.body).toMatchObject({
      type: 'urn:picoa:error:user.not_found',
      code: 'user.not_found',
      status: 404,
    });
    expect(captured.body.detail).toContain('u1');
  });

  it('returns 409 for ConflictError', () => {
    const { host, captured } = makeHost();
    filter.catch(new ConflictError('Duplicate phone'), host);

    expect(captured.status).toBe(409);
    expect(captured.body).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('returns 400 with errors array for ZodError', () => {
    const { host, captured } = makeHost('/x');
    const schema = z.object({ name: z.string().min(1), age: z.number() });
    const result = schema.safeParse({ name: '', age: 'oops' });
    expect(result.success).toBe(false);
    const zodErr = (result as { success: false; error: ZodError }).error;

    filter.catch(zodErr, host);

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({
      type: 'urn:picoa:error:validation_failed',
      code: 'validation_failed',
      status: 400,
    });
    const errors = captured.body.errors as Array<{ path: string; message: string }>;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toHaveProperty('path');
    expect(errors[0]).toHaveProperty('message');
  });

  it('translates HttpException to its status', () => {
    const { host, captured } = makeHost('/forbidden-path');
    filter.catch(new HttpException('Forbidden', 403), host);

    expect(captured.status).toBe(403);
    expect(captured.body).toMatchObject({
      title: 'Forbidden',
      status: 403,
      instance: '/forbidden-path',
    });
  });

  it('does NOT let the HttpException body override the canonical status field', () => {
    // The response status (HTTP) is driven by getStatus(); the body's `status`
    // field must agree with it and must not be spoofable from the response
    // object (which previously spread last and clobbered the canonical value).
    const { host, captured } = makeHost('/x');
    const ex = new HttpException(
      { status: 200, statusCode: 200, message: 'looks fine' },
      403,
    );

    filter.catch(ex, host);

    expect(captured.status).toBe(403);
    expect(captured.body.status).toBe(403);
    // Extra, non-canonical fields from the body are still surfaced.
    expect(captured.body.message).toBe('looks fine');
  });

  it('does NOT let the HttpException body override canonical type/instance/traceId', () => {
    const { host, captured } = makeHost('/real-path');
    const ex = new HttpException(
      {
        type: 'urn:evil:spoof',
        instance: '/spoofed',
        traceId: 'spoofed-trace',
        detail: 'genuine detail',
      },
      400,
    );

    filter.catch(ex, host);

    expect(captured.status).toBe(400);
    expect(captured.body.type).toBe('about:blank');
    expect(captured.body.instance).toBe('/real-path');
    expect(captured.body.traceId).toBe('trace-123');
    // Non-canonical fields still pass through.
    expect(captured.body.detail).toBe('genuine detail');
  });

  it('reports HttpException with status >= 500 to Sentry', () => {
    const { host, captured } = makeHost('/boom');
    const err = new HttpException('Bad Gateway', 502);

    filter.catch(err, host);

    expect(captured.status).toBe(502);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.anything(),
    );
  });

  it('does NOT report HttpException with status < 500 to Sentry', () => {
    const { host, captured } = makeHost('/forbidden-path');

    filter.catch(new HttpException('Forbidden', 403), host);

    expect(captured.status).toBe(403);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports DomainError with status >= 500 to Sentry (server faults like WhatsApp/Meta)', () => {
    const { host, captured } = makeHost('/whatsapp/instances');
    const err = new DomainError({
      code: 'instance.creation_failed',
      message: 'Evolution refused',
      status: 502,
    });

    filter.catch(err, host);

    expect(captured.status).toBe(502);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ url: '/whatsapp/instances' }) }),
    );
  });

  /**
   * Review fix (round 1, finding #1) — GET /contacts/export.xlsx é a primeira
   * rota cujo `?search=` pode carregar um telefone inteiro. Uma falha 5xx no
   * meio do export (ex.: banco caiu) não pode gravar esse número na tag do
   * Sentry — `url` tem de vir de `req.path` (sem query), nunca `req.url`.
   */
  it('5xx com telefone em ?search=: a tag do Sentry NÃO carrega a query string', () => {
    const { host } = makeHost('/contacts/export.xlsx?search=%2B5592995550101');
    const err = new DomainError({
      code: 'export.db_failure',
      message: 'db blip mid-export',
      status: 502,
    });

    filter.catch(err, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ url: '/contacts/export.xlsx' }),
      }),
    );
    const [, opts] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(JSON.stringify(opts)).not.toContain('5592995550101');
  });

  it('does NOT report DomainError with status < 500 to Sentry (business outcomes)', () => {
    const { host, captured } = makeHost('/users/u1');
    filter.catch(
      new DomainError({ code: 'conflict', message: 'Email taken', status: 409 }),
      host,
    );

    expect(captured.status).toBe(409);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking message in production for generic Error', () => {
    process.env.NODE_ENV = 'production';
    const { host, captured } = makeHost();
    filter.catch(new Error('secret crash detail'), host);

    expect(captured.status).toBe(500);
    expect(captured.body.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(captured.body)).not.toContain('secret crash detail');
  });

  it('returns 500 WITH detail in development for generic Error', () => {
    process.env.NODE_ENV = 'development';
    const { host, captured } = makeHost();
    filter.catch(new Error('dev visible detail'), host);

    expect(captured.status).toBe(500);
    expect(captured.body.detail).toBe('dev visible detail');
  });

  /**
   * INCIDENTE 2026-08-11 — o operador levou `400` em CADA tentativa de criar
   * campanha, 8 vezes numa tarde e mais 3 no dia seguinte, e o servidor não
   * guardou UMA linha sobre o assunto: 4xx eram "desfecho de negócio", fora do
   * log e fora do Sentry. Descobrir QUAL dos ~10 gates recusou exigiu perguntar
   * ao operador o que estava escrito na tela dele. Duas vezes.
   *
   * A premissa está certa para o caso comum — um 404 de rota inexistente não é
   * notícia. Mas uma CRIAÇÃO recusada é gente travada, e sem rastro ninguém
   * consegue ajudar sem estar olhando junto. Registrar o CÓDIGO fecha isso:
   * é ele que identifica o gate, e é PII-free por construção.
   *
   * 401 e 404 seguem fora: volume alto (todo refresh de token expirado passa
   * por ali) e sinal baixo.
   */
  describe('rastro de 4xx — operador travado tem de deixar marca no servidor', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    const logado = () => warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');

    it('400 de domínio vira log COM o código e a rota', () => {
      const { host } = makeHost('/campaigns');
      filter.catch(
        new DomainError({
          code: 'campaign.template_consent_buttons_unrecognized',
          message: 'O template "x" tem botões...',
          status: 400,
        }),
        host,
      );

      expect(warn).toHaveBeenCalled();
      expect(logado()).toContain('campaign.template_consent_buttons_unrecognized');
      expect(logado()).toContain('/campaigns');
    });

    it('409 também deixa rastro (conflito é operador travado igual)', () => {
      const { host } = makeHost('/campaigns');
      filter.catch(new ConflictError('em voo', 'campaign.in_flight'), host);
      expect(logado()).toContain('campaign.in_flight');
    });

    it('401 e 404 NÃO deixam rastro — volume alto, sinal baixo', () => {
      const { host: h1 } = makeHost('/auth/refresh');
      filter.catch(
        new DomainError({ code: 'auth.expired', message: 'x', status: 401 }),
        h1,
      );
      const { host: h2 } = makeHost('/campaigns/nope');
      filter.catch(new NotFoundError('sumiu', 'campaign.not_found'), h2);

      expect(warn).not.toHaveBeenCalled();
    });

    it('NÃO escreve a mensagem nem o detail — podem carregar dado do titular', () => {
      const { host } = makeHost('/contacts');
      filter.catch(
        new DomainError({
          code: 'contact.duplicate',
          message: 'Maria Silva (+5592999998888) já existe',
          detail: 'phone=+5592999998888',
          status: 400,
        }),
        host,
      );

      expect(logado()).toContain('contact.duplicate');
      expect(logado()).not.toContain('Maria Silva');
      expect(logado()).not.toContain('5592999998888');
    });

    /**
     * Review fix (round 1, finding #1) — GET /contacts/export.xlsx é a
     * primeira rota com guarda de papel (ADMIN) cuja query string pode
     * carregar um telefone inteiro (`?search=` casa `phoneE164`). Um
     * OPERATOR batendo nela leva 403 — e esse 403 passa por ESTE caminho de
     * log. `req.path`, não `req.url`, é o que evita o vazamento.
     */
    it('busca por telefone em ?search= NÃO aparece no log — usa req.path, nunca req.url', () => {
      const { host } = makeHost(
        '/contacts/export.xlsx?search=%2B5592995550101',
      );
      filter.catch(
        new DomainError({
          code: 'forbidden.admin_only',
          message: 'Requer ADMIN',
          status: 403,
        }),
        host,
      );

      expect(logado()).toContain('forbidden.admin_only');
      expect(logado()).toContain('/contacts/export.xlsx');
      expect(logado()).not.toContain('5592995550101');
      expect(logado()).not.toContain('search');
    });

    it('5xx continua fora deste caminho — já vai para o Sentry', () => {
      const { host } = makeHost('/whatsapp/channels');
      filter.catch(
        new DomainError({
          code: 'gozap.creation_failed',
          message: 'x',
          status: 502,
        }),
        host,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalled();
    });
  });

  /**
   * Review fix (round 1, finding #2) — uma resposta em STREAMING
   * (contacts-export.service.ts) pode lançar depois que os headers HTTP já
   * saíram. `.json()` nesse ponto quebraria em cima de um socket que já
   * começou a responder, e o cliente veria um .xlsx truncado seguido de
   * lixo em vez de um erro limpo. Esta é a rede de segurança: o serviço de
   * export já trata isso ANTES de deixar a exceção escapar, mas o filtro
   * global nunca pode confiar nisso sozinho.
   */
  describe('rede de segurança — headers HTTP já enviados (respostas em streaming)', () => {
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => error.mockRestore());

    /**
     * Review fix (round 2) — a versão anterior derrubava a conexão em
     * silêncio: um 5xx genuíno no meio do streaming (ex.: banco caiu na
     * página 30) desaparecia sem log, sem Sentry, sem rastro nenhum. Pior
     * que um 500 comum, porque nem o monitoramento via sinal.
     */
    it('nunca chama .json/.status, mas AINDA loga e reporta ao Sentry antes de derrubar a conexão', () => {
      const { host, res, captured } = makeHost(
        '/contacts/export.xlsx?search=%2B5592995550101',
        {},
        { headersSent: true },
      );

      filter.catch(new Error('db blip mid-stream'), host);

      expect(res.destroy).toHaveBeenCalledTimes(1);
      expect(res.json).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(captured.body).toEqual({});

      expect(error).toHaveBeenCalledTimes(1);
      const logado = error.mock.calls.map((c) => JSON.stringify(c)).join(' ');
      expect(logado).toContain('/contacts/export.xlsx');
      expect(logado).not.toContain('5592995550101');
      expect(logado).not.toContain('search');

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({ url: '/contacts/export.xlsx' }),
        }),
      );
    });

    it('DomainError 4xx (desfecho de negócio) neste caminho: loga com o CÓDIGO, mas NÃO reporta ao Sentry', () => {
      const { host, res } = makeHost(
        '/contacts/export.xlsx',
        {},
        { headersSent: true },
      );

      filter.catch(
        new DomainError({
          code: 'contact.duplicate',
          message: 'Maria Silva (+5592999998888) já existe',
          status: 409,
        }),
        host,
      );

      expect(res.destroy).toHaveBeenCalledTimes(1);
      const logado = error.mock.calls.map((c) => JSON.stringify(c)).join(' ');
      expect(logado).toContain('contact.duplicate');
      expect(logado).not.toContain('Maria Silva');
      expect(logado).not.toContain('5592999998888');
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('nem para um DomainError comum (mesmo com headers ainda não enviados, o caminho normal responde)', () => {
      // Controle: SEM headersSent, o caminho de sempre (res.json) continua
      // funcionando — a rede de segurança só age quando já é tarde demais
      // para responder normalmente.
      const { host, res, captured } = makeHost('/contacts/export.xlsx');

      filter.catch(
        new DomainError({ code: 'x', message: 'x', status: 400 }),
        host,
      );

      expect(res.destroy).not.toHaveBeenCalled();
      expect(captured.status).toBe(400);
    });
  });
});
