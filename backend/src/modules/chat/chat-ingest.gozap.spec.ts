import { describe, it, expect, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { MessageDirection, type ChannelProvider } from '@prisma/client';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { ProviderRegistry } from '../whatsapp-providers/provider-registry.service';
import type { MessageProvider } from '../whatsapp-providers/ports/message-provider.port';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { GozapCloudAdapter } from '../whatsapp-providers/adapters/gozap-cloud.adapter';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type {
  ChatMediaDownloadJob,
  BotReplyJob,
} from '../queue/queue.constants';
import type { Env } from '../../shared/config/env.schema';

/**
 * O INGEST POR PROVEDOR — só a Evolution está ligada (spec somente-evolution).
 *
 * O webhook cru entra pelo `ChatIngestService`, atravessa o
 * `WhatsappProvidersService`, o `ProviderRegistry` e o adapter de PRODUÇÃO, e o
 * teste olha o que seria ESCRITO no banco:
 *  - GOZAP: o adapter continua no código (GC5) e até está no mapa do registry,
 *    mas o provedor está desligado — o ingest é no-op;
 *  - EVOLUTION: o adapter real, ponta a ponta.
 *
 * Os cenários do fluxo GoZap que estavam aqui (avatar, opt-in K3, bot, grupo,
 * recibo) migraram: o parser do GoZap segue coberto em
 * `gozap-cloud.inbound-chat.spec.ts`; o opt-in/bot/grupo/avatar do ingest, em
 * `chat-ingest.{optin-link,optin-button,bot,service}.spec.ts`; a identidade do
 * remetente, em `chat-ingest.identidade.spec.ts`.
 *
 * Doutrina do repo: o Prisma é mock, então o mock ignora o `where`. Todas as
 * asserções abaixo são sobre o ARGUMENTO das chamadas, nunca sobre o retorno
 * fabricado.
 */

/** Defaults do Prisma/Redis/consentimento: contato c1 existente, conversa conv1. */
function stubDefaults(
  prisma: DeepMockProxy<PrismaService>,
  redis: DeepMockProxy<Redis>,
  consent: DeepMockProxy<ConsentService>,
  links: DeepMockProxy<OptInLinkService>,
) {
  redis.get.mockResolvedValue(null);
  prisma.channel.findUnique.mockResolvedValue({
    evolutionInstanceName: null,
    botId: null,
  } as never);
  prisma.contact.findMany.mockResolvedValue([{ id: 'c1' }] as never);
  prisma.contact.create.mockResolvedValue({ id: 'c-novo' } as never);
  prisma.conversation.upsert.mockResolvedValue({
    id: 'conv1',
    lastMessageAt: null,
    lastInboundAt: null,
  } as never);
  prisma.message.create.mockResolvedValue({
    id: 'm1',
    media: null,
  } as never);
  prisma.message.findMany.mockResolvedValue([] as never);
  prisma.conversation.update.mockResolvedValue({} as never);
  consent.record.mockResolvedValue({ eventId: 'e1', created: true });
  consent.rehydrate.mockResolvedValue([]);
  links.matchInbound.mockResolvedValue(null);
}

// Adapters REAIS, resolvidos pelo registry REAL. O do GoZap está registrado de
// propósito: o que o desliga é o provedor, não a ausência do adapter.
function makeWhatsappProviders() {
  const evolution = new EvolutionApiAdapter({
    get: () => undefined,
  } as unknown as ConfigService<Env>);
  const gozap = new GozapCloudAdapter({
    get: () => 'https://acme.gozap.dev',
  } as unknown as ConfigService);
  const registry = new ProviderRegistry(
    new Map<ChannelProvider, MessageProvider>([
      ['EVOLUTION', evolution],
      ['GOZAP', gozap],
    ]),
  );
  return new WhatsappProvidersService(
    evolution,
    mockDeep<WhatsappProvidersRepository>(),
    mockDeep<WhatsappInstancesRepository>(),
    registry,
    mockDeep<ConfigService<Env>>(),
  );
}

function make() {
  const prisma = mockDeep<PrismaService>();
  const events = mockDeep<ChatEventsService>();
  const redis = mockDeep<Redis>();
  const consent = mockDeep<ConsentService>();
  const links = mockDeep<OptInLinkService>();
  stubDefaults(prisma, redis, consent, links);

  const wa = makeWhatsappProviders();
  const svc = new ChatIngestService(
    prisma,
    wa,
    events,
    redis,
    mockDeep<Queue<ChatMediaDownloadJob>>(),
    mockDeep<Queue<BotReplyJob>>(),
    consent,
    links,
  );
  return { svc, prisma, consent, events, wa };
}

/** O envelope real do GoZap (whatsmeow `events.Message`), capturado em prod. */
function webhookGozap() {
  return {
    event: 'messages',
    instance_id: 'rffe51e7ef7c8ff',
    timestamp: 1786126513000,
    data: {
      Info: {
        ID: 'GZ_WAMID_1',
        Chat: '123456789012345@lid',
        Sender: '123456789012345@lid',
        SenderAlt: '5592987654321@s.whatsapp.net',
        IsFromMe: false,
        IsGroup: false,
        PushName: 'Maria',
        Timestamp: '2026-08-07T18:15:13Z',
        Type: 'text',
      },
      Message: { conversation: 'Oi, quero saber mais' },
    },
  };
}

/** O webhook `messages.upsert` da Evolution (um texto direto, na grafia do cadastro). */
function webhookEvolution(text = 'Oi, quero saber mais') {
  return {
    event: 'messages.upsert',
    instance: 'picoa',
    data: {
      key: {
        id: 'EVO_WAMID_1',
        remoteJid: '5592987654321@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Maria',
      messageType: 'conversation',
      messageTimestamp: 1786126513,
      message: { conversation: text },
    },
  };
}

describe('ChatIngest × GOZAP — provedor desligado', () => {
  it('ingest de webhook GOZAP é no-op com o GoZap desligado', async () => {
    const { svc, prisma, consent, events } = make();

    const result = await svc.ingestFromWebhook(
      webhookGozap(),
      'ch_gozap',
      'GOZAP',
    );

    expect(result).toEqual({ parsed: 0, persisted: 0 });
    expect(prisma.message.create.mock.calls).toHaveLength(0);
    expect(prisma.conversation.upsert.mock.calls).toHaveLength(0);
    expect(prisma.contact.create.mock.calls).toHaveLength(0);
    expect(consent.record.mock.calls).toHaveLength(0);
    expect(events.publish.mock.calls).toHaveLength(0);
  });
});

describe('ChatIngest × EVOLUTION — o webhook cru pelo adapter real', () => {
  it('a resposta do eleitor vira Message INBOUND na conversa do canal', async () => {
    const { svc, prisma, events } = make();

    const result = await svc.ingestFromWebhook(
      webhookEvolution(),
      'ch_evo',
      'EVOLUTION',
    );

    expect(result).toEqual({ parsed: 1, persisted: 1 });
    const [createArgs] = prisma.message.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data).toMatchObject({
      conversationId: 'conv1',
      instanceId: 'ch_evo',
      contactId: 'c1',
      direction: MessageDirection.INBOUND,
      kind: 'TEXT',
      content: 'Oi, quero saber mais',
      providerMessageId: 'EVO_WAMID_1',
    });
    expect(events.publish.mock.calls).toContainEqual([
      expect.objectContaining({
        type: 'message.created',
        instanceId: 'ch_evo',
      }),
    ]);
  });

  /**
   * O erro CARO é o falso positivo: um `ConsentEvent` append-only afirmando que
   * um eleitor autorizou. Digitar o rótulo do botão não é tocar o botão.
   */
  it('DIGITAR "Sim, quero receber" não é toque de botão e não grava consentimento', async () => {
    const { svc, consent } = make();

    await svc.ingestFromWebhook(
      webhookEvolution('Sim, quero receber'),
      'ch_evo',
      'EVOLUTION',
    );

    expect(consent.record.mock.calls).toHaveLength(0);
  });
});

describe('ChatIngest × EVOLUTION — canal sem instância', () => {
  /**
   * O AVATAR NÃO PODE BATER NA PORTA DO EVOLUTION SEM INSTÂNCIA.
   *
   * `fetchProfilePictureUrl` endereça a instância pelo NOME. Canal sem
   * `evolutionInstanceName` nasce condenado: erro engolido pelo try/catch e log
   * de erro do Evolution poluído a cada conversa nova.
   */
  it('canal sem evolutionInstanceName não vai buscar avatar (a chamada nasceria condenada)', async () => {
    const { svc, prisma, wa } = make();
    const spy = vi.spyOn(wa, 'fetchProfilePictureUrl').mockResolvedValue(null);

    await svc.ingestFromWebhook(webhookEvolution(), 'ch_evo', 'EVOLUTION');

    expect(spy).not.toHaveBeenCalled();
    const [upsertArgs] = prisma.conversation.upsert.mock.calls[0] as [
      { create: Record<string, unknown> },
    ];
    // Sem tentativa, sem carimbo de tentativa.
    expect(upsertArgs.create.profilePicFetchedAt).toBeUndefined();
  });
});
