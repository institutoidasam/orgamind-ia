import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { WhatsappInstancesModule } from '../whatsapp-instances/whatsapp-instances.module';
import { ChatModule } from '../chat/chat.module';
import { TemplatesModule } from '../templates/templates.module';
import { TeamTrackingModule } from '../team-whatsapp/tracking/team-tracking.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    WhatsappProvidersModule,
    CampaignsModule,
    WhatsappInstancesModule,
    ChatModule,
    // ZC — TemplatesService, para o handler de `whatsapp.template.status_updated`.
    TemplatesModule,
    // T10 — recibos do envio da equipe (D10: módulo sem imports, sem ciclo).
    TeamTrackingModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.CHAT_HISTORY_SYNC }),
  ],
  // Só a Evolution está ligada (R5): as rotas de webhook Twilio/Zernio/GoZap
  // deixam de existir (404). Os arquivos dos controllers ficam no repositório (GC5).
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
