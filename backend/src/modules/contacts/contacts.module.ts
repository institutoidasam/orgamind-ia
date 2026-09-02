import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { ContactsRepository } from './contacts.repository';
import { ContactsExportService } from './contacts-export.service';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { WhatsappInstancesModule } from '../whatsapp-instances/whatsapp-instances.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    WhatsappProvidersModule,
    WhatsappInstancesModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.CONTACT_SYNC }),
  ],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsRepository, ContactsExportService],
  exports: [ContactsService, ContactsRepository],
})
export class ContactsModule {}
