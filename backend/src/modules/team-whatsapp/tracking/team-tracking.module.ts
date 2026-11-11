import { Module } from '@nestjs/common';
import { TeamRecipientTrackingService } from './team-recipient-tracking.service';

// D10: sem imports (o PrismaModule é @Global), para WebhooksModule e ChatModule
// o usarem sem ciclo com o TeamWhatsappModule.
@Module({
  providers: [TeamRecipientTrackingService],
  exports: [TeamRecipientTrackingService],
})
export class TeamTrackingModule {}
