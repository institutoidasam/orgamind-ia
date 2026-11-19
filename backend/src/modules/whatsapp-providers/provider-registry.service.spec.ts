import { describe, it, expect } from 'vitest';
import type { ChannelProvider } from '@prisma/client';
import type { MessageProvider } from './ports/message-provider.port';
import {
  ProviderRegistry,
  ProviderNotConfiguredError,
} from './provider-registry.service';
import { ChannelProviderDisabledError } from '../../shared/errors/channel-provider-disabled.error';
import { DomainError } from '../../shared/errors/domain.error';

/** A bare adapter stub — only `name` matters for identity in these tests. */
function adapter(name: MessageProvider['name']): MessageProvider {
  return { name } as unknown as MessageProvider;
}

function registryOf(
  entries: Partial<Record<ChannelProvider, MessageProvider>>,
): ProviderRegistry {
  const map = new Map<ChannelProvider, MessageProvider>();
  for (const [k, v] of Object.entries(entries)) {
    if (v) map.set(k as ChannelProvider, v);
  }
  return new ProviderRegistry(map);
}

const DISABLED_PROVIDERS = ['GOZAP', 'ZERNIO', 'TWILIO', 'META'] as const;

const evo = adapter('evolution');

describe('ProviderRegistry — registry de produção (só o adapter Evolution no mapa)', () => {
  const reg = registryOf({ EVOLUTION: evo });

  it('forChannel(EVOLUTION) devolve o adapter', () => {
    expect(reg.forChannel({ provider: 'EVOLUTION' })).toBe(evo);
  });

  it.each(DISABLED_PROVIDERS)(
    'forChannel(%s) lança ChannelProviderDisabledError 409',
    (provider) => {
      expect(() => reg.forChannel({ provider })).toThrow(
        ChannelProviderDisabledError,
      );
      try {
        reg.forChannel({ provider });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        const de = err as DomainError;
        expect(de.code).toBe('channel.provider_disabled');
        expect(de.status).toBe(409);
      }
    },
  );

  it('forProvider devolve o adapter ligado e null para os desligados', () => {
    expect(reg.forProvider('EVOLUTION')).toBe(evo);
    for (const provider of DISABLED_PROVIDERS) {
      expect(reg.forProvider(provider)).toBeNull();
    }
  });

  it('isConfigured só vale para a Evolution', () => {
    expect(reg.isConfigured('EVOLUTION')).toBe(true);
    for (const provider of DISABLED_PROVIDERS) {
      expect(reg.isConfigured(provider)).toBe(false);
    }
  });

  it('configured() lista só a Evolution', () => {
    expect(reg.configured()).toEqual(['EVOLUTION']);
  });
});

// Defesa em profundidade: mesmo que um adapter de provedor desligado chegue
// ao mapa, o registry não o entrega (a decisão é de ENABLED_CHANNEL_PROVIDERS).
describe('ProviderRegistry — adapter de provedor desligado no mapa não vaza', () => {
  const reg = registryOf({
    EVOLUTION: evo,
    GOZAP: adapter('gozap'),
    TWILIO: adapter('twilio'),
  });

  it('forChannel, forProvider e configured ignoram o adapter desligado', () => {
    expect(() => reg.forChannel({ provider: 'GOZAP' })).toThrow(
      ChannelProviderDisabledError,
    );
    expect(reg.forProvider('TWILIO')).toBeNull();
    expect(reg.configured()).toEqual(['EVOLUTION']);
  });
});

describe('ProviderRegistry — Evolution ligada, mas sem adapter no mapa', () => {
  const reg = registryOf({});

  it('forChannel(EVOLUTION) lança ProviderNotConfiguredError 400', () => {
    expect(() => reg.forChannel({ provider: 'EVOLUTION' })).toThrow(
      ProviderNotConfiguredError,
    );
    try {
      reg.forChannel({ provider: 'EVOLUTION' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const de = err as DomainError;
      expect(de.code).toBe('channel.provider_not_configured');
      expect(de.status).toBe(400);
      expect(de.message).toMatch(/não está configurad/i);
    }
  });

  it('forProvider é null e configured é vazio', () => {
    expect(reg.forProvider('EVOLUTION')).toBeNull();
    expect(reg.configured()).toEqual([]);
  });
});
