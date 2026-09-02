import type { Channel, ChannelProvider } from '@prisma/client';
import type { MessageProvider } from './ports/message-provider.port';
import { DomainError } from '../../shared/errors/domain.error';

/**
 * Raised when code tries to resolve an adapter for a provider whose credential
 * group is not configured in the environment (e.g. a Twilio channel routed on a
 * deploy that only has the Evolution env group). PT-BR user-facing message.
 */
export class ProviderNotConfiguredError extends DomainError {
  constructor(provider: ChannelProvider) {
    super({
      code: 'channel.provider_not_configured',
      message: `O provedor ${provider} não está configurado neste ambiente`,
      status: 400,
      detail: `provider=${provider}`,
    });
  }
}

/**
 * Multi-provider adapter registry. Holds ONE adapter instance per configured
 * provider (the module factory only registers the providers whose env group is
 * complete — see `configuredProviderGroups` in env.schema + the module).
 *
 * This replaces the old single-`MESSAGE_PROVIDER`-per-boot model: callers now
 * resolve the adapter that matches a channel's `provider`, so one deploy can
 * serve Evolution, Twilio and Meta channels side by side.
 */
export class ProviderRegistry {
  constructor(
    private readonly adapters: ReadonlyMap<ChannelProvider, MessageProvider>,
  ) {}

  /**
   * Resolve the adapter for a channel by its `provider`. Throws a 400
   * DomainError (`channel.provider_not_configured`) when that provider's env
   * group is not configured on this deploy.
   */
  forChannel(ch: Pick<Channel, 'provider'>): MessageProvider {
    const adapter = this.adapters.get(ch.provider);
    if (!adapter) {
      throw new ProviderNotConfiguredError(ch.provider);
    }
    return adapter;
  }

  /** Resolve an adapter by provider, or `null` when it isn't configured. */
  forProvider(provider: ChannelProvider): MessageProvider | null {
    return this.adapters.get(provider) ?? null;
  }

  /** The providers that have a configured adapter, in insertion order. */
  configured(): ChannelProvider[] {
    return [...this.adapters.keys()];
  }

  /** Whether a given provider has a configured adapter. */
  isConfigured(provider: ChannelProvider): boolean {
    return this.adapters.has(provider);
  }
}
