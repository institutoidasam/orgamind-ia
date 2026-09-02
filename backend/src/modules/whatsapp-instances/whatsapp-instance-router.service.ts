import { Injectable } from '@nestjs/common';
import type { Channel } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { DomainError } from '../../shared/errors/domain.error';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';

export type RouterResult =
  | { kind: 'send'; instance: Channel }
  | { kind: 'waiting'; instanceId: string };

@Injectable()
export class WhatsappInstanceRouter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: WhatsappInstancesRepository,
  ) {}

  async resolveForSend(args: {
    contactId: string;
    campaignDefaultInstanceId: string;
  }): Promise<RouterResult> {
    // T4: resolve the campaign's configured channel FIRST. Its `provider`
    // scopes both the stickiness lookup below and the system-default fallback
    // further down, so a contact never sticks to (or silently falls back onto)
    // a channel that talks over a DIFFERENT provider than the one this
    // campaign is configured to send with.
    const campaignDefault = await this.repo.findById(
      args.campaignDefaultInstanceId,
    );

    const lastSent = await this.prisma.message.findFirst({
      where: {
        contactId: args.contactId,
        sentAt: { not: null },
        instance: { provider: campaignDefault?.provider },
      },
      orderBy: { sentAt: 'desc' },
      select: { instanceId: true },
    });

    const stickyId = lastSent?.instanceId ?? args.campaignDefaultInstanceId;
    // Dedupe: when the sticky reference IS the campaign default, reuse the row
    // we already fetched above instead of querying the same id twice.
    const sticky =
      stickyId === args.campaignDefaultInstanceId
        ? campaignDefault
        : await this.repo.findById(stickyId);

    if (!sticky || !sticky.isActive) {
      const fallback = campaignDefault;
      if (!fallback || !fallback.isActive) {
        // U3: the campaign's pinned instance is gone/soft-deleted. Before
        // failing, try the system default — scoped to the SAME provider as the
        // campaign's channel, so e.g. a Twilio campaign is never silently
        // rerouted through an Evolution number — so old campaigns stay
        // sendable. findDefault() does NOT filter isActive, so guard it here.
        const sysDefault = await this.repo.findDefault(
          campaignDefault?.provider,
        );
        if (sysDefault?.isActive) {
          const sysOnline = await this.isInstanceOnline(sysDefault);
          if (!sysOnline) return { kind: 'waiting', instanceId: sysDefault.id };
          return { kind: 'send', instance: sysDefault };
        }
        if (!fallback) {
          throw new DomainError({
            code: 'campaign.default_instance_missing',
            message:
              'A conexão desta campanha não existe mais e não há outra conexão padrão ativa. Conecte um número, defina-o como padrão e reenvie.',
            status: 400,
          });
        }
        throw new DomainError({
          code: 'campaign.default_instance_inactive',
          message:
            'A conexão desta campanha foi removida e não há outra conexão padrão ativa. Conecte um número, defina-o como padrão e reenvie.',
          status: 400,
        });
      }
      const fallbackOnline = await this.isInstanceOnline(fallback);
      if (!fallbackOnline) return { kind: 'waiting', instanceId: fallback.id };
      return { kind: 'send', instance: fallback };
    }

    const online = await this.isInstanceOnline(sticky);
    if (!online) return { kind: 'waiting', instanceId: sticky.id };

    return { kind: 'send', instance: sticky };
  }

  /**
   * T4: decided purely from the CHANNEL ROW's own `provider` — never from a
   * global env/config flag. The previous implementation gated every channel by
   * the process-wide WHATSAPP_PROVIDER env var, which is a latent bug in a
   * multi-provider deployment (an Evolution channel would be treated as
   * always-online if the env happened to say "twilio", and vice-versa).
   *
   * Anti-ban (Evolution-only): the connection-state gate exists to avoid
   * banning unofficial numbers. Twilio/Zernio/Meta are official Cloud APIs
   * with no WhatsappConnectionEvent rows, so treat them as always reachable —
   * else every send would park WAITING_INSTANCE forever. Callers already have
   * the channel row in hand, so this never re-queries it.
   */
  private async isInstanceOnline(instance: Channel): Promise<boolean> {
    if (!isSessionProvider(instance.provider)) {
      return true;
    }
    const last = await this.prisma.whatsappConnectionEvent.findFirst({
      where: { instanceId: instance.id },
      orderBy: { occurredAt: 'desc' },
    });
    return last?.state === 'open';
  }
}
