import { describe, it, expect } from 'vitest';
import type { ChannelProvider } from '@prisma/client';
import {
  DISABLED_PROVIDER_ENV_KEYS,
  ENABLED_CHANNEL_PROVIDERS,
  ignoredProviderEnvKeys,
  ignoredProviderEnvMessage,
  isEnabledChannelProvider,
  skipsConnectionGate,
} from './enabled-providers';
import {
  ChannelProviderDisabledError,
  PROVIDER_DISABLED_CODE,
} from '../errors/channel-provider-disabled.error';

describe('ENABLED_CHANNEL_PROVIDERS', () => {
  it('é só EVOLUTION', () => {
    expect(ENABLED_CHANNEL_PROVIDERS).toEqual(['EVOLUTION']);
  });
});

describe('isEnabledChannelProvider', () => {
  it.each<[ChannelProvider, boolean]>([
    ['EVOLUTION', true],
    ['GOZAP', false],
    ['ZERNIO', false],
    ['TWILIO', false],
    ['META', false],
  ])('%s -> %s', (provider, expected) => {
    expect(isEnabledChannelProvider(provider)).toBe(expected);
  });
});

describe('skipsConnectionGate (D11)', () => {
  it.each<[ChannelProvider, boolean]>([
    ['EVOLUTION', false],
    ['GOZAP', true],
    ['ZERNIO', true],
    ['TWILIO', true],
    ['META', true],
  ])('%s -> %s', (provider, expected) => {
    expect(skipsConnectionGate(provider)).toBe(expected);
  });
});

describe('ignoredProviderEnvKeys', () => {
  it('lista só chaves desligadas com valor, na ordem fixa', () => {
    const env = {
      GOZAP_BASE_URL: 'https://x.gozap.dev',
      ZERNIO_API_KEY: '',
      EVOLUTION_API_KEY: 'evo-key',
    };
    expect(ignoredProviderEnvKeys(env)).toEqual(['GOZAP_BASE_URL']);
  });

  it('mantém a ordem de DISABLED_PROVIDER_ENV_KEYS, não a do objeto', () => {
    const env = { GOZAP_ADMIN_TOKEN: 'a', META_ACCESS_TOKEN: 'b' };
    expect(ignoredProviderEnvKeys(env)).toEqual([
      'META_ACCESS_TOKEN',
      'GOZAP_ADMIN_TOKEN',
    ]);
  });

  it('as 15 chaves que definem grupo, sem as com default', () => {
    expect(DISABLED_PROVIDER_ENV_KEYS).toHaveLength(15);
    expect(DISABLED_PROVIDER_ENV_KEYS).not.toContain('GOZAP_MAX_INSTANCES');
    expect(
      DISABLED_PROVIDER_ENV_KEYS.some((k) => k.startsWith('EVOLUTION')),
    ).toBe(false);
  });
});

describe('ignoredProviderEnvMessage', () => {
  it('não contém valores', () => {
    const env = Object.fromEntries(
      DISABLED_PROVIDER_ENV_KEYS.map((k) => [k, 'segredo-x']),
    );
    const message = ignoredProviderEnvMessage(ignoredProviderEnvKeys(env));
    expect(message).toContain('GOZAP_ADMIN_TOKEN');
    expect(message).not.toContain('segredo-x');
  });

  it('lista os nomes; sem chaves devolve null', () => {
    expect(ignoredProviderEnvMessage(['A', 'B'])).toBe(
      'chaves de provedores desligados ignoradas: A, B',
    );
    expect(ignoredProviderEnvMessage([])).toBeNull();
  });
});

describe('ChannelProviderDisabledError', () => {
  it('409 por padrão, 422 quando pedido, com o nome de exibição', () => {
    const error = new ChannelProviderDisabledError('GOZAP');
    expect(error.code).toBe(PROVIDER_DISABLED_CODE);
    expect(error.code).toBe('channel.provider_disabled');
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      'Este número usa uma integração desligada (GoZap).',
    );
    expect(error.detail).toBe('provider=GOZAP');
    expect(new ChannelProviderDisabledError('ZERNIO', 422).status).toBe(422);
  });
});
