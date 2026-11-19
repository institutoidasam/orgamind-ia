import type { Channel, ChannelProvider } from '@prisma/client';
import type { MessageProvider } from './ports/message-provider.port';
import { DomainError } from '../../shared/errors/domain.error';
import { ChannelProviderDisabledError } from '../../shared/errors/channel-provider-disabled.error';
import { isEnabledChannelProvider } from '../../shared/config/enabled-providers';

/**
 * Raised when code tries to resolve an adapter for an ENABLED provider that has
 * no adapter in the registry. (Provider desligado lança
 * `ChannelProviderDisabledError`, não este.) PT-BR user-facing message.
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
 * Adapter registry. Só a Evolution está ligada (`ENABLED_CHANNEL_PROVIDERS`):
 * a fábrica do módulo registra apenas o adapter dela e, por defesa em
 * profundidade, o registry também nunca entrega adapter de provedor desligado,
 * mesmo que algum chegue ao mapa.
 *
 * Quem resolve o adapter pelo `provider` do canal usa `forChannel`; canal de
 * provedor desligado lança `ChannelProviderDisabledError` (409), o que cobre
 * todo envio síncrono (D2).
 */
export class ProviderRegistry {
  constructor(
    private readonly adapters: ReadonlyMap<ChannelProvider, MessageProvider>,
  ) {}

  /**
   * Resolve the adapter for a channel by its `provider`. Throws a 409
   * `ChannelProviderDisabledError` (`channel.provider_disabled`) for a disabled
   * provider, and a 400 `ProviderNotConfiguredError` when the provider is
   * enabled but has no adapter in this registry.
   */
  forChannel(ch: Pick<Channel, 'provider'>): MessageProvider {
    if (!isEnabledChannelProvider(ch.provider)) {
      throw new ChannelProviderDisabledError(ch.provider);
    }
    const adapter = this.adapters.get(ch.provider);
    if (!adapter) {
      throw new ProviderNotConfiguredError(ch.provider);
    }
    return adapter;
  }

  /** Resolve an adapter by provider, or `null` when disabled / not configured. */
  forProvider(provider: ChannelProvider): MessageProvider | null {
    if (!isEnabledChannelProvider(provider)) return null;
    return this.adapters.get(provider) ?? null;
  }

  /** The enabled providers that have an adapter, in insertion order. */
  configured(): ChannelProvider[] {
    return [...this.adapters.keys()].filter(isEnabledChannelProvider);
  }

  /** Whether a given provider is enabled and has an adapter. */
  isConfigured(provider: ChannelProvider): boolean {
    return this.forProvider(provider) !== null;
  }
}
