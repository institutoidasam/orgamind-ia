import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';
import { TemplatesRepository } from './templates.repository';
import { TemplateApprovalSyncProcessor } from './template-approval-sync.processor';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    // TwilioContentService (Content API client) for the approval-sync
    // processor below.
    WhatsappProvidersModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC }),
    // Sem consumidor (R8): a fila segue registrada só para o worker achar o token
    // e apagar os repetíveis que um deploy antigo deixou no Redis.
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
  ],
  exports: [TemplatesService, TemplatesRepository],
})
export class TemplatesModule {}
