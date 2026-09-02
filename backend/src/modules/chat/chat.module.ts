import { Module } from '@nestjs/common';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { ChatController } from './chat.controller';
import { ChatMediaController } from './chat-media.controller';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { ChatIngestService } from './chat-ingest.service';
import { ChatMediaService } from './chat-media.service';
import { ChatHistorySyncService } from './chat-history-sync.service';
import { ChatSyncController } from './chat-sync.controller';
import { ZernioInboxSyncService } from './zernio-inbox-sync.service';
import { ZernioInboxSyncController } from './zernio-inbox-sync.controller';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';

// NOTE: The CHAT_MEDIA_DOWNLOAD and CHAT_HISTORY_SYNC queues are registered
// (with their defaultJobOptions, incl. attempts) in the @Global QueueModule.
// We intentionally do NOT re-register them here: a bare `registerQueue` shadows
// the global defaultJobOptions, dropping attempts to 1 and disabling the
// media-download retry guard. @InjectQueue resolves them from QueueModule.
@Module({
  imports: [
    WhatsappProvidersModule,
  ],
  controllers: [ChatController, ChatMediaController, ChatSyncController, ZernioInboxSyncController],
  providers: [ChatService, ChatRepository, ChatEventsService, ChatIngestService, ChatMediaService, ChatHistorySyncService, ZernioInboxSyncService, ZernioSyncRunsService],
  exports: [ChatService, ChatRepository, ChatIngestService, ChatEventsService, ChatHistorySyncService, ZernioInboxSyncService, ZernioSyncRunsService],
})
export class ChatModule {}
