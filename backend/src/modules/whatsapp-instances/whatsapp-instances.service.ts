import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Channel } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { warmupInfo } from './warmup.helper';
import { ChannelNotEvolutionError } from '../../shared/errors/domain.error';

// A5: read responses never expose the per-instance Evolution apiKey. be-gozap:
// nor the (encrypted-at-rest) GoZap instance token — same rationale, kept in
// lockstep with the repository's own SafeWhatsappInstance / omit clauses.
type SafeWhatsappInstance = Omit<Channel, 'apiKey' | 'gozapInstanceToken'>;
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import {
  InstanceCreationFailedError,
  InstanceNameConflictError,
  InstanceNotFoundError,
} from './errors/instance.errors';

export interface EvolutionAdminClient {
  createInstance(args: { instanceName: string }): Promise<{ apiKey: string }>;
  logout(instanceName: string): Promise<void>;
  restart(instanceName: string): Promise<void>;
}

export const EVOLUTION_ADMIN_CLIENT = 'EVOLUTION_ADMIN_CLIENT';

@Injectable()
export class WhatsappInstancesService {
  private readonly logger = new Logger(WhatsappInstancesService.name);

  constructor(
    private readonly repo: WhatsappInstancesRepository,
    @Inject(EVOLUTION_ADMIN_CLIENT) private readonly evo: EvolutionAdminClient,
    private readonly prisma: PrismaService,
    // Direct adapter injection, mirroring the controller: the adapter is
    // already a provider in this module, which avoids the circular dep with
    // WhatsappProvidersModule. Used only for the read-only live-state fetch.
    private readonly evolution: EvolutionApiAdapter,
    private readonly audit: AuditService,
  ) {}

  /**
   * List instances with their connection state AND device profile reconciled
   * against Evolution.
   *
   * Prod incident: `lastConnectionState` comes from the newest stored
   * WhatsappConnectionEvent, which drifts when webhooks are missed — the UI
   * showed "conectado" (frozen days-old 'open') while Evolution reported
   * 'close'. For every ACTIVE row whose live Evolution state differs from the
   * stored one we return the live value and persist a healing event so the DB
   * converges. Healing-write failures never break the list response.
   *
   * U1: Evolution's fetchInstances also reports the device WhatsApp profile
   * (ownerJid → phone, profileName, profilePicUrl), but nothing ever wrote
   * it — the UI showed "—" forever and device renames never propagated. When
   * ownerJid is present (never on missing data, so a disconnected instance
   * can't blank stored fields) and any field drifted, persist the fresh
   * profile and serve it immediately.
   */
  async list(opts: { activeOnly: boolean }): Promise<Array<SafeWhatsappInstance & { lastConnectionState: string | null }>> {
    const rows = await (opts.activeOnly ? this.repo.listActiveWithState() : this.repo.listAllWithState());
    const now = new Date();
    // Never throws — an unreachable Evolution yields an empty map and the
    // DB-stored state is served as-is.
    const liveStates = await this.evolution.listConnectionStates();
    if (liveStates.size === 0) return rows.map((r) => this.attachWarmup(r, now));

    return Promise.all(
      rows.map(async (row) => {
        if (!row.isActive) return this.attachWarmup(row, now); // soft-deleted: nothing to reconcile
        // Non-Evolution channels (Twilio/Zernio/Meta) have no Evolution live
        // connection state to reconcile against — serve the stored row as-is.
        if (!row.evolutionInstanceName) return this.attachWarmup(row, now);
        const live = liveStates.get(row.evolutionInstanceName);
        if (live === undefined) return this.attachWarmup(row, now);

        let out = row;

        if (live.state !== row.lastConnectionState) {
          try {
            await this.repo.recordConnectionEvent(row.id, live.state);
          } catch (err) {
            this.logger.warn(
              `healing connection-event write failed for instance=${row.id} (state=${live.state}); serving live state anyway: ${(err as Error).message}`,
            );
          }
          out = { ...out, lastConnectionState: live.state };
        }

        if (live.ownerJid) {
          const phoneE164 = `+${live.ownerJid.split('@')[0]}`;
          // Null live name/photo means "unknown" (e.g. a closing session still
          // reports ownerJid) — preserve stored values, never blank them.
          const profileName = live.profileName ?? row.profileName;
          const profilePictureUrl = live.profilePicUrl ?? row.profilePictureUrl;
          // A changed phone number = a (re)pairing → restart the warm-up ramp.
          // A name/photo-only drift must NOT reset warm-up (the number would
          // never graduate).
          const numberChanged = phoneE164 !== row.phoneE164;
          if (
            numberChanged ||
            profileName !== row.profileName ||
            profilePictureUrl !== row.profilePictureUrl
          ) {
            const warmupStartedAt = numberChanged ? now : undefined;
            const profile = { phoneE164, profileName, profilePictureUrl };
            try {
              await this.repo.updateDeviceProfile(row.id, { ...profile, warmupStartedAt });
            } catch (err) {
              this.logger.warn(
                `healing device-profile write failed for instance=${row.id}; serving live profile anyway: ${(err as Error).message}`,
              );
            }
            out = { ...out, ...profile, ...(warmupStartedAt ? { warmupStartedAt } : {}) };
          }
        }

        return this.attachWarmup(out, now);
      }),
    );
  }

  /**
   * Attach the computed warm-up fields (effective cap, day, warming flag) that
   * the frontend quota panel reads. Single source of truth = warmup.helper.
   */
  private attachWarmup<T extends { warmupStartedAt: Date | null; dailySendLimit: number }>(
    row: T,
    now: Date,
  ): T & { warmupEffectiveCap: number; warming: boolean; warmupDay: number } {
    const info = warmupInfo(row.warmupStartedAt, now, row.dailySendLimit);
    return {
      ...row,
      warmupEffectiveCap: info.effectiveCap,
      warming: info.warming,
      warmupDay: info.day,
    };
  }

  async findById(id: string): Promise<SafeWhatsappInstance & { lastConnectionState: string | null }> {
    const inst = await this.repo.findByIdWithState(id);
    if (!inst) throw new InstanceNotFoundError(id);
    return this.attachWarmup(inst, new Date());
  }

  async create(input: {
    name: string;
    ownerUserId?: string | null;
    isDefault?: boolean;
  }): Promise<SafeWhatsappInstance> {
    const evolutionInstanceName = this.slugify(input.name);
    const existing = await this.repo.findByEvolutionName(evolutionInstanceName);
    if (existing) throw new InstanceNameConflictError(evolutionInstanceName);

    try {
      await this.evo.createInstance({ instanceName: evolutionInstanceName });
    } catch (err) {
      throw new InstanceCreationFailedError((err as Error).message);
    }

    // be-whatsapp-003: never persist a real per-instance Evolution apiKey. All
    // sends authenticate with the global EVOLUTION_API_KEY, so the per-instance
    // key is dead — storing it is pure attack surface (and A5 already omits it
    // from responses). We discard whatever the admin client returns and store
    // an empty string. The column stays non-null without holding a secret.
    const inst = await this.repo.create({
      name: input.name,
      evolutionInstanceName,
      apiKey: '',
      ownerUserId: input.ownerUserId ?? null,
    });

    // F6: instance lifecycle is audited (AuditService swallows its own errors).
    await this.audit.log('instance.create', 'WhatsappInstance', inst.id, {
      name: inst.name,
      evolutionInstanceName: inst.evolutionInstanceName,
    });

    if (input.isDefault) {
      await this.repo.setDefault(inst.id);
      return this.findById(inst.id);
    }
    // A5 / be-gozap: never return the per-instance Evolution apiKey (this row
    // never has a GOZAP token either, but stripped for type-consistency with
    // SafeWhatsappInstance and defense in depth).
    const { apiKey: _apiKey, gozapInstanceToken: _gzToken, ...safe } = inst;
    return safe;
  }

  async setDefault(id: string): Promise<void> {
    const inst = await this.repo.findById(id);
    if (!inst || !inst.isActive) throw new InstanceNotFoundError(id);
    await this.repo.setDefault(id);
    await this.audit.log('instance.set_default', 'WhatsappInstance', id, {
      name: inst.name,
      evolutionInstanceName: inst.evolutionInstanceName,
    });
  }

  async delete(id: string): Promise<void> {
    const inst = await this.repo.findById(id);
    if (!inst) throw new InstanceNotFoundError(id);
    // be-whatsapp: Evolution logout is best-effort cleanup. A failed logout
    // (instance already gone, Evolution down, 400, or a Meta deploy with a
    // no-op admin client) must NOT abort the soft-delete — otherwise the
    // instance stays visible/active to operators. Mirror restart()'s
    // log-and-continue behavior. Non-Evolution channels have nothing to log
    // out of — skip the call entirely.
    if (inst.evolutionInstanceName) {
      try {
        await this.evo.logout(inst.evolutionInstanceName);
      } catch (err) {
        this.logger.warn(
          `evolution logout failed for instance=${id} (${inst.evolutionInstanceName}); continuing soft-delete: ${(err as Error).message}`,
        );
      }
    }
    await this.repo.softDelete(id);
    await this.audit.log('instance.delete', 'WhatsappInstance', id, {
      name: inst.name,
      evolutionInstanceName: inst.evolutionInstanceName,
    });
    // Fail orphaned WAITING_INSTANCE messages — they have no recovery path
    // because the instance will never reconnect.
    await this.prisma.message.updateMany({
      where: { instanceId: id, status: 'WAITING_INSTANCE' },
      data: {
        status: 'FAILED',
        errorCode: 'antiban.instance_deleted',
        errorMessage: 'Instância removida enquanto havia mensagens aguardando reconexão',
      },
    });
  }

  async restart(id: string): Promise<void> {
    const inst = await this.findById(id);
    if (!inst.evolutionInstanceName) throw new ChannelNotEvolutionError(id);
    await this.evo.restart(inst.evolutionInstanceName);
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036F]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `picoa-${base || 'inst'}-${suffix}`;
  }
}
