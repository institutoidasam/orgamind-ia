import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { TwilioWebhooksController } from './twilio-webhooks.controller';
import { ZernioWebhooksController } from './zernio-webhooks.controller';
import { GozapWebhooksController } from './gozap-webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { WhatsappInstancesModule } from '../whatsapp-instances/whatsapp-instances.module';
import { ChatModule } from '../chat/chat.module';
import { TemplatesModule } from '../templates/templates.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    WhatsappProvidersModule,
    CampaignsModule,
    WhatsappInstancesModule,
    ChatModule,
    // ZC — TemplatesService, para o handler de `whatsapp.template.status_updated`.
    TemplatesModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.CHAT_HISTORY_SYNC }),
  ],
  controllers: [
    WebhooksController,
    TwilioWebhooksController,
    ZernioWebhooksController,
    GozapWebhooksController,
  ],
  providers: [WebhooksService],
})
export class WebhooksModule {}
