import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ZodError } from 'zod';
import * as Sentry from '@sentry/nestjs';
import { DomainError } from './domain.error';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const traceId = req.headers['x-request-id'];

    // Uma resposta em STREAMING (ex.: contacts-export.service.ts) pode lançar
    // depois que os headers HTTP já saíram — nesse ponto `.json()` explodiria
    // em cima de um socket que já começou a responder, e o cliente acabaria
    // vendo um .xlsx truncado seguido de lixo. Não há mais como responder:
    // o melhor é derrubar a conexão (mesmo idioma de chat-media.controller.ts)
    // e sair. Backstop: quem já sabe disso (contacts-export.service.ts) trata
    // isso ANTES de deixar a exceção escapar; isto aqui é a rede de segurança.
    //
    // Review fix (round 2) — "não dá mais para responder" não pode virar
    // "não sobra rastro nenhum": sem log/Sentry aqui, uma falha genuína no
    // meio de um streaming (ex.: banco caiu na página 30 de um export)
    // desaparecia pior que um 500 comum — nem o monitoramento via sinal.
    // `req.path`, nunca `req.url` (mesmo motivo do resto do arquivo). Para
    // DomainError, só o CÓDIGO — nunca `.message` (escrita para humano, pode
    // carregar telefone/nome) nem `.stack` (em V8 começa pela própria
    // `.message`). 4xx de DomainError (desfecho de negócio) ainda fica fora
    // do Sentry, igual ao caminho normal — mas GANHA log, porque o cliente
    // aqui não é só "recusado", é "ficou com um arquivo truncado".
    if (res.headersSent) {
      const isDomainError = exception instanceof DomainError;
      const code = isDomainError ? exception.code : undefined;
      const is5xx = isDomainError ? exception.status >= 500 : true;

      this.logger.error(
        `stream abortado em ${req.path}${code ? ` code=${code}` : ''}`,
        !isDomainError && exception instanceof Error
          ? exception.stack
          : undefined,
      );
      if (is5xx) {
        Sentry.captureException(exception, {
          tags: {
            traceId: typeof traceId === 'string' ? traceId : undefined,
            url: req.path,
          },
        });
      }

      res.destroy();
      return;
    }

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status,
      detail: 'An unexpected error occurred',
      instance: req.url,
      traceId,
    };

    if (exception instanceof DomainError) {
      status = exception.status;
      body = {
        type: `urn:picoa:error:${exception.code}`,
        title: exception.message,
        status,
        detail: exception.detail,
        code: exception.code,
        instance: req.url,
        traceId,
      };
      // 4xx DomainErrors are expected business outcomes (NotFound/Conflict/…)
      // and stay out of Sentry. 5xx DomainErrors are real server faults
      // (e.g. InstanceCreationFailedError 502, NotImplementedError 501,
      // upstream WhatsApp/Meta failures) — report those.
      if (status >= 500) {
        Sentry.captureException(exception, {
          tags: {
            traceId: typeof traceId === 'string' ? traceId : undefined,
            // `req.path`, não `req.url`: a QUERY STRING pode carregar dado do
            // titular (ex.: GET /contacts?search=+5592995550101 — busca por
            // telefone). O Sentry retém eventos por meses; a rota sozinha já
            // identifica o gate.
            url: req.path,
          },
        });
      } else if (status !== HttpStatus.UNAUTHORIZED && status !== HttpStatus.NOT_FOUND) {
        // INCIDENTE 2026-08-11: um operador levou 400 em CADA tentativa de criar
        // campanha — 8 numa tarde, mais 3 no dia seguinte — e o servidor não
        // guardou uma linha. Saber QUAL dos ~10 gates recusou exigiu perguntar a
        // ele o que estava escrito na tela. Duas vezes.
        //
        // A premissa de que 4xx é "desfecho de negócio" vale para o caso comum,
        // mas uma AÇÃO RECUSADA é gente travada: sem rastro, ninguém consegue
        // ajudar sem estar olhando por cima do ombro. Fica fora do Sentry (não
        // é falha do servidor) e vai para o log como `warn`.
        //
        // Só o CÓDIGO — nunca `message` nem `detail`. O código identifica o
        // gate e é PII-free por construção; a mensagem é escrita para o humano
        // e pode carregar nome, telefone ou o texto do titular.
        //
        // 401 e 404 ficam de fora: todo refresh de token expirado passa pelo
        // primeiro e toda rota digitada errada pelo segundo — volume alto,
        // sinal baixo.
        //
        // `req.path`, não `req.url`: esta rota (GET /contacts/export.xlsx) é a
        // primeira rota com guarda de papel cujo query string pode carregar um
        // telefone (`?search=`) — um OPERADOR batendo nela leva 403, e aquele
        // 403 não pode gravar o número no log.
        this.logger.warn(
          `recusa ${status} em ${req.path} code=${exception.code}`,
        );
      }
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      body = {
        type: 'urn:picoa:error:validation_failed',
        title: 'Validation failed',
        status,
        code: 'validation_failed',
        instance: req.url,
        traceId,
        errors: exception.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      const respObj =
        typeof resp === 'object' && resp !== null
          ? (resp as Record<string, unknown>)
          : { detail: resp };
      // Spread the exception's response body FIRST so its extra fields
      // (message/error/...) surface, but let the canonical fields win — the
      // body must never be able to spoof status/type/instance/traceId, which
      // could leak a wrong status or a forged trace/instance to the client.
      body = {
        ...respObj,
        type: 'about:blank',
        title: exception.message,
        status,
        instance: req.url,
        traceId,
      };
      // 5xx HttpExceptions are server faults (e.g. ServiceUnavailable,
      // BadGateway) — report them to Sentry. 4xx are expected client errors
      // and stay out of Sentry to avoid noise.
      if (status >= 500) {
        Sentry.captureException(exception, {
          tags: {
            traceId: typeof traceId === 'string' ? traceId : undefined,
            // req.path — ver o mesmo comentário no ramo DomainError acima.
            url: req.path,
          },
        });
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      // Forward unexpected (non-DomainError, non-Zod, non-HttpException)
      // errors to Sentry. DomainError is handled in the branch above and
      // never reaches this code path, so we never report business outcomes.
      Sentry.captureException(exception, {
        tags: {
          traceId: typeof traceId === 'string' ? traceId : undefined,
          // req.path — ver o mesmo comentário no ramo DomainError acima.
          url: req.path,
        },
      });
      if (process.env.NODE_ENV !== 'production') {
        body.detail = exception.message;
      }
    }

    res.status(status).type('application/problem+json').json(body);
  }
}
