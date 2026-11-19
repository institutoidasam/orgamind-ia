import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Channel, ChannelProvider } from '@prisma/client';
import { WhatsappProvidersService } from './whatsapp-providers.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelSettingsDto } from './dto/update-channel-settings.dto';
import { UpdateChannelSectorsDto } from './dto/update-channel-sectors.dto';
import {
  SectorChannelService,
  type ChannelSector,
  type ChannelSectorsResult,
} from './sector-channel.service';
import type { JwtPayload } from '../auth/jwt.strategy';
import { Roles } from '../auth/decorators/roles.decorator';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import { WebhookDropsService } from './webhook-drops.service';
import { DisabledChannelsService } from './disabled-channels.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { ConnectionState } from './ports/message-provider.port';
import { warmupInfo } from '../whatsapp-instances/warmup.helper';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { ChannelProviderDisabledError } from '../../shared/errors/channel-provider-disabled.error';
import { isEnabledChannelProvider } from '../../shared/config/enabled-providers';
import type {
  ChannelSummary,
  DisabledChannelContract,
  ProvidersResponse,
  WebhookDropsResponse,
} from '../../schemas/contracts/instance.schema';
import { PROVIDER_TRAITS } from '../../schemas/contracts/channel-provider.schema';

type AuthRequest = { user: JwtPayload };
type ChannelRow = Awaited<
  ReturnType<WhatsappInstancesRepository['listAll']>
>[number];

@Controller('whatsapp')
export class WhatsappProvidersController {
  private readonly logger = new Logger(WhatsappProvidersController.name);

  constructor(
    private readonly wa: WhatsappProvidersService,
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly audit: AuditService,
    private readonly drops: WebhookDropsService,
    private readonly providersRepo: WhatsappProvidersRepository,
    private readonly disabledChannels: DisabledChannelsService,
  ) {}

  // Injetado por propriedade: o construtor de DI já passava do limite de
  // parâmetros do gate (8) e cada parâmetro novo o piora.
  @Inject(SectorChannelService)
  private readonly sectorChannel!: SectorChannelService;

  /**
   * List the WhatsApp Business labels available on the connected number.
   * Used by the per-contact label picker so the operator can map a ORGAMIND
   * contact to existing WA labels.
   *
   * Pass `?instanceId=<uuid>` to target a specific WhatsApp instance.
   * When omitted, the default instance is used.
   */
  @Roles('ADMIN')
  @Get('labels')
  async listLabels(@Query('instanceId') instanceId?: string) {
    let evolutionInstanceName: string | undefined;
    if (instanceId) {
      const record = await this.instancesRepo.findById(instanceId);
      // A caller that explicitly asks for an instance must not silently get the
      // env-default number's labels when the id is stale/unknown — otherwise the
      // label picker maps the contact to the wrong number's WA labels.
      if (!record?.evolutionInstanceName) {
        throw new InstanceNotFoundError(instanceId);
      }
      evolutionInstanceName = record.evolutionInstanceName;
    } else {
      const record = await this.instancesRepo.findDefault();
      evolutionInstanceName = record?.evolutionInstanceName ?? undefined;
    }
    return this.wa.fetchLabels(evolutionInstanceName);
  }

  /**
   * The providers configured on this deploy (registry — see
   * ProviderRegistry.configured()), each with ALL its channels (active and
   * inactive, isActive surfaced), plus the adapter's DECLARED traits +
   * capabilities (F0 — ProviderProfile, ver ports/provider-profile.ts).
   * Powers the topbar's provider scope selector and any provider-aware
   * screens (F1/F2), and lets the frontend stop maintaining its own
   * duplicated copy of provider policy. A provider absent from the registry
   * (env group incomplete) never appears here, even if the DB happens to
   * hold channel rows for it.
   *
   * `disabledChannels` (C3): os números ativos de provedor desligado, para o
   * ADMIN removê-los. Só o ADMIN os recebe; os demais papéis recebem `[]`.
   *
   * Response shape is a hard contract with the frontend's useProviders()
   * (frontend/src/features/whatsapp/api.ts, providersResponseSchema) — do
   * not change it without updating that schema.
   */
  @Get('providers')
  async providers(@Req() req: AuthRequest): Promise<ProvidersResponse> {
    const disabledChannels = await this.disabledChannelsFor(req.user);
    const configured = this.wa.configuredProviders();
    if (configured.length === 0) return { providers: [], disabledChannels };

    const channels = await this.instancesRepo.listAll();
    // Estado de conexão mais recente de cada canal, num round trip só — ver o
    // comentário de `lastStateByInstanceIds`. Some (ou nunca escreveu evento)
    // = a tela não mostra o dot, em vez de inventar "desconectado".
    const ids = channels.map((c) => c.id);
    // Áreas de cada número também num round trip só (lista vazia = nenhuma).
    const [lastStates, sectorsByChannel] = await Promise.all([
      this.providersRepo.lastStateByInstanceIds(ids),
      this.sectorChannel.sectorsByChannel(ids),
    ]);
    const byProvider = new Map<ChannelProvider, ChannelSummary[]>(
      configured.map((provider) => [provider, []]),
    );
    // T15 — um `now` só para a requisição inteira: todo canal do resumo usa o
    // MESMO instante para calcular a rampa (warmupInfo), então dois canais
    // lidos na mesma resposta nunca podem discordar sobre "que dia é hoje".
    const now = new Date();
    for (const ch of channels) {
      const bucket = byProvider.get(ch.provider);
      if (!bucket) continue; // provider not configured on this deploy — exclude
      bucket.push(
        this.channelSummary(ch, { now, lastStates, sectorsByChannel }),
      );
    }
    return {
      providers: configured.map((provider) => {
        const profile = this.wa.profileFor(provider);
        return {
          provider,
          traits: profile?.traits ?? PROVIDER_TRAITS[provider],
          capabilities: profile ? [...profile.capabilities].sort() : [],
          channels: byProvider.get(provider) ?? [],
        };
      }),
      disabledChannels,
    };
  }

  /** Só o ADMIN vê os números desligados (GC8); os demais papéis recebem `[]`. */
  private disabledChannelsFor(
    user: JwtPayload,
  ): Promise<DisabledChannelContract[]> {
    return user.role === 'ADMIN'
      ? this.disabledChannels.listDisabled()
      : Promise.resolve([]);
  }

  /**
   * SAÚDE: os webhooks que chegaram, autenticaram e foram DESCARTADOS porque
   * nenhum canal ativo corresponde à conta/número que os enviou.
   *
   * É o endpoint que torna a perda visível. Antes, esse caso era só um
   * `logger.warn` + HTTP 200 — e um disparo real de ~100 mensagens sumiu sem que
   * nada na interface indicasse o problema. A página Canais consome isto e mostra
   * um banner com a conta órfã e a contagem. Some sozinho quando o canal certo é
   * criado (ver WebhookDropsService.listUnresolved).
   *
   * Sem @Roles: um OPERATOR que abre a página Canais precisa ver o alerta (e
   * chamar um admin), não um 403 silencioso — silêncio é exatamente o bug.
   */
  @Get('webhook-drops')
  async webhookDrops(): Promise<WebhookDropsResponse> {
    return { drops: await this.drops.listUnresolved() };
  }

  /**
   * As configurações do canal, num endpoint só: ativar/desativar e o BROADCAST do
   * Zernio. Patch parcial — o que não vem no body não é tocado.
   *
   * ── ATIVAR/DESATIVAR ───────────────────────────────────────────────────────
   * A base tem mais de uma conta Zernio e só UMA pode disparar. A conta proibida
   * aparecia como opção no assistente de campanha; um clique errado mandaria a
   * campanha inteira pelo número errado, e não existe "despublicar" WhatsApp.
   *
   * DESATIVAR NÃO APAGA. O canal continua no banco, com conversas e histórico.
   * O que muda: some dos seletores (assistente, abas do inbox), deixa de ser (e
   * de poder virar) o padrão, o roteador de envio já o recusa, e o webhook que
   * chegar continua descartado + registrado (WebhookDrop) — inalterado.
   *
   * ── BROADCAST DO ZERNIO ────────────────────────────────────────────────────
   * Ligado, a campanha vira um broadcast NATIVO e aparece no painel do Zernio.
   * Desligado (o PADRÃO) é o 1-a-1 — que é também o FALLBACK.
   *
   * ⚠️ O broadcast NÃO PERSONALIZA (ver zernio-broadcast-variables.ts): o
   * `/recipients` do Zernio só aceita telefones, e as variáveis são resolvidas
   * contra o CRM DELES, onde o contato auto-criado nasce sem nome. Um template com
   * variável de CAMPO cai automaticamente no 1-a-1, mesmo com a flag ligada. A
   * tela diz isso — senão o operador liga, dispara, e não entende por que nada
   * apareceu no painel.
   */
  @Roles('ADMIN')
  @Patch('channels/:id')
  async updateChannel(
    @Param('id') id: string,
    @Body() body: UpdateChannelSettingsDto,
  ): Promise<Omit<Channel, 'apiKey' | 'gozapInstanceToken'>> {
    const channel = await this.instancesRepo.findById(id);
    if (!channel) throw new InstanceNotFoundError(id);

    const wantsBroadcast =
      body.zernioBroadcastEnabled !== undefined ||
      body.zernioBroadcastChunk !== undefined;

    // Broadcast é capacidade do ZERNIO. Gravar a flag num canal TWILIO/EVOLUTION
    // guardaria uma configuração que NUNCA teria efeito — e o operador ficaria
    // esperando um broadcast que não vai existir.
    if (wantsBroadcast && channel.provider !== 'ZERNIO') {
      throw new DomainError({
        code: 'channel.broadcast_unsupported',
        message: `O broadcast é uma capacidade do ZERNIO — o canal ${channel.name} é ${channel.provider}.`,
        status: 400,
      });
    }

    // REATIVAÇÃO: o mesmo guard do POST /whatsapp/channels. Sem ele, religar um
    // canal cuja identidade (conta Zernio, ou provider+número) já foi assumida
    // por outro canal ATIVO deixaria DOIS canais ativos para o mesmo número — e a
    // entrega de uma campanha se dividiria, em silêncio, entre as duas linhas.
    if (body.active === true && !channel.isActive) {
      if (channel.zernioAccountId) {
        const clash = await this.instancesRepo.findActiveByZernioAccountId(
          channel.zernioAccountId,
        );
        if (clash && clash.id !== id) {
          throw new DomainError({
            code: 'channel.duplicate_zernio_account',
            message: `Já existe um canal ativo com a conta Zernio ${channel.zernioAccountId}. Desative-o antes de reativar este.`,
            status: 400,
            detail: `channelId=${clash.id}`,
          });
        }
      } else if (channel.phoneE164) {
        const clash = await this.instancesRepo.findActiveByProviderAndPhone(
          channel.provider,
          channel.phoneE164,
        );
        if (clash && clash.id !== id) {
          throw new DomainError({
            code: 'channel.duplicate_phone',
            message: `Já existe um canal ativo ${channel.provider} com o número ${channel.phoneE164}. Desative-o antes de reativar este.`,
            status: 400,
            detail: `channelId=${clash.id}`,
          });
        }
      }
    }

    const data: Parameters<typeof this.instancesRepo.updateSettings>[1] = {};
    if (body.active !== undefined) {
      data.isActive = body.active;
      // Desativar LIMPA o padrão: `findDefault()` não filtra isActive, então um
      // canal desativado que continuasse `isDefault` seguiria sendo eleito pelo
      // roteador — a desativação não teria servido para nada.
      if (body.active === false) data.isDefault = false;
    }
    if (body.zernioBroadcastEnabled !== undefined) {
      data.zernioBroadcastEnabled = body.zernioBroadcastEnabled;
    }
    if (body.zernioBroadcastChunk !== undefined) {
      data.zernioBroadcastChunk = body.zernioBroadcastChunk;
    }

    // Body vazio é no-op, não erro: nada a fazer é um resultado legítimo.
    if (Object.keys(data).length === 0) {
      // be-gozap: este endpoint é genérico (qualquer provider, inclusive
      // GOZAP) — o token cifrado nunca pode sair daqui, mesmo no ramo no-op.
      const { apiKey: _unused, gozapInstanceToken: _t1, ...current } = channel;
      return current;
    }

    const updated = await this.instancesRepo.updateSettings(id, data);
    await this.audit.log('instance.update_settings', 'WhatsappInstance', id, {
      ...body,
      name: channel.name,
      provider: channel.provider,
    });

    const { apiKey: _apiKey, gozapInstanceToken: _t2, ...safe } = updated;
    return safe;
  }

  /**
   * Só a Evolution está ligada (R4): criar canal de qualquer outro provedor é
   * 422 `channel.provider_disabled`, ANTES de qualquer outra checagem (o
   * registry só conhece a Evolution, então `isProviderConfigured` daria um 400
   * enganoso). EVOLUTION nasce pelo fluxo de instância (QR Code), nunca por
   * aqui: continua a recusa 400 de sempre.
   */
  @Roles('ADMIN')
  @Post('channels')
  createChannel(@Body() body: CreateChannelDto): never {
    if (!isEnabledChannelProvider(body.provider)) {
      throw new ChannelProviderDisabledError(body.provider, 422);
    }
    throw new DomainError({
      code: 'channel.evolution_via_instance_flow',
      message:
        'Canais EVOLUTION são criados pelo fluxo de instância existente (conectar via QR Code), não por este endpoint.',
      status: 400,
      detail: 'POST /whatsapp/instances',
    });
  }

  /**
   * Resumo de um canal para `GET /whatsapp/providers`. Um `now` só para a
   * requisição inteira: todo canal usa o MESMO instante para calcular a rampa.
   */
  private channelSummary(
    ch: ChannelRow,
    ctx: {
      now: Date;
      lastStates: Map<string, string>;
      sectorsByChannel: Map<string, ChannelSector[]>;
    },
  ): ChannelSummary {
    // T15 — a quota de hoje vale para TODO provedor, não só EVOLUTION
    // (GET /whatsapp/instances). `warmupInfo` é a ÚNICA fonte de verdade da
    // rampa de aquecimento (warmup.helper.ts) — aqui só se lê o resultado
    // dela, nunca se reimplementa a conta.
    const warmup = warmupInfo(ch.warmupStartedAt, ctx.now, ch.dailySendLimit);
    return {
      id: ch.id,
      name: ch.name,
      phoneE164: ch.phoneE164,
      isActive: ch.isActive,
      isDefault: ch.isDefault,
      provider: ch.provider,
      // Sem isto a tela Canais não teria como MOSTRAR o estado do broadcast — e
      // ligá-lo seguiria exigindo SQL direto em produção.
      zernioBroadcastEnabled: ch.zernioBroadcastEnabled,
      zernioBroadcastChunk: ch.zernioBroadcastChunk,
      // Deixa o form de cadastro marcar as contas Zernio que já têm canal —
      // o operador vê "já cadastrada" na lista em vez do erro pós-submit.
      zernioAccountId: ch.zernioAccountId,
      dailySendLimit: ch.dailySendLimit,
      sentToday: ch.sentToday,
      sentTodayResetAt: ch.sentTodayResetAt
        ? ch.sentTodayResetAt.toISOString()
        : null,
      warmupEffectiveCap: warmup.effectiveCap,
      warming: warmup.warming,
      warmupDay: warmup.day,
      connectionState:
        (ctx.lastStates.get(ch.id) as ConnectionState | undefined) ?? null,
      sectors: ctx.sectorsByChannel.get(ch.id) ?? [],
    };
  }

  /**
   * Associa o número às áreas que ele atende (só ADMIN, como conectar número).
   * A lista é o estado final: áreas ausentes saem do número e a que já estava
   * em outro número é movida (a confirmação é do front — D16). Vale para GoZap e
   * Evolution; outro canal ou inativo dá 422 `channel.sectors_not_team`.
   */
  @Roles('ADMIN')
  @Put('channels/:id/sectors')
  async setChannelSectors(
    @Param('id') id: string,
    @Body() body: UpdateChannelSectorsDto,
    @Req() req: AuthRequest,
  ): Promise<ChannelSectorsResult> {
    return this.sectorChannel.assign({
      channelId: id,
      sectorIds: body.sectorIds,
      actorId: req.user.sub,
    });
  }

  /**
   * Remove um número de provedor desligado (R6, só ADMIN): inativa, solta as
   * áreas e falha as mensagens paradas dele, tudo local, sem chamar o provedor.
   * Número Evolution dá 422 `channel.not_disabled`: ele sai pelo menu da conexão.
   */
  @Roles('ADMIN')
  @Delete('channels/:id')
  @HttpCode(204)
  async removeChannel(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.disabledChannels.remove({
      channelId: id,
      actorId: req.user.sub,
    });
  }
}
