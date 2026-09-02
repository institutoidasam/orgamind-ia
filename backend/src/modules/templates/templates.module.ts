import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';
import { TemplatesRepository } from './templates.repository';
import { TemplateApprovalSyncProcessor } from './template-approval-sync.processor';
import { ZernioTemplateSyncProcessor } from './zernio-template-sync.processor';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    // TwilioContentService (Content API client) for the approval-sync
    // processor below.
    WhatsappProvidersModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC }),
    BullModule.registerQueue({ name: QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC }),
  ],
  controllers: [TemplatesController],
  providers: [
    TemplatesService,
    TemplatesRepository,
    // Repeatable BullMQ consumer (registered in worker.ts) that reconciles
    // Twilio Content approval statuses — same pattern as the
    // connection-reconciler living in WhatsappInstancesModule.
    TemplateApprovalSyncProcessor,
    // ZC — reconciliação do catálogo do Zernio. REDE DE SEGURANÇA (1h) atrás do
    // webhook `whatsapp.template.status_updated`, que é o caminho normal. O
    // espaçamento é deliberado: o balde do Zernio é o MESMO do envio.
    ZernioTemplateSyncProcessor,
  ],
  exports: [TemplatesService, TemplatesRepository],
})
export class TemplatesModule {}
