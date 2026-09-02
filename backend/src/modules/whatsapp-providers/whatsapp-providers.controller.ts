import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query } from '@nestjs/common';
import type { Channel, ChannelProvider } from '@prisma/client';
import { WhatsappProvidersService } from './whatsapp-providers.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelSettingsDto } from './dto/update-channel-settings.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import { ProviderNotConfiguredError } from './provider-registry.service';
import {
  ZernioAccountsService,
  type ZernioAccount,
} from './zernio-accounts.service';
import { WebhookDropsService } from './webhook-drops.service';
import { ChannelHealthService } from './channel-health.service';
import { GozapInstancesService } from './gozap-instances.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { ConnectionState } from './ports/message-provider.port';
import { warmupInfo } from '../whatsapp-instances/warmup.helper';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import type {
  ChannelSummary,
  ProvidersResponse,
  ZernioAccountsResponse,
  WebhookDropsResponse,
  ChannelHealthResponse,
} from '../../schemas/contracts/instance.schema';
import { PROVIDER_TRAITS } from '../../schemas/contracts/channel-provider.schema';

/**
 * Uma conta Zernio como uma linha legível na mensagem de erro — o operador
 * precisa reconhecer QUAL das contas é a dele, então id + número + nome.
 */
function describeAccount(a: ZernioAccount): string {
  const parts = [a.id];
  if (a.phoneE164) parts.push(a.phoneE164);
  if (a.displayName) parts.push(a.displayName);
  return parts.join(' — ');
}

@Controller('whatsapp')
export class WhatsappProvidersController {
  private readonly logger = new Logger(WhatsappProvidersController.name);

  constructor(
    private readonly wa: WhatsappProvidersService,
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly audit: AuditService,
    private readonly zernioAccounts: ZernioAccountsService,
    private readonly drops: WebhookDropsService,
    private readonly health: ChannelHealthService,
    private readonly gozapInstances: GozapInstancesService,
    private readonly providersRepo: WhatsappProvidersRepository,
  ) {}

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
   * Response shape is a hard contract with the frontend's useProviders()
   * (frontend/src/features/whatsapp/api.ts, providersResponseSchema) — do
   * not change it without updating that schema.
   */
  @Get('providers')
  async providers(): Promise<ProvidersResponse> {
    const configured = this.wa.configuredProviders();
    if (configured.length === 0) return { providers: [] };

    const channels = await this.instancesRepo.listAll();
    // Estado de conexão mais recente de cada canal, num round trip só — ver o
    // comentário de `lastStateByInstanceIds`. Some (ou nunca escreveu evento)
    // = a tela não mostra o dot, em vez de inventar "desconectado".
    const lastStates = await this.providersRepo.lastStateByInstanceIds(
      channels.map((c) => c.id),
    );
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
      // T15 — a quota de hoje vale para TODO provedor, não só EVOLUTION
      // (GET /whatsapp/instances). `warmupInfo` é a ÚNICA fonte de verdade da
      // rampa de aquecimento (warmup.helper.ts) — aqui só se lê o resultado
      // dela, nunca se reimplementa a conta.
      const warmup = warmupInfo(ch.warmupStartedAt, now, ch.dailySendLimit);
      bucket.push({
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
        sentTodayResetAt: ch.sentTodayResetAt ? ch.sentTodayResetAt.toISOString() : null,
        warmupEffectiveCap: warmup.effectiveCap,
        warming: warmup.warming,
        warmupDay: warmup.day,
        connectionState: (lastStates.get(ch.id) as ConnectionState | undefined) ?? null,
      });
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
    };
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
   * As contas WhatsApp conectadas na conta Zernio do cliente — o que o seletor
   * do form de canal ZERNIO oferece, para que o operador ESCOLHA a conta em vez
   * de digitar o `_id` à mão (foi um id digitado errado que causou a perda
   * silenciosa de um disparo inteiro em produção).
   *
   * Nunca 5xx: com o Zernio fora do ar devolve `unavailable: true` + lista
   * vazia, e o form cai no input manual em vez de travar a configuração.
   */
  @Roles('ADMIN')
  @Get('zernio/accounts')
  async zernioAccountsList(): Promise<ZernioAccountsResponse> {
    try {
      const accounts = await this.zernioAccounts.listAccounts();
      return { accounts, unavailable: false };
    } catch (err) {
      this.logger.warn(
        `GET /whatsapp/zernio/accounts: Zernio indisponível (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return { accounts: [], unavailable: true };
    }
  }

  /**
   * ZB — SAÚDE DO CANAL: o que o operador precisa ver ANTES de disparar.
   *
   * Hoje ele dispara às cegas. Aqui vêm, por canal ZERNIO: o tier da Meta e
   * QUANTO dele já foi gasto nas últimas 24h ROLANTES (a mesma contagem de
   * usuários únicos pela qual a guarda do worker o bloqueia), o quality rating,
   * e o `nameStatus` — que no cliente está **DECLINED**, ou seja, o destinatário
   * vê o número em vez do nome do negócio.
   *
   * Leitura AO VIVO no Zernio, e por isso NÃO é polling: o balde é de 60 req/min
   * por chave e é o mesmo do envio. O frontend consome sob demanda.
   */
  @Roles('ADMIN')
  @Get('channels/health')
  async channelsHealth(): Promise<ChannelHealthResponse> {
    return this.health.list();
  }

  /**
   * Creates a cloud-provider (TWILIO/ZERNIO/META) channel row directly — no
   * external provisioning happens here (unlike EVOLUTION, cloud providers
   * have nothing to provision: the number is already live on the provider's
   * side). EVOLUTION is rejected: those channels are created through the
   * existing instance-provisioning flow (POST /whatsapp/instances), which
   * actually creates the Baileys session.
   *
   * ZERNIO tem um guard-rail extra: o `zernioAccountId` é validado contra a API
   * do Zernio antes de virar linha no banco (ver abaixo).
   */
  @Roles('ADMIN')
  @Post('channels')
  async createChannel(@Body() body: CreateChannelDto) {
    if (body.provider === 'EVOLUTION') {
      throw new DomainError({
        code: 'channel.evolution_via_instance_flow',
        message:
          'Canais EVOLUTION são criados pelo fluxo de instância existente (conectar via QR Code), não por este endpoint.',
        status: 400,
        detail: 'POST /whatsapp/instances',
      });
    }
    if (!this.wa.isProviderConfigured(body.provider)) {
      throw new ProviderNotConfiguredError(body.provider);
    }

    // GOZAP: ao contrário dos outros provedores cloud (TWILIO/ZERNIO/META,
    // que só persistem uma row — o número já está vivo do lado do provedor),
    // GOZAP tem PROVISÃO EXTERNA: cria a instância no GoZap (POST
    // /instance/create), cifra o token da instância e arma o webhook. Todo
    // esse ciclo vive em GozapInstancesService (F-A Task 7) — retorna cedo
    // porque os guardas de duplicata abaixo (phoneE164/zernioAccountId) não
    // se aplicam: o número só é conhecido depois do pareamento por QR.
    if (body.provider === 'GOZAP') {
      return this.gozapInstances.createChannel({ name: body.name });
    }

    // App-level duplicate guard (no DB-level unique constraint on
    // provider+phoneE164 — see whatsapp-instances.repository.ts). A second
    // ACTIVE channel with the same provider+phone would silently split a
    // campaign's delivery across two rows. ZERNIO carries no phone here (its
    // identity is zernioAccountId, guarded below), so skip the phone check.
    if (body.phoneE164) {
      const duplicate = await this.instancesRepo.findActiveByProviderAndPhone(
        body.provider,
        body.phoneE164,
      );
      if (duplicate) {
        throw new DomainError({
          code: 'channel.duplicate_phone',
          message: `Já existe um canal ativo ${body.provider} com o número ${body.phoneE164}.`,
          status: 400,
          detail: `channelId=${duplicate.id}`,
        });
      }
    }

    // Z3: same app-level guard as above, scoped to Zernio's own account id —
    // a second ACTIVE channel reusing the same zernioAccountId would let a
    // campaign silently split delivery across two rows for that account.
    if (body.provider === 'ZERNIO' && body.zernioAccountId) {
      const duplicateAccount = await this.instancesRepo.findActiveByZernioAccountId(
        body.zernioAccountId,
      );
      if (duplicateAccount) {
        throw new DomainError({
          code: 'channel.duplicate_zernio_account',
          message: `Já existe um canal ativo com a conta Zernio ${body.zernioAccountId}.`,
          status: 400,
          detail: `channelId=${duplicateAccount.id}`,
        });
      }
    }

    // A conta Zernio informada existe MESMO? Este é o guard-rail do incidente:
    // um `zernioAccountId` errado passava por aqui sem nenhum atrito e só se
    // manifestava depois, como silêncio — os webhooks daquela conta chegavam,
    // autenticavam, não resolviam canal nenhum e eram descartados com um warn.
    // Um disparo inteiro (~100 mensagens) sumiu assim, sem nenhum sinal na UI.
    //
    // A checagem NÃO pode virar um ponto de indisponibilidade: se o Zernio
    // estiver fora do ar, criamos o canal mesmo assim (degradação) e o deixamos
    // com `zernioAccountVerifiedAt = null`, ou seja, pendente de revalidação.
    let phoneE164 = body.phoneE164;
    let zernioAccountVerifiedAt: Date | null = null;
    if (body.provider === 'ZERNIO' && body.zernioAccountId) {
      const lookup = await this.zernioAccounts.lookup(body.zernioAccountId);
      if (lookup.status === 'not_found') {
        const disponiveis = lookup.accounts.length
          ? lookup.accounts.map((a) => `• ${describeAccount(a)}`).join('\n')
          : '(nenhuma conta WhatsApp conectada na sua conta Zernio)';
        throw new DomainError({
          code: 'channel.zernio_account_not_found',
          message:
            `A conta Zernio "${body.zernioAccountId}" não existe. Um ID errado faz o orgamind ` +
            `descartar TODAS as mensagens e status recebidos dessa conta, em silêncio. ` +
            `Contas disponíveis:\n${disponiveis}`,
          status: 400,
          detail: `zernioAccountId=${body.zernioAccountId}`,
        });
      }
      if (lookup.status === 'found') {
        zernioAccountVerifiedAt = new Date();
        // Bônus: o canal ZERNIO ganha o número da própria conta (antes ficava
        // null, o que atrapalhava o inbox). Um valor explícito no body vence.
        phoneE164 = phoneE164 ?? lookup.account.phoneE164 ?? undefined;
      } else {
        this.logger.warn(
          `criando canal ZERNIO sem validar o accountId=${body.zernioAccountId} ` +
            `(Zernio indisponível: ${lookup.reason}) — pendente de revalidação`,
        );
      }
    }

    // Reactivate a soft-deleted channel holding the same globally-unique key
    // instead of a raw-P2002 500 (see createOrReactivateCloudChannel). Active
    // clashes were already rejected above.
    const channel = await this.instancesRepo.createOrReactivateCloudChannel({
      provider: body.provider,
      name: body.name,
      phoneE164,
      twilioMessagingServiceSid: body.twilioMessagingServiceSid,
      zernioAccountId: body.zernioAccountId,
      zernioAccountVerifiedAt,
    });

    // F6-style audit trail (best-effort — AuditService swallows its own
    // errors), mirrors WhatsappInstancesService.create()'s 'instance.create'.
    await this.audit.log('instance.create', 'WhatsappInstance', channel.id, {
      name: channel.name,
      provider: channel.provider,
      phoneE164: channel.phoneE164,
    });

    // A5: never expose the apiKey column, even though cloud channels never
    // populate it. gozapInstanceToken never populates on THIS path either
    // (GOZAP branched out above) — stripped anyway as defense in depth.
    const { apiKey: _apiKey, gozapInstanceToken: _t, ...safe } = channel;
    return safe;
  }

  /**
   * QR do canal GOZAP — análogo a `GET /whatsapp/instances/:id/qr`
   * (Evolution-only, ver whatsapp-instances.controller.ts), mas num endpoint
   * próprio: GOZAP não é uma "instância" Evolution, é um `Channel` cloud com
   * sessionBased=true. Delega inteiramente a GozapInstancesService —
   * getConnectionInfo já resolve a chamada certa (status vs. connect) e
   * nunca devolve o token, só `{ state, qrBase64? }`.
   */
  @Roles('ADMIN')
  @Get('channels/:id/qr')
  async gozapQr(@Param('id') id: string) {
    return this.gozapInstances.getConnectionInfo(id);
  }

  /**
   * F-A Task 7 (review fix): sem esta rota não havia NENHUM jeito de remover
   * um canal GOZAP — o único DELETE alcançável hoje (`DELETE
   * /whatsapp/instances/:id`) é Evolution-only e, se apontado a um canal
   * GOZAP, só faz soft-delete da row: nunca chama `DELETE /instance` no
   * GoZap, deixando a instância viva (e pareada) do lado do provedor, com o
   * token cifrado preso numa row inativa e sem faxina possível.
   *
   * Escopo: só GOZAP — delega inteiramente a GozapInstancesService.remove
   * (que valida `channel.provider === 'GOZAP'` e lança InstanceNotFoundError
   * caso contrário). TWILIO/ZERNIO/META não têm limpeza externa e continuam
   * sem rota própria de remoção; isso fica para quando precisarem de uma.
   */
  @Roles('ADMIN')
  @Delete('channels/:id')
  async removeChannel(@Param('id') id: string): Promise<void> {
    await this.gozapInstances.remove(id);
  }
}
