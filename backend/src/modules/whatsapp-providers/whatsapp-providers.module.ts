import { Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ChannelProvider } from '@prisma/client';
import { WhatsappProvidersService } from './whatsapp-providers.service';
import { WhatsappProvidersController } from './whatsapp-providers.controller';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import { TwilioSendersService } from './twilio-senders.service';
import { ZernioAccountsService } from './zernio-accounts.service';
import { ZernioInboxClient } from './zernio-inbox.client';
import { ZernioAnalyticsClient } from './zernio-analytics.client';
import { ZernioBroadcastSyncService } from './zernio-broadcast-sync.service';
import { ZernioAnalyticsSyncService } from './zernio-analytics-sync.service';
import { ZernioBroadcastSyncProcessor } from './zernio-broadcast-sync.processor';
import { ZernioBroadcastSyncController } from './zernio-broadcast-sync.controller';
import { WebhookDropsService } from './webhook-drops.service';
import { ChannelHealthService } from './channel-health.service';
import { ZernioTemplateService } from './zernio-template.service';
import { TwilioTierSyncProcessor } from './twilio-tier-sync.processor';
import { QUEUE_NAMES } from '../queue/queue.constants';
import {
  MESSAGE_PROVIDER,
  type MessageProvider,
} from './ports/message-provider.port';
import { ProviderRegistry } from './provider-registry.service';
import { TwilioContentService } from './twilio-content.service';
import { TwilioMediaService } from './twilio-media.service';
import { MetaCloudAdapter } from './adapters/meta-cloud.adapter';
import { EvolutionApiAdapter } from './adapters/evolution-api.adapter';
import { TwilioCloudAdapter } from './adapters/twilio-cloud.adapter';
import { ZernioCloudAdapter } from './adapters/zernio-cloud.adapter';
import { GozapCloudAdapter } from './adapters/gozap-cloud.adapter';
import { GozapInstancesService } from './gozap-instances.service';
import { GozapConnectionReconcilerProcessor } from './gozap-connection-reconciler.processor';
import { WhatsappInstancesModule } from '../whatsapp-instances/whatsapp-instances.module';
import { ZernioBroadcastClient } from './zernio-broadcast.client';
import {
  configuredProviderGroups,
  type Env,
} from '../../shared/config/env.schema';

// The env keys the registry consults to decide which provider groups are
// complete (mirrors env.schema's group definitions). Built from ConfigService
// at DI time — no `process.env` at module scope anymore.
const PROVIDER_ENV_KEYS = [
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'EVOLUTION_BASE_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE_NAME',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'TWILIO_MESSAGING_SERVICE_SID',
  'ZERNIO_API_KEY',
  'ZERNIO_BASE_URL',
  'ZERNIO_WEBHOOK_SECRET',
  'GOZAP_BASE_URL',
  'GOZAP_ADMIN_TOKEN',
  'GOZAP_WEBHOOK_TOKEN',
  'GOZAP_TOKEN_ENCRYPTION_KEY',
] as const;

function envSnapshot(config: ConfigService<Env>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const key of PROVIDER_ENV_KEYS) {
    snap[key] = config.get(key as keyof Env, { infer: true });
  }
  return snap;
}

// The multi-provider registry: injects all three adapters + ConfigService, and
// registers ONLY the providers whose env group is complete. The adapters are
// plain Nest providers below, so their constructors/lifecycle hooks run once and
// the registry just decides which ones are reachable per channel.
const registryProvider: Provider = {
  provide: ProviderRegistry,
  inject: [
    ConfigService,
    MetaCloudAdapter,
    EvolutionApiAdapter,
    TwilioCloudAdapter,
    ZernioCloudAdapter,
    GozapCloudAdapter,
  ],
  useFactory: (
    config: ConfigService<Env>,
    meta: MetaCloudAdapter,
    evolution: EvolutionApiAdapter,
    twilio: TwilioCloudAdapter,
    zernio: ZernioCloudAdapter,
    gozap: GozapCloudAdapter,
  ) => {
    const configured = new Set(configuredProviderGroups(envSnapshot(config)));
    const map = new Map<ChannelProvider, MessageProvider>();
    if (configured.has('meta')) map.set('META', meta);
    if (configured.has('evolution')) map.set('EVOLUTION', evolution);
    if (configured.has('twilio')) map.set('TWILIO', twilio);
    if (configured.has('zernio')) map.set('ZERNIO', zernio);
    if (configured.has('gozap')) map.set('GOZAP', gozap);
    return new ProviderRegistry(map);
  },
};

// Legacy single-provider token (MESSAGE_PROVIDER). @deprecated: F6 removed
// the WHATSAPP_PROVIDER env selector; this factory now picks a default
// adapter from whichever provider GROUPS are actually configured on this
// deploy (evolution > meta > twilio — same priority the old default implied,
// since 'evolution' was every real deploy's default). Still resolved via
// ConfigService (not `process.env` at module scope). Kept alive only for
// WhatsappProvidersService's remaining legacy delegates (parseInboundMessages
// / parseInboundChatMessages) that don't yet resolve a specific channel —
// callers that know their channel/provider should use the registry-backed
// *For methods instead.
const legacyProvider: Provider = {
  provide: MESSAGE_PROVIDER,
  inject: [ConfigService, MetaCloudAdapter, EvolutionApiAdapter, TwilioCloudAdapter],
  useFactory: (
    config: ConfigService<Env>,
    meta: MetaCloudAdapter,
    evolution: EvolutionApiAdapter,
    twilio: TwilioCloudAdapter,
  ): MessageProvider => {
    const configured = new Set(configuredProviderGroups(envSnapshot(config)));
    if (configured.has('evolution')) return evolution;
    if (configured.has('meta')) return meta;
    return twilio;
  },
};

@Module({
  imports: [
    ConfigModule,
    WhatsappInstancesModule,
    // ★ I16 (revisão de integração, 2026-08-19) — AQUI HAVIA SETE
    // `registerQueue` PELADOS, E ELES SOMBREAVAM A POLÍTICA GLOBAL.
    //
    // Um `registerQueue` sem `defaultJobOptions` cria uma SEGUNDA instância de
    // Queue para o mesmo nome e ela GANHA de quem injeta de dentro deste
    // módulo. O `campaigns.module.ts` tinha acabado de tirar os dele e o
    // comentário de lá declarava o problema resolvido — mas quem enfileira o
    // volume do cliente é o `ZernioBroadcastSendService`, que injeta a fila de
    // ENVIO DAQUI (ver `@InjectQueue(QUEUE_NAMES.WHATSAPP_SEND)`). O defeito
    // seguia inteiro no caminho que mais roda:
    //
    //  • ENVIO (fallback 1-a-1 do broadcast) — sem `attempts`, o caminho
    //    retryável do worker faz `releaseClaim` (SENDING→QUEUED) e RELANÇA
    //    contando com a retentativa do BullMQ. Sem ela a mensagem fica QUEUED
    //    PARA SEMPRE, sem job; nenhum sweeper cobre esse estado, `countInFlight`
    //    a conta como em voo e a campanha fica "Em execução" eternamente.
    //  • ENVIO — sem `removeOnComplete`/`removeOnFail`, um disparo de 13.400
    //    pessoas deixa 13.400 hashes permanentes no MESMO Redis dos locks de
    //    campanha, do pacing e dos contadores de tier.
    //  • CANCELAMENTO do broadcast — `attempts: 5` é o mais teimoso da casa de
    //    propósito: é ele que PARA um disparo em voo quando a conta é bloqueada
    //    (131031) ou o template é pausado (132015). Sombreado, desistia na
    //    primeira tentativa, e desistir aqui é deixar o Zernio continuar
    //    mandando.
    //
    // Todas as filas abaixo que já existem no `queue.module.ts` (@Global,
    // `exports: [BullModule]`) NÃO são mais registradas aqui: o `@InjectQueue`
    // as resolve de lá, com a política de lá. Quem quiser mudar a política de
    // qualquer uma delas mexe num lugar só — `queue.module.ts`, que é a
    // autoridade. `campaigns.module.queues.spec.ts` monta ESTE módulo junto com
    // o global e prende o resultado.
    //
    // Sobram DUAS registrações, e as duas são deliberadas e EXPLÍCITAS (nada de
    // pelado): o DISPARO do broadcast, cuja política própria já existe e não
    // pode mudar de valor por causa desta faxina, e o reconciliador de conexão
    // do GoZap, que não existe no `queue.module.ts` — este é o único lugar que
    // pode declarar a política dele.
    //
    // ⚠️ ZB — o DISPARO do broadcast. `attempts: 1`, o MESMO número (e a mesma
    // razão) do `campaigns.module.ts`, e ele DIVERGE do `queue.module.ts`, que
    // registra `attempts: 2`. A divergência é antiga e conhecida; o que NÃO
    // podia acontecer era esta correção mudá-la de lado sem ninguém pedir.
    // Hoje, em produção, este injetor roda com UMA tentativa (o registro pelado
    // zerava `attempts`, e o default do BullMQ é 1); tirar a registração daqui
    // o promoveria em silêncio a 2. Nenhum endpoint de broadcast do Zernio
    // aceita `Idempotency-Key`: se o `POST /broadcasts/{id}/send` for aceito e a
    // resposta se perder (timeout), a retentativa NÃO é neutra — ela redispara
    // o LOTE INTEIRO, as mesmas milhares de pessoas recebendo duas vezes, num
    // número que já teve display name reprovado pela Meta. O que esta correção
    // acrescenta é o que faltava: a LIMPEZA do Redis.
    //
    // Para unificar em 2 seria preciso antes tornar `zernio-broadcast-send`
    // idempotente — a decisão é de quem for mexer no `queue.module.ts`, que é a
    // autoridade da política, e vale para os TRÊS lugares de uma vez.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    // Reconciliador de conexão do GOZAP (o CONNECTION_RECONCILER é
    // Evolution-only). O job repetível é registrado no worker.ts.
    // `attempts: 1` como os outros reconciliadores do `queue.module.ts`: o tick
    // é de 60 em 60s e é idempotente, repetir a mesma falha só empilha chamadas
    // ao GoZap sem trazer nada de novo.
    BullModule.registerQueue({
      name: QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
  ],
  controllers: [WhatsappProvidersController, ZernioBroadcastSyncController],
  providers: [
    MetaCloudAdapter,
    EvolutionApiAdapter,
    TwilioCloudAdapter,
    ZernioCloudAdapter,
    GozapCloudAdapter,
    // F-A Task 7 — ciclo de vida da instância GoZap (criação/QR/desconexão),
    // separado do adapter de envio (ver a nota no topo de gozap-cloud.adapter.ts).
    GozapInstancesService,
    // Puxa o estado da sessão GoZap de 60 em 60s e converge o banco — sem ele
    // um canal pareado fica offline para o roteador de envio (incidente
    // 2026-08-07), e uma sessão que cai nunca é notada.
    GozapConnectionReconcilerProcessor,
    registryProvider,
    legacyProvider,
    WhatsappProvidersService,
    WhatsappProvidersRepository,
    // Twilio Content API client (template catalog + approvals). Exported for
    // the templates module's template-approval-sync processor.
    TwilioContentService,
    // Twilio inbound media downloader (Basic Auth + redirect). Exported for
    // the chat-media download processor (worker).
    TwilioMediaService,
    // Senders API v2 (messaging_limit/quality_rating) + tier-sync diário do
    // dailySendLimit (T8) — mesmo padrão do template-approval-sync.
    TwilioSendersService,
    TwilioTierSyncProcessor,
    // Cliente de `GET /accounts` do Zernio: valida o zernioAccountId na criação
    // do canal e alimenta o seletor de contas da página Canais.
    ZernioAccountsService,
    // Leitura do inbox do Zernio (conversas + mensagens). Exportado para o
    // ZernioInboxSyncService (ChatModule), que traz para o orgamind o histórico
    // que aconteceu FORA dele — inclusive o anterior ao webhook.
    ZernioInboxClient,
    // Detecção da perda silenciosa de webhook (conta sem canal). Exportado para
    // os controllers de webhook do Zernio e da Twilio.
    WebhookDropsService,
    // ZB — a saúde do canal na página Canais (tier + uso em 24h, qualidade,
    // nameStatus). Lê o Zernio ao vivo, sob demanda.
    ChannelHealthService,
    // ZC — catálogo de templates do Zernio (GET /whatsapp/templates?accountId=).
    // Exportado para o TemplatesModule, como o TwilioContentService.
    ZernioTemplateService,
    // ZD — leitura dos disparos (`GET /broadcasts`) e do volume de mensagens
    // (`GET /analytics/inbox/volume`) do Zernio. É o que dá ao orgamind a visão do
    // que foi disparado FORA dele, pelo painel.
    ZernioAnalyticsClient,
    ZernioBroadcastSyncService,
    ZernioAnalyticsSyncService,
    ZernioBroadcastSyncProcessor,
    // ★ ZB — o CLIENTE de escrita do broadcast (POST /broadcasts → /recipients →
    // /send → /cancel). É o que faz a campanha do orgamind APARECER NO PAINEL do
    // Zernio: o envio 1-a-1 usa `POST /inbox/conversations`, que não cria disparo
    // nenhum lá.
    //
    // Só o CLIENTE mora aqui. Os SERVIÇOS que o usam (send/poll/cancel) precisam
    // do CampaignsRepository, e `WhatsappProvidersModule → CampaignsModule`
    // fecharia um ciclo (CampaignsModule → TemplatesModule → este módulo). Eles
    // são registrados no WorkerModule, exatamente como o ZernioTierSyncProcessor
    // — ver a nota lá.
    ZernioBroadcastClient,
  ],
  exports: [
    WhatsappProvidersService,
    WhatsappProvidersRepository,
    ProviderRegistry,
    TwilioContentService,
    TwilioMediaService,
    TwilioSendersService,
    ZernioAccountsService,
    ZernioInboxClient,
    ZernioTemplateService,
    ZernioAnalyticsClient,
    ZernioBroadcastSyncService,
    ZernioAnalyticsSyncService,
    WebhookDropsService,
    // ZB — exportado para o WorkerModule, onde vivem os serviços de broadcast
    // (que precisam do CampaignsRepository e por isso não podem morar aqui).
    ZernioBroadcastClient,
  ],
})
export class WhatsappProvidersModule {}
