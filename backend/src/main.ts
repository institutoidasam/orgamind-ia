// Sentry must be initialised before any other module is loaded so it can
// patch http/express/pg/etc. at require time.
import './sentry.instrument';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Application } from 'express';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './shared/errors/domain-exception.filter';
import type { Env } from './shared/config/env.schema';

/**
 * The API runs behind a single reverse proxy (Caddy/nginx that rewrites
 * `/api/*`). Enable Express `trust proxy` for exactly one hop so `req.ip`
 * resolves to the real client via `X-Forwarded-For`. Without this, every
 * anonymous request keys to the proxy's own socket address and the rate limiter
 * collapses all pre-auth traffic (e.g. `/auth/login`, `/auth/refresh`) into one
 * shared bucket — 5 failed logins would 429 every user system-wide.
 */
export function configureTrustProxy(expressApp: Application): void {
  expressApp.set('trust proxy', 1);
}

/**
 * Monta a documentação da API (spec OpenAPI em `/docs-json` + UI Scalar em
 * `/docs`) e devolve `true` se conseguiu.
 *
 * POR QUE isto é `try/catch` e não código solto no bootstrap: documentação de
 * API é conveniência de desenvolvimento, e conveniência NUNCA pode derrubar o
 * servidor. Até aqui qualquer exceção durante a geração do spec matava o
 * PROCESSO no boot — foi assim que um `z.coerce.date()` num contrato ("Date
 * cannot be represented in JSON Schema", lançado pelo `toJSONSchema` do zod v4)
 * deixou o job e2e vermelho por mais de um mês e impediu o `dev` local de
 * subir. Só produção escapava, e apenas porque lá o Swagger é desligado — ou
 * seja, o ambiente MENOS observado era o único que quebrava.
 *
 * A falha é degradação, não silêncio: sem docs a API sobe inteira, e o log
 * carrega a mensagem ORIGINAL para não custar a ninguém o mesmo mês de
 * investigação.
 */
export function mountApiDocs(
  app: INestApplication,
  logger: LoggerService,
): boolean {
  try {
    // Build OpenAPI spec
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ORGAMIND API')
      .setDescription('WhatsApp campaign system — REST API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    // Generate OpenAPI document and post-process Zod-derived schemas
    const document = cleanupOpenApiDoc(
      SwaggerModule.createDocument(app, swaggerConfig),
    );

    // Serve raw OpenAPI JSON spec at /docs-json (no Swagger UI; Scalar handles UI)
    SwaggerModule.setup('docs', app, document, {
      ui: false,
      raw: ['json'],
      jsonDocumentUrl: 'docs-json',
    });

    // Serve Scalar UI at /docs
    app.use(
      '/docs',
      apiReference({
        content: document,
      }),
    );
    return true;
  } catch (err) {
    // `error` e não `warn`: isto é um defeito a consertar, e o nível alto
    // garante que o aviso apareça mesmo com o log filtrado.
    const causa =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error(
      [
        '[openapi] Falha ao gerar a documentação da API.',
        'IMPACTO: /docs e /docs-json ficam INDISPONÍVEIS nesta execução. O resto do servidor sobe normalmente.',
        'CAUSA MAIS PROVÁVEL: algum schema de contrato não é representável em JSON Schema — tipicamente um campo cujo tipo de ENTRADA é `Date` (`z.coerce.date()`); use o helper `dateFromIso()` de src/schemas/contracts/date.schema.ts.',
        'COMO DIAGNOSTICAR: `npx vitest run src/schemas/openapi-representability.spec.ts` no backend aponta o schema/DTO culpado pelo nome.',
        `ERRO ORIGINAL: ${causa}`,
      ].join('\n'),
    );
    return false;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  configureTrustProxy(app.getHttpAdapter().getInstance());
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalFilters(new DomainExceptionFilter());
  // Read CORS_ORIGIN through ConfigService so the value goes through Zod
  // validation (and we keep the same source-of-truth as the rest of the app
  // instead of touching process.env directly here).
  const config = app.get(ConfigService<Env, true>);
  const corsOrigin = config
    .get('CORS_ORIGIN', { infer: true })
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });
  app.enableShutdownHooks();

  // API docs (OpenAPI JSON + Scalar UI) are only mounted outside production.
  // In production they would expose the full API surface (every route, schema
  // and auth requirement) to anonymous visitors, so we gate them off.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    mountApiDocs(app, logger);
  }

  // Roda SEMPRE, inclusive quando `mountApiDocs` falhou: sem docs a API ainda
  // serve todas as rotas, e é por isso que o valor de retorno é ignorado aqui.
  await app.listen(config.get('PORT', { infer: true }));
}
// Don't boot the HTTP server when this module is imported by the test runner —
// the exported helpers (configureTrustProxy, mountApiDocs) must be importable
// in isolation.
if (!process.env.VITEST) {
  void bootstrap();
}
