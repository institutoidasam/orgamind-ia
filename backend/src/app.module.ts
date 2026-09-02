import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsModule } from 'nestjs-cls';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './shared/throttler/user-throttler.guard';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type Redis from 'ioredis';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ZodValidationPipe } from 'nestjs-zod';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import basicAuth from 'express-basic-auth';
import type { Env } from './shared/config/env.schema';
import { ConfigModule } from './shared/config/config.module';
import { RedisModule, REDIS_CLIENT } from './shared/redis/redis.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { MediaStoreModule } from './shared/media/media-store.module';
import { HealthModule } from './shared/health/health.module';
import { CorrelationIdMiddleware } from './shared/correlation/correlation-id.middleware';
import { sanitizeReqForLog } from './shared/logging/pino-req-serializer';
import { AuditModule } from './shared/audit/audit.module';
import { AuditContextInterceptor } from './shared/audit/audit-context.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { ExcelImportModule } from './modules/excel-import/excel-import.module';
import { WhatsappProvidersModule } from './modules/whatsapp-providers/whatsapp-providers.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { SegmentsModule } from './modules/segments/segments.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { QueueModule } from './modules/queue/queue.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WhatsappInstancesModule } from './modules/whatsapp-instances/whatsapp-instances.module';
import { ChatModule } from './modules/chat/chat.module';
import { BotsModule } from './modules/bots/bots.module';
import { ConsentModule } from './modules/consent/consent.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { QUEUE_NAMES } from './modules/queue/queue.constants';

/**
 * Caminhos que o pino APAGA do log (`[Redacted]`). É a lista de CREDENCIAIS que
 * chegam por CABEÇALHO — o `autoLogging` do pino-http grava `req.headers`
 * inteiro em toda resposta, 200 e 401, em nível `info` (= o nível de produção).
 * O que não estiver aqui vai para o log do contêiner em texto claro.
 *
 * Exportada (e não escrita inline no `pinoHttp`) para que exista UM teste capaz
 * de provar, com o pino de verdade, que um segredo mandado nestes cabeçalhos
 * não aparece na saída — ver `modules/webhooks/gozap-webhook-log-redaction.spec.ts`.
 * `redact` é por CAMINHO, não por substring: um nome de cabeçalho novo NÃO é
 * coberto por acidente, tem de ser acrescentado aqui à mão.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  // Credencial do webhook do GoZap quando ela vem por cabeçalho — o caminho
  // PREFERIDO desde que o segredo saiu da query string (achado C20). Sem esta
  // linha, tirar o segredo da URL apenas o mudaria de log: sairia do access log
  // do nginx e entraria, em texto claro e a cada evento, no log do contêiner
  // `api` — que é justamente o que a API do Dokploy expõe. Ver
  // `modules/webhooks/gozap-webhooks.controller.ts` (TOKEN_HEADER).
  'req.headers["x-webhook-token"]',
  // Mesma classe, pré-existente: a Evolution manda a nossa EVOLUTION_API_KEY
  // no cabeçalho `apikey` (webhooks.controller.ts) — também é credencial, e
  // também estava indo inteira para o log.
  'req.headers.apikey',
];

@Module({
  imports: [
    ConfigModule,
    // ClsModule must come before everything that consumes CLS so its HTTP
    // middleware wraps the request lifecycle. `mount: true` registers a
    // global middleware; `generateId: false` defers ID generation to the
    // existing CorrelationIdMiddleware (we want a single source of truth).
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: false },
    }),
    AuditModule,
    RedisModule,
    MediaStoreModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ContactsModule,
    ExcelImportModule,
    WhatsappProvidersModule,
    TemplatesModule,
    QueueModule,
    CampaignsModule,
    SegmentsModule,
    MetricsModule,
    WebhooksModule,
    ChatModule,
    WhatsappInstancesModule,
    BotsModule,
    // @Global e ANTES do ConsentModule: a identidade da organização é o que o
    // consentimento nomeia (texto, landing, wa.me). Sem ela, o orgamind volta a
    // hardcodar o nome de um cliente nos textos que vão para o titular.
    OrganizationModule,
    ConsentModule, // @Global — caminho único de escrita do consentimento
    BullBoardModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>) => ({
        route: '/admin/queues',
        adapter: ExpressAdapter,
        middleware: basicAuth({
          users: {
            // env.schema guarantees both (defaults in dev; superRefine rejects
            // the placeholder password in prod). getOrThrow keeps the key typed
            // as a definite string (no inline fallback, no string|undefined).
            [config.getOrThrow('BULL_BOARD_USER', { infer: true })]:
              config.getOrThrow('BULL_BOARD_PASSWORD', { infer: true }),
          },
          challenge: true,
        }),
      }),
    }),
    BullBoardModule.forFeature({
      name: QUEUE_NAMES.WHATSAPP_SEND,
      adapter: BullMQAdapter,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        customProps: (req) => ({ correlationId: req.headers['x-request-id'] }),
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: LOG_REDACT_PATHS,
        // `autoLogging` do pino-http está ligado por padrão e grava o req em
        // TODA resposta (200 e 401). O serializer padrão copia
        // `req.url = req.originalUrl` (query INTEIRA, no Express) e expõe
        // `req.query` à parte — vazando qualquer segredo carregado na query
        // (GOZAP_WEBHOOK_TOKEN em /webhooks/gozap?t=, hub.verify_token no
        // handshake da Meta em /webhooks/whatsapp). `redact` é por CAMINHO,
        // não por substring, então não alcança a string de `url`. Ver
        // shared/logging/pino-req-serializer.ts para o porquê completo.
        serializers: { req: sanitizeReqForLog },
      },
    }),
  ],
  providers: [
    // Global validation pipe + auth/authorization guards live at the root so
    // they cannot silently vanish if AuthModule is refactored/made lazy.
    // Guards execute in registration order: JwtAuthGuard populates `req.user`
    // first, then RolesGuard authorizes, then UserThrottlerGuard rate-limits
    // by user (it also self-decodes the JWT, so it is correct even if the
    // order ever changes).
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
