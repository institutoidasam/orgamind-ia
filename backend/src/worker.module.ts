import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from './shared/config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { AuditModule } from './shared/audit/audit.module';
import { RedisModule } from './shared/redis/redis.module';
import { QueueModule } from './modules/queue/queue.module';
import { WhatsappProvidersModule } from './modules/whatsapp-providers/whatsapp-providers.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { WhatsappInstancesModule } from './modules/whatsapp-instances/whatsapp-instances.module';
import { MediaStoreModule } from './shared/media/media-store.module';
import { ChatModule } from './modules/chat/chat.module';
import { SendMessageProcessor } from './modules/queue/send-message.processor';
import { SendingReconcilerProcessor } from './modules/queue/sending-reconciler.processor';
import { SchedulerProcessor } from './modules/queue/scheduler.processor';
import { CleanupEventsProcessor } from './modules/queue/cleanup-events.processor';
import { CheckTokenExpiryProcessor } from './modules/whatsapp-providers/jobs/check-token-expiry.processor';
import { ContactSyncProcessor } from './modules/contacts/contact-sync.processor';
import { ContactSyncCronProcessor } from './modules/contacts/contact-sync-cron.processor';
import { ChatMediaDownloadProcessor } from './modules/chat/chat-media-download.processor';
import { ChatHistorySyncProcessor } from './modules/chat/chat-history-sync.processor';
import { ZernioInboxSyncProcessor } from './modules/chat/zernio-inbox-sync.processor';
import { ZernioTierSyncProcessor } from './modules/whatsapp-providers/zernio-tier-sync.processor';
import { ZernioBroadcastSendService } from './modules/whatsapp-providers/zernio-broadcast-send.service';
import { ZernioBroadcastPollService } from './modules/whatsapp-providers/zernio-broadcast-poll.service';
import {
  ZernioBroadcastDispatchProcessor,
  ZernioBroadcastPollProcessor,
  ZernioBroadcastCancelProcessor,
} from './modules/whatsapp-providers/zernio-broadcast-send.processor';
import { ExcelImportModule } from './modules/excel-import/excel-import.module';
import { ExcelImportProcessor } from './modules/excel-import/excel-import.processor';
import { BotsModule } from './modules/bots/bots.module';
import { BotReplyProcessor } from './modules/bots/bot-reply.processor';
import { ConsentModule } from './modules/consent/consent.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { serializeErrorForLog } from './shared/logging/pino-error-serializer';
// ConnectionReconcilerService is provided + exported by WhatsappInstancesModule
// (imported below), where EvolutionApiAdapter and the repos it needs are in
// scope. Declaring it directly here too created a duplicate the WorkerModule
// scope couldn't resolve (EvolutionApiAdapter isn't exported to this scope),
// crashing the whole worker bootstrap. Importing the module is enough to run it.

@Module({
  imports: [
    ConfigModule,
    ClsModule.forRoot({ global: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        serializers: { err: serializeErrorForLog },
      },
    }),
    PrismaModule,
    AuditModule,
    RedisModule,           // provides REDIS_CLIENT globally (needed by ChatEventsService)
    QueueModule,
    WhatsappProvidersModule,
    CampaignsModule,       // exports CampaignsService + CampaignsRepository for SendMessageProcessor
    ContactsModule,        // exports ContactsRepository + ContactsService for sync processors
    WhatsappInstancesModule, // exports WhatsappInstanceRouter + WhatsappInstancesRepository
    MediaStoreModule,      // provides MEDIA_STORE token for ChatMediaDownloadProcessor
    ChatModule,            // provides ChatEventsService + CHAT_MEDIA_DOWNLOAD queue for ChatIngestService
    ExcelImportModule,     // exports ExcelService + registers EXCEL_IMPORT queue for ExcelImportProcessor
    BotsModule,         // provides BotReplyService + DifyClient for BotReplyProcessor
    // ANTES do ConsentModule: os providers dele (PublicConsentService,
    // ConsentAdminService) injetam OrganizationService — a identidade que o
    // consentimento NOMEIA. Sem este import o worker morre no boot com erro de
    // DI, e não nos testes unitários (que constroem os serviços com `new`).
    OrganizationModule,
    ConsentModule,      // @Global — o gate do SendMessageProcessor consulta ConsentService
  ],
  providers: [
    SendMessageProcessor,
    SendingReconcilerProcessor,
    SchedulerProcessor,
    CleanupEventsProcessor,
    CheckTokenExpiryProcessor,
    ContactSyncProcessor,
    ContactSyncCronProcessor,
    ChatMediaDownloadProcessor,
    ChatHistorySyncProcessor,
    // ZERNIO_INBOX_SYNC consumer — como os demais, registrado SÓ aqui (um
    // @Processor duplicado em módulo de feature derruba o worker inteiro).
    ZernioInboxSyncProcessor,
    // ZA2/ZA3 — tier-sync do Zernio. Registrado AQUI (e não no
    // WhatsappProvidersModule, como o gêmeo do Twilio) porque ele precisa do
    // CampaignsService para pausar as campanhas do canal quando a qualidade
    // cai, e WhatsappProvidersModule → CampaignsModule fecharia um ciclo
    // (CampaignsModule → TemplatesModule → WhatsappProvidersModule).
    ZernioTierSyncProcessor,
    // ★ ZB — o BROADCAST do Zernio (o caminho de ESCRITA: a campanha do orgamind
    // vira um disparo de verdade no painel do cliente).
    //
    // Registrado AQUI pelo MESMO motivo do ZernioTierSyncProcessor acima: os
    // serviços precisam do CampaignsRepository (claim atômico, releaseClaim,
    // createSkippedMessage — as MESMAS operações do envio 1-a-1, porque as
    // invariantes são as mesmas), e `WhatsappProvidersModule → CampaignsModule`
    // fecharia o ciclo. Aqui os dois módulos já estão em escopo.
    //
    // O ZernioBroadcastClient vem exportado do WhatsappProvidersModule; o
    // ConsentService, do ConsentModule (@Global); as filas, do QueueModule.
    ZernioBroadcastSendService,
    ZernioBroadcastPollService,
    ZernioBroadcastDispatchProcessor,
    ZernioBroadcastPollProcessor,
    ZernioBroadcastCancelProcessor,
    // EXCEL_IMPORT consumer — registered ONLY here (never also in a feature
    // module; a duplicate @Processor crashes the whole worker).
    ExcelImportProcessor,
    BotReplyProcessor,
  ],
})
export class WorkerModule {}
