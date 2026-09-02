import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ChatModule } from '../chat/chat.module';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';
import { BotsRepository } from './bots.repository';
import { DifyClient } from './dify.client';
import { DifyConsoleClient } from './dify-console.client';
import { BotReplyService } from './bot-reply.service';

@Module({
  imports: [ConfigModule, PrismaModule, ChatModule, WhatsappProvidersModule],
  controllers: [BotsController],
  providers: [BotsService, BotsRepository, DifyClient, DifyConsoleClient, BotReplyService],
  exports: [BotsRepository, DifyClient, BotReplyService],
})
export class BotsModule {}
