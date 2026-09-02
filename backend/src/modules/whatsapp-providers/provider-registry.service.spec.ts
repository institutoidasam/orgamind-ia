import { describe, it, expect } from 'vitest';
import type { ChannelProvider } from '@prisma/client';
import type { MessageProvider } from './ports/message-provider.port';
import {
  ProviderRegistry,
  ProviderNotConfiguredError,
} from './provider-registry.service';
import { DomainError } from '../../shared/errors/domain.error';
import { configuredProviderGroups } from '../../shared/config/env.schema';

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

describe('ProviderRegistry', () => {
  const evo = adapter('evolution');
  const twilio = adapter('twilio');
  const meta = adapter('meta');
  const zernio = adapter('zernio' as MessageProvider['name']);

  describe('full env — all three groups configured', () => {
    const reg = registryOf({ EVOLUTION: evo, TWILIO: twilio, META: meta });

    it('forProvider returns the exact adapter for each provider', () => {
      expect(reg.forProvider('EVOLUTION')).toBe(evo);
      expect(reg.forProvider('TWILIO')).toBe(twilio);
      expect(reg.forProvider('META')).toBe(meta);
    });

    it('isConfigured is true for configured providers', () => {
      expect(reg.isConfigured('EVOLUTION')).toBe(true);
      expect(reg.isConfigured('TWILIO')).toBe(true);
      expect(reg.isConfigured('META')).toBe(true);
    });

    it('configured lists every registered provider', () => {
      expect(reg.configured().sort()).toEqual(['EVOLUTION', 'META', 'TWILIO']);
    });

    it('forChannel routes by the channel provider', () => {
      expect(reg.forChannel({ provider: 'TWILIO' })).toBe(twilio);
      expect(reg.forChannel({ provider: 'EVOLUTION' })).toBe(evo);
    });
  });

  // Z3: ZERNIO is just another ChannelProvider key to this generic
  // Map-backed registry — no ZERNIO-specific branching lives here (that's the
  // module factory's job, see whatsapp-providers.module.ts). These tests lock
  // in that the registry needs no changes to support a 4th provider.
  describe('all four groups configured (adds ZERNIO)', () => {
    const reg = registryOf({
      EVOLUTION: evo,
      TWILIO: twilio,
      META: meta,
      ZERNIO: zernio,
    });

    it('forProvider returns the Zernio adapter', () => {
      expect(reg.forProvider('ZERNIO')).toBe(zernio);
    });

    it('isConfigured is true for ZERNIO', () => {
      expect(reg.isConfigured('ZERNIO')).toBe(true);
    });

    it('configured includes ZERNIO alongside the others', () => {
      expect(reg.configured().sort()).toEqual([
        'EVOLUTION',
        'META',
        'TWILIO',
        'ZERNIO',
      ]);
    });

    it('forChannel routes a ZERNIO channel to the Zernio adapter', () => {
      expect(reg.forChannel({ provider: 'ZERNIO' })).toBe(zernio);
    });
  });

  // F-A Task 3: GOZAP is the 5th provider. Same story as Z3 above — the
  // registry has no GOZAP-specific branching, only the module factory
  // (whatsapp-providers.module.ts) decides WHETHER to put it in the map.
  describe('all five groups configured (adds GOZAP)', () => {
    const gozap = adapter('gozap' as MessageProvider['name']);
    const reg = registryOf({
      EVOLUTION: evo,
      TWILIO: twilio,
      META: meta,
      ZERNIO: zernio,
      GOZAP: gozap,
    });

    it('forProvider returns the GoZap adapter', () => {
      expect(reg.forProvider('GOZAP')).toBe(gozap);
    });

    it('isConfigured is true for GOZAP', () => {
      expect(reg.isConfigured('GOZAP')).toBe(true);
    });

    it('configured includes GOZAP alongside the others', () => {
      expect(reg.configured().sort()).toEqual([
        'EVOLUTION',
        'GOZAP',
        'META',
        'TWILIO',
        'ZERNIO',
      ]);
    });

    it('forChannel routes a GOZAP channel to the GoZap adapter', () => {
      expect(reg.forChannel({ provider: 'GOZAP' })).toBe(gozap);
    });
  });

  // ★ Inertia proof, end to end: this simulates EXACTLY what the module
  // factory (whatsapp-providers.module.ts) does —
  // `if (configured.has('gozap')) map.set('GOZAP', gozap)` — by driving the
  // registry's construction off the REAL `configuredProviderGroups` output
  // instead of a hand-built map. This is what proves the wiring itself (not
  // just the generic Map lookup) stays inert without the env group.
  describe('module wiring simulation — GOZAP gated by configuredProviderGroups', () => {
    const gozap = adapter('gozap' as MessageProvider['name']);

    function buildRegistry(env: Record<string, unknown>): ProviderRegistry {
      const configured = new Set(configuredProviderGroups(env));
      const map = new Map<ChannelProvider, MessageProvider>();
      if (configured.has('gozap')) map.set('GOZAP', gozap);
      return new ProviderRegistry(map);
    }

    it('without any GOZAP_* var, the registry does NOT resolve GOZAP (deploy stays inert)', () => {
      const reg = buildRegistry({});
      expect(reg.forProvider('GOZAP')).toBeNull();
      expect(reg.isConfigured('GOZAP')).toBe(false);
    });

    it('with a PARTIAL GOZAP group (one of the four vars), the registry still does NOT resolve GOZAP', () => {
      const reg = buildRegistry({ GOZAP_ADMIN_TOKEN: 't' });
      expect(reg.forProvider('GOZAP')).toBeNull();
    });

    it('with the FULL GOZAP group, the registry resolves the adapter', () => {
      const reg = buildRegistry({
        GOZAP_BASE_URL: 'https://tenant.gozap.dev',
        GOZAP_ADMIN_TOKEN: 't',
        GOZAP_WEBHOOK_TOKEN: 'w',
        GOZAP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      });
      expect(reg.forProvider('GOZAP')).toBe(gozap);
      expect(reg.isConfigured('GOZAP')).toBe(true);
    });
  });

  describe('partial env — only Evolution configured', () => {
    const reg = registryOf({ EVOLUTION: evo });

    it('forProvider returns null for the unconfigured providers', () => {
      expect(reg.forProvider('EVOLUTION')).toBe(evo);
      expect(reg.forProvider('TWILIO')).toBeNull();
      expect(reg.forProvider('META')).toBeNull();
      expect(reg.forProvider('ZERNIO')).toBeNull();
    });

    it('isConfigured reflects only what is configured', () => {
      expect(reg.isConfigured('EVOLUTION')).toBe(true);
      expect(reg.isConfigured('TWILIO')).toBe(false);
    });

    it('configured lists only Evolution', () => {
      expect(reg.configured()).toEqual(['EVOLUTION']);
    });

    it('forChannel throws ProviderNotConfiguredError for an unconfigured channel', () => {
      expect(() => reg.forChannel({ provider: 'TWILIO' })).toThrow(
        ProviderNotConfiguredError,
      );
    });

    it('the thrown error is a 400 DomainError with the contract code', () => {
      try {
        reg.forChannel({ provider: 'META' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        const de = err as DomainError;
        expect(de.code).toBe('channel.provider_not_configured');
        expect(de.status).toBe(400);
        // PT-BR user-facing message.
        expect(de.message).toMatch(/não está configurad/i);
      }
    });
  });

  describe('empty env — no group configured', () => {
    const reg = registryOf({});

    it('forProvider is null for everything', () => {
      expect(reg.forProvider('EVOLUTION')).toBeNull();
      expect(reg.forProvider('TWILIO')).toBeNull();
      expect(reg.forProvider('GOZAP')).toBeNull();
    });

    it('configured is empty', () => {
      expect(reg.configured()).toEqual([]);
    });

    it('forChannel always throws', () => {
      expect(() => reg.forChannel({ provider: 'EVOLUTION' })).toThrow(
        ProviderNotConfiguredError,
      );
    });
  });
});
