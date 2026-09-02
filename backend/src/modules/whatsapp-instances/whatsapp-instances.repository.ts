import { Injectable } from '@nestjs/common';
import type { Channel, ChannelProvider } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

// A5: read responses never expose the per-instance Evolution apiKey.
// be-gozap: nor the (encrypted-at-rest) GoZap instance token — same rationale
// as apiKey, see the Channel.gozapInstanceToken column comment in schema.prisma.
type SafeWhatsappInstance = Omit<Channel, 'apiKey' | 'gozapInstanceToken'>;

@Injectable()
export class WhatsappInstancesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Channel | null> {
    return this.prisma.channel.findUnique({ where: { id } });
  }

  // Inbound resolution: webhook ingestion maps an Evolution instance name back
  // to our row via this method. Soft-deleted (isActive=false) instances must
  // NOT resolve — otherwise a removed number keeps ingesting inbound webhooks
  // into conversations/contacts. evolutionInstanceName is @unique, so a
  // findFirst with isActive=true returns at most one row (findUnique can't take
  // a non-unique filter).
  findByEvolutionName(name: string): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: { evolutionInstanceName: name, isActive: true },
    });
  }

  // T4: the system-default fallback (router) must never hand a campaign a
  // channel from a DIFFERENT provider than the one it's configured for — so
  // scope by provider when given one. Kept optional (and the unfiltered query
  // shape unchanged) for existing callers that just want "the" system default
  // regardless of provider.
  //
  // T8: setDefault is now scoped PER PROVIDER (see below), so more than one
  // row can have isDefault=true at once (one per configured provider). The
  // unscoped findDefault() call therefore needs a deterministic pick instead
  // of an arbitrary DB row order — semantics: "the system default" (legacy,
  // provider-agnostic callers) = the FIRST default ever set, i.e. oldest by
  // createdAt. Callers relying on this today: whatsapp-providers.controller
  // (GET /whatsapp/provider legacy labels), whatsapp-providers.service
  // (handleContactLabel) and contacts/contact-sync.processor.
  findDefault(provider?: ChannelProvider): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: provider ? { isDefault: true, provider } : { isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  listActive(): Promise<Channel[]> {
    return this.prisma.channel.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  listAll(): Promise<Channel[]> {
    return this.prisma.channel.findMany({
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async listActiveWithState(): Promise<Array<SafeWhatsappInstance & { lastConnectionState: string | null; botDifyAppId: string | null; botName: string | null }>> {
    const rows = await this.prisma.channel.findMany({
      // This backs GET /whatsapp/instances — the Evolution instance list
      // (QR / apiKey / connection state). Cloud channels (TWILIO/ZERNIO/META)
      // carry a null evolutionInstanceName and no connection state, so they'd
      // both break the frontend instanceSchema (evolutionInstanceName: string)
      // and be meaningless here; they're managed via GET /whatsapp/providers.
      where: { isActive: true, provider: 'EVOLUTION' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      // A5: never leak the per-instance Evolution apiKey on read responses.
      // Internal Evolution calls authenticate with the global EVOLUTION_API_KEY,
      // so the DB column is write-only after create and safe to omit here.
      // gozapInstanceToken: this query is EVOLUTION-scoped so it never applies
      // in practice, but the omit is kept in lockstep with the other Channel
      // reads below — defense in depth if the `where` ever loosens.
      omit: { apiKey: true, gozapInstanceToken: true },
      include: {
        bot: { select: { difyAppId: true, name: true } },
        connectionEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { state: true },
        },
      },
    });
    return rows.map(({ connectionEvents, bot, ...rest }) => ({
      ...rest,
      botDifyAppId: bot?.difyAppId ?? null,
      botName: bot?.name ?? null,
      lastConnectionState: connectionEvents[0]?.state ?? null,
    }));
  }

  async listAllWithState(): Promise<Array<SafeWhatsappInstance & { lastConnectionState: string | null; botDifyAppId: string | null; botName: string | null }>> {
    const rows = await this.prisma.channel.findMany({
      // Evolution instance list (see listActiveWithState) — Evolution only.
      where: { provider: 'EVOLUTION' },
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
      omit: { apiKey: true, gozapInstanceToken: true }, // A5 / be-gozap: never leak either secret on read responses
      include: {
        bot: { select: { difyAppId: true, name: true } },
        connectionEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { state: true },
        },
      },
    });
    return rows.map(({ connectionEvents, bot, ...rest }) => ({
      ...rest,
      botDifyAppId: bot?.difyAppId ?? null,
      botName: bot?.name ?? null,
      lastConnectionState: connectionEvents[0]?.state ?? null,
    }));
  }

  async findByIdWithState(id: string): Promise<(SafeWhatsappInstance & { lastConnectionState: string | null; botDifyAppId: string | null; botName: string | null }) | null> {
    const row = await this.prisma.channel.findUnique({
      where: { id },
      // Not provider-scoped (unlike the list* queries above) — a GOZAP
      // channel's id CAN reach this via GET /whatsapp/instances/:id, so the
      // gozapInstanceToken omit here is load-bearing, not just defense in depth.
      omit: { apiKey: true, gozapInstanceToken: true }, // A5 / be-gozap
      include: {
        bot: { select: { difyAppId: true, name: true } },
        connectionEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { state: true },
        },
      },
    });
    if (!row) return null;
    const { connectionEvents, bot, ...rest } = row;
    return {
      ...rest,
      botDifyAppId: bot?.difyAppId ?? null,
      botName: bot?.name ?? null,
      lastConnectionState: connectionEvents[0]?.state ?? null,
    };
  }

  create(data: {
    name: string;
    evolutionInstanceName: string;
    apiKey: string;
    ownerUserId?: string | null;
    isDefault?: boolean;
  }): Promise<Channel> {
    return this.prisma.channel.create({ data });
  }

  /**
   * F-A Task 7: persists a GOZAP channel row AFTER the instance was already
   * provisioned on GoZap (POST /instance/create) — unlike createCloudChannel
   * (TWILIO/ZERNIO/META), GOZAP has external provisioning, owned by
   * GozapInstancesService. `gozapInstanceToken` MUST already be the
   * gozap-token-cipher CIPHERTEXT here — this method never encrypts, it only
   * persists whatever the caller hands it.
   */
  /**
   * F-A Task 7 (review fix): guard de duplicata na criação — sem isto, um
   * duplo-clique ou um retry em POST /instance/create sobre o MESMO nome
   * provisiona DUAS instâncias no GoZap (o @unique de gozapInstanceId nunca
   * pega essa colisão, porque cada create do GoZap gera um id diferente) e
   * deixa duas rows ativas órfãs. Escopo: só ACTIVE — um canal removido
   * (remove() já chamou DELETE /instance no GoZap) libera o nome de novo.
   */
  findActiveGozapChannelByName(name: string): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: { provider: 'GOZAP', name, isActive: true },
    });
  }

  createGozapChannel(data: {
    name: string;
    gozapInstanceId: string;
    gozapInstanceToken: string;
  }): Promise<Channel> {
    return this.prisma.channel.create({
      data: {
        provider: 'GOZAP',
        name: data.name,
        gozapInstanceId: data.gozapInstanceId,
        gozapInstanceToken: data.gozapInstanceToken,
      },
    });
  }

  /**
   * T8: POST /whatsapp/channels — persists a cloud-provider (TWILIO/ZERNIO/
   * META) channel row directly, without provisioning anything externally.
   * evolutionInstanceName/apiKey are left unset (both nullable since the
   * multi-provider migration) — they only apply to EVOLUTION channels, which
   * are created via the existing instance-provisioning flow instead.
   */
  createCloudChannel(data: {
    provider: ChannelProvider;
    name: string;
    // ZERNIO no longer has to be phone-less: the create flow now reads the
    // number off the validated Zernio account (metadata.displayPhoneNumber) and
    // backfills it here. Still optional — a degraded create (Zernio API down)
    // has no account to read it from. Required for TWILIO/META, enforced at the
    // API boundary (createChannelSchema).
    phoneE164?: string;
    twilioMessagingServiceSid?: string;
    zernioAccountId?: string;
    /** Quando o zernioAccountId foi conferido contra a API do Zernio (null = não foi). */
    zernioAccountVerifiedAt?: Date | null;
  }): Promise<Channel> {
    return this.prisma.channel.create({
      data: {
        provider: data.provider,
        name: data.name,
        phoneE164: data.phoneE164 ?? null,
        twilioMessagingServiceSid: data.twilioMessagingServiceSid,
        zernioAccountId: data.zernioAccountId,
        zernioAccountVerifiedAt: data.zernioAccountVerifiedAt ?? null,
      },
    });
  }

  /**
   * Create a cloud channel, OR revive a soft-deleted one that already holds the
   * same globally-unique key. `zernioAccountId` (and `evolutionInstanceName`)
   * are `@unique` across ALL rows, active or not, so a plain create after a
   * soft-delete would hit a raw P2002 → 500. Recreating a removed channel
   * should just bring it back. The controller still rejects a clash with an
   * ACTIVE channel (duplicate) before calling this.
   */
  async createOrReactivateCloudChannel(data: {
    provider: ChannelProvider;
    name: string;
    phoneE164?: string;
    twilioMessagingServiceSid?: string;
    zernioAccountId?: string;
    /** Quando o zernioAccountId foi conferido contra a API do Zernio (null = não foi). */
    zernioAccountVerifiedAt?: Date | null;
  }): Promise<Channel> {
    const softDeleted = data.zernioAccountId
      ? await this.prisma.channel.findFirst({
          where: { zernioAccountId: data.zernioAccountId, isActive: false },
        })
      : data.phoneE164
        ? await this.prisma.channel.findFirst({
            where: {
              provider: data.provider,
              phoneE164: data.phoneE164,
              isActive: false,
            },
          })
        : null;
    if (softDeleted) {
      return this.prisma.channel.update({
        where: { id: softDeleted.id },
        data: {
          isActive: true,
          name: data.name,
          phoneE164: data.phoneE164 ?? null,
          twilioMessagingServiceSid: data.twilioMessagingServiceSid ?? null,
          zernioAccountId: data.zernioAccountId ?? null,
          zernioAccountVerifiedAt: data.zernioAccountVerifiedAt ?? null,
        },
      });
    }
    return this.createCloudChannel(data);
  }

  /**
   * T9: app-level duplicate guard for POST /whatsapp/channels. There is no
   * DB-level unique constraint on provider+phoneE164 (phoneE164 is nullable
   * and intentionally shared across providers), so the controller calls this
   * right before createCloudChannel to refuse a second ACTIVE channel with
   * the same provider+phone — otherwise a campaign's delivery could silently
   * split across two rows for the same number.
   */
  findActiveByProviderAndPhone(
    provider: ChannelProvider,
    phoneE164: string,
  ): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: { provider, phoneE164, isActive: true },
    });
  }

  /**
   * Z3: same app-level duplicate guard as findActiveByProviderAndPhone, but
   * for ZERNIO's own account identifier. The `zernioAccountId` column is
   * `@unique` at the DB level, but that constraint applies globally
   * (including soft-deleted rows) — this scoped lookup lets the controller
   * surface a clean PT-BR DomainError for the ACTIVE-duplicate case before
   * ever hitting the DB constraint.
   */
  findActiveByZernioAccountId(zernioAccountId: string): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: { zernioAccountId, isActive: true },
    });
  }

  /**
   * T8 (inherited from T4 review): a system-wide "single default" empties the
   * router's per-provider fallback (findDefault(provider) above) — setting a
   * TWILIO channel as default used to also silently clear an existing
   * EVOLUTION default, and vice versa. The default is now scoped PER
   * PROVIDER: only channels sharing the target's provider get their
   * isDefault cleared before the target is set. A no-op when the target id
   * doesn't exist (defensive — the service layer already validates existence
   * via findById before calling this).
   */
  async setDefault(id: string): Promise<void> {
    const target = await this.prisma.channel.findUnique({
      where: { id },
      select: { provider: true },
    });
    if (!target) return;
    await this.prisma.$transaction([
      this.prisma.channel.updateMany({
        where: { isDefault: true, provider: target.provider },
        data: { isDefault: false },
      }),
      this.prisma.channel.update({
        where: { id },
        data: { isDefault: true },
      }),
    ]);
  }

  /**
   * Persist a WhatsappConnectionEvent (healing write). Used by the service's
   * list() live-state reconcile so the DB converges toward Evolution's truth;
   * occurredAt defaults to now() at the schema level.
   */
  async recordConnectionEvent(instanceId: string, state: string): Promise<void> {
    await this.prisma.whatsappConnectionEvent.create({
      data: { instanceId, state },
    });
  }

  /**
   * Persist the device WhatsApp profile (healing write). Used by the
   * service's list() reconcile when Evolution reports a phone/name/photo
   * that drifted from the stored row.
   */
  async updateDeviceProfile(
    id: string,
    data: {
      phoneE164: string | null;
      profileName: string | null;
      profilePictureUrl: string | null;
      /**
       * Set only when the number was (re)paired — resets the warm-up ramp.
       * Omitted on name/photo-only drift so a number keeps graduating.
       */
      warmupStartedAt?: Date;
    },
  ): Promise<void> {
    await this.prisma.channel.update({
      where: { id },
      data: {
        phoneE164: data.phoneE164,
        profileName: data.profileName,
        profilePictureUrl: data.profilePictureUrl,
        ...(data.warmupStartedAt ? { warmupStartedAt: data.warmupStartedAt } : {}),
      },
    });
  }

  softDelete(id: string): Promise<Channel> {
    return this.prisma.channel.update({
      where: { id },
      data: { isActive: false, isDefault: false },
    });
  }

  /**
   * As configurações do canal que o operador controla pela tela
   * (PATCH /whatsapp/channels/:id): ativar/desativar e o broadcast do Zernio.
   *
   * Escrita CRUA e parcial: quem decide o que pode ser gravado (e o que limpar
   * junto) é o controller, que é onde os guard-rails vivem. Em particular,
   * DESATIVAR precisa limpar o `isDefault` — `findDefault()` NÃO filtra
   * `isActive`, então um canal desativado que continuasse marcado como padrão
   * seguiria sendo eleito pelo roteador, e a desativação não teria servido para
   * nada. É a mesma limpeza que `softDelete` faz, pelo mesmo motivo.
   */
  updateSettings(
    id: string,
    data: Partial<
      Pick<
        Channel,
        'isActive' | 'isDefault' | 'zernioBroadcastEnabled' | 'zernioBroadcastChunk'
      >
    >,
  ): Promise<Channel> {
    return this.prisma.channel.update({ where: { id }, data });
  }

  incrementSentToday(id: string): Promise<Channel> {
    return this.prisma.channel.update({
      where: { id },
      data: { sentToday: { increment: 1 } },
    });
  }

  /**
   * Roll the daily counter over to a new 24h window — but ONLY if it hasn't been
   * rolled already. On the lock-free cloud path several workers cross the 24h
   * boundary together; a blind `SET sentToday=0` by the late one would wipe slot
   * reservations the winner already counted, letting the number overshoot its
   * WhatsApp tier cap. The conditional `WHERE sentTodayResetAt < olderThan`
   * makes it a compare-and-swap: the first worker resets, every stale one no-ops
   * (count 0). Callers re-read the row afterwards to get the true counter.
   */
  async resetSentToday(
    id: string,
    at: Date,
    olderThan: Date,
  ): Promise<number> {
    const result = await this.prisma.channel.updateMany({
      where: { id, sentTodayResetAt: { lt: olderThan } },
      data: { sentToday: 0, sentTodayResetAt: at },
    });
    return result.count;
  }

  /**
   * Atomically reserve one daily send slot: increment sentToday ONLY IF it is
   * still below `cap`. This is a single `UPDATE ... WHERE sentToday < cap` — a
   * row-level-locked, race-safe compare-and-increment — so N concurrent workers
   * reserving against a cap of N yield exactly N successes and the (N+1)th gets
   * `false`. Used on the cloud (Twilio/Meta) path INSTEAD of the Evolution
   * per-instance pacing lock: cloud providers need the daily-tier reservation
   * (so a 13k campaign spills over the tier cap into the next 24h window) but
   * not the one-send-at-a-time mutex.
   *
   * @returns true if a slot was reserved (proceed to send), false if the cap is
   * already reached (caller should defer the job to the next window).
   */
  async reserveSendSlot(id: string, cap: number): Promise<boolean> {
    const result = await this.prisma.channel.updateMany({
      where: { id, sentToday: { lt: cap } },
      data: { sentToday: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Release a previously-reserved slot (decrement sentToday, floored at 0).
   * Called when a reserved cloud send then FAILS to actually reach the provider
   * (classified/fatal error), so a doomed send does not permanently consume the
   * day's tier budget. Scoped to `sentToday > 0` so it can never go negative.
   */
  async releaseSendSlot(id: string): Promise<void> {
    await this.prisma.channel.updateMany({
      where: { id, sentToday: { gt: 0 } },
      data: { sentToday: { decrement: 1 } },
    });
  }
}
