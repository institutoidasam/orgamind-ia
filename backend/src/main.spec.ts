import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Controller, Post, Body, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { Server } from 'node:http';

// main.ts statically imports AppModule, which eagerly validates env at import
// time. We only exercise the pure exported helpers here, so stub AppModule to
// keep this module importable without a full env.
vi.mock('./app.module', () => ({ AppModule: class {} }));

import { configureTrustProxy, mountApiDocs } from './main';

/**
 * The app is deployed behind a reverse proxy (Caddy/nginx). Express only honours
 * `X-Forwarded-For` when `trust proxy` is enabled; otherwise `req.ip` is the
 * proxy's own socket address for every request, which collapses the rate
 * limiter's anonymous bucket into a single system-wide bucket.
 */
describe('configureTrustProxy', () => {
  function makeApp() {
    const app = express();
    configureTrustProxy(app);
    app.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  }

  it('resolves req.ip from X-Forwarded-For so each client keys its own bucket', async () => {
    const res = await request(makeApp())
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');

    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('gives distinct clients distinct req.ip so they key separate buckets', async () => {
    const app = makeApp();
    const a = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.9');
    const b = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.22');

    expect(a.body.ip).toBe('198.51.100.9');
    expect(b.body.ip).toBe('198.51.100.22');
    expect(a.body.ip).not.toBe(b.body.ip);
  });
});

/**
 * A geração do OpenAPI já derrubou o boot uma vez: um `z.coerce.date()` num
 * contrato faz o `toJSONSchema` do zod v4 lançar "Date cannot be represented in
 * JSON Schema", e a exceção matava o processo — CI e2e vermelho por mais de um
 * mês, `dev` local sem subir, e produção intacta só porque lá o Swagger é
 * desligado. Aqui o cenário é REPRODUZIDO de verdade (um DTO com
 * `z.coerce.date()` num app Nest real), não simulado com mock de exceção: o que
 * precisa ficar garantido é que ESTA falha específica degrada em vez de matar.
 */
describe('mountApiDocs', () => {
  function makeLogger() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    };
  }

  // `z.coerce.date()` tem `Date` como tipo de ENTRADA — exatamente o que o
  // eixo `io: 'input'` do nestjs-zod não sabe representar.
  class DtoIrrepresentavel extends createZodDto(
    z.object({ quando: z.coerce.date() }),
  ) {}

  class DtoSao extends createZodDto(z.object({ quando: z.iso.datetime() })) {}

  @Controller('coisas')
  class ControllerQuebrado {
    @Post()
    criar(@Body() body: DtoIrrepresentavel) {
      return body;
    }
  }

  @Controller('coisas')
  class ControllerSao {
    @Post()
    criar(@Body() body: DtoSao) {
      return body;
    }
  }

  @Module({ controllers: [ControllerQuebrado] })
  class ModuloQuebrado {}

  @Module({ controllers: [ControllerSao] })
  class ModuloSao {}

  it('não deixa a exceção escapar quando um DTO não é representável', async () => {
    const app = await NestFactory.create(ModuloQuebrado, { logger: false });
    const logger = makeLogger();

    expect(() => mountApiDocs(app, logger)).not.toThrow();

    await app.close();
  });

  it('sinaliza a falha (retorna false) em vez de fingir que montou', async () => {
    const app = await NestFactory.create(ModuloQuebrado, { logger: false });

    expect(mountApiDocs(app, makeLogger())).toBe(false);

    await app.close();
  });

  it('loga a mensagem ORIGINAL, o impacto e como diagnosticar', async () => {
    const app = await NestFactory.create(ModuloQuebrado, { logger: false });
    const logger = makeLogger();

    mountApiDocs(app, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const aviso = String(logger.error.mock.calls[0][0]);
    // A causa real, sem engolir — é ela que economiza o próximo mês de
    // investigação de quem topar com um /docs em 404.
    expect(aviso).toContain('Date cannot be represented in JSON Schema');
    // E o que fazer a respeito.
    expect(aviso).toContain('INDISPONÍVEIS');
    expect(aviso).toContain('openapi-representability.spec.ts');

    await app.close();
  });

  it('monta as docs normalmente quando todos os DTOs são representáveis', async () => {
    const app = await NestFactory.create(ModuloSao, { logger: false });
    const logger = makeLogger();

    expect(mountApiDocs(app, logger)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();

    await app.init();
    const res = await request(app.getHttpServer() as Server).get('/docs-json');
    expect(res.status).toBe(200);
    const spec = res.body as { paths?: Record<string, unknown> };
    expect(spec.paths).toHaveProperty('/coisas');

    await app.close();
  });
});
