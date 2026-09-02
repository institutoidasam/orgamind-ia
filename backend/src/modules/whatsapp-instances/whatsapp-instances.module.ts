import { Module, type Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { WhatsappInstancesController } from './whatsapp-instances.controller';
import {
  WhatsappInstancesService,
  EVOLUTION_ADMIN_CLIENT,
  type EvolutionAdminClient,
} from './whatsapp-instances.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappInstanceRouter } from './whatsapp-instance-router.service';
import { ReconnectReplayService } from './reconnect-replay.service';
import { ConnectionReconcilerService } from './connection-reconciler.service';
import { ParkedMessagesSweeperProcessor } from './parked-messages-sweeper.processor';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { configuredProviderGroups, type Env } from '../../shared/config/env.schema';

/**
 * be-whatsapp: build the admin client used by WhatsappInstancesService for
 * create/logout/restart. On a deploy with no Evolution credential group
 * configured (e.g. Meta/Twilio-only) there is no Evolution server to talk to,
 * so calling adminLogout/adminRestart/adminCreateInstance would hit a
 * non-existent service. Gate by provider and return a no-op client under
 * anything other than 'evolution'. The no-op's createInstance returns an
 * empty apiKey (be-whatsapp-003: the per-instance key is never used anyway).
 */
export function buildEvolutionAdminClient(
  provider: 'meta' | 'evolution' | 'twilio',
  adapter: EvolutionApiAdapter,
): EvolutionAdminClient {
  if (provider !== 'evolution') {
    return {
      createInstance: async () => ({ apiKey: '' }),
      logout: async () => {},
      restart: async () => {},
    };
  }
  return {
    createInstance: (args) => adapter.adminCreateInstance(args),
    logout: (name) => adapter.adminLogout(name),
    restart: (name) => adapter.adminRestart(name),
  };
}

const evolutionAdminProvider: Provider = {
  provide: EVOLUTION_ADMIN_CLIENT,
  inject: [ConfigService, EvolutionApiAdapter],
  useFactory: (
    config: ConfigService<Env>,
    adapter: EvolutionApiAdapter,
  ): EvolutionAdminClient => {
    // Whether the EVOLUTION credential group is actually configured on this
    // deploy (not a deploy-global legacy selector) — a mixed Evolution+Twilio
    // deploy must still get the real admin client, which the old
    // WHATSAPP_PROVIDER-selector logic could get wrong.
    const configured = configuredProviderGroups({
      EVOLUTION_BASE_URL: config.get('EVOLUTION_BASE_URL', { infer: true }),
      EVOLUTION_API_KEY: config.get('EVOLUTION_API_KEY', { infer: true }),
      EVOLUTION_INSTANCE_NAME: config.get('EVOLUTION_INSTANCE_NAME', {
        infer: true,
      }),
    });
    return buildEvolutionAdminClient(
      configured.includes('evolution') ? 'evolution' : 'meta',
      adapter,
    );
  },
};

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue({ name: 'send-message' }),
    BullModule.registerQueue({ name: QUEUE_NAMES.CONNECTION_RECONCILER }),
    BullModule.registerQueue({ name: QUEUE_NAMES.PARKED_MESSAGES_SWEEP }),
  ],
  controllers: [WhatsappInstancesController],
  providers: [
    WhatsappInstancesService,
    WhatsappInstancesRepository,
    WhatsappInstanceRouter,
    ReconnectReplayService,
    ParkedMessagesSweeperProcessor,
    ConnectionReconcilerService,
    EvolutionApiAdapter,
    WhatsappProvidersRepository,
    evolutionAdminProvider,
  ],
  exports: [
    WhatsappInstancesRepository,
    WhatsappInstanceRouter,
    ReconnectReplayService,
    ConnectionReconcilerService,
  ],
})
export class WhatsappInstancesModule {}
