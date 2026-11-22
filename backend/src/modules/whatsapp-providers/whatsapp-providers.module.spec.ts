import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { VALIDATED_ENV_PROPNAME } from '@nestjs/config/dist/config.constants';
import { Logger } from '@nestjs/common';
import { PROCESSOR_METADATA } from '@nestjs/bullmq/dist/bull.constants';
import {
  WhatsappProvidersModule,
  registryProvider,
  legacyProvider,
} from './whatsapp-providers.module';
import { WhatsappProvidersController } from './whatsapp-providers.controller';
import { ZernioBroadcastSyncController } from './zernio-broadcast-sync.controller';
import { GozapConnectionReconcilerProcessor } from './gozap-connection-reconciler.processor';
import { TwilioTierSyncProcessor } from './twilio-tier-sync.processor';
import { ZernioBroadcastSyncProcessor } from './zernio-broadcast-sync.processor';
import { EvolutionApiAdapter } from './adapters/evolution-api.adapter';
import { validateEnv, type Env } from '../../shared/config/env.schema';

const evolution = { name: 'evolution' } as unknown as EvolutionApiAdapter;

const EVOLUTION_ENV = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  JWT_SECRET: 'a'.repeat(32),
  APP_BASE_URL: 'http://localhost:5173',
  WEBHOOK_BASE_URL: 'http://localhost:3000',
  CORS_ORIGIN: 'http://localhost:5173',
  EVOLUTION_BASE_URL: 'http://localhost:8080',
  EVOLUTION_API_KEY: 'evolution-key',
  EVOLUTION_INSTANCE_NAME: 'picoa-dev',
};

/** ConfigService stub que devolve só o que o teste informa. */
function configOf(values: Record<string, unknown>): ConfigService<Env> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env>;
}

/** Espia o Logger.warn sem poluir a saída do teste. */
function spyWarn() {
  return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
}

/** Config com GOZAP e EVOLUTION completos: o aviso não pode vazar nenhum valor. */
const GOZAP_AND_EVOLUTION_CONFIG = {
  EVOLUTION_BASE_URL: 'https://evo.internal',
  EVOLUTION_API_KEY: 'evo-secret-key',
  EVOLUTION_INSTANCE_NAME: 'picoa',
  GOZAP_BASE_URL: 'https://tenant.gozap.dev',
  GOZAP_ADMIN_TOKEN: 'gozap-admin-secret',
  GOZAP_WEBHOOK_TOKEN: 'gozap-webhook-secret',
  GOZAP_TOKEN_ENCRYPTION_KEY: 'k'.repeat(64),
};

const VALUES_THAT_MUST_NOT_LEAK = [
  'tenant.gozap.dev',
  'gozap-admin-secret',
  'gozap-webhook-secret',
  'k'.repeat(64),
  'evo-secret-key',
];

describe('WhatsappProvidersModule — só a Evolution: registryProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('env com GOZAP e EVOLUTION completos: registry.configured() é [EVOLUTION] e o warn sai uma vez com GOZAP_BASE_URL, sem valores', () => {
    const warn = spyWarn();
    const config = configOf(GOZAP_AND_EVOLUTION_CONFIG);

    const registry = registryProvider.useFactory(config, evolution);

    expect(registry.configured()).toEqual(['EVOLUTION']);
    expect(registry.forChannel({ provider: 'EVOLUTION' })).toBe(evolution);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg] = warn.mock.calls[0] as [string];
    expect(msg).toContain('GOZAP_BASE_URL');
    for (const secret of VALUES_THAT_MUST_NOT_LEAK) {
      expect(msg).not.toContain(secret);
    }
  });

  // O ConfigModule grava os defaults validados do envSchema em `process.env`,
  // então `ZERNIO_BASE_URL` chega preenchida mesmo sem o operador tocar nela.
  it('env só com Evolution (ZERNIO_BASE_URL no default do schema): nenhum aviso', () => {
    const warn = spyWarn();
    const validated = validateEnv(EVOLUTION_ENV);
    const config = new ConfigService<Env>({
      [VALIDATED_ENV_PROPNAME]: validated,
    });

    const registry = registryProvider.useFactory(config, evolution);

    expect(validated.ZERNIO_BASE_URL).toBeTruthy();
    expect(registry.configured()).toEqual(['EVOLUTION']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvidersModule — só a Evolution: módulo', () => {
  it('MESSAGE_PROVIDER é o EvolutionApiAdapter', () => {
    expect(legacyProvider.inject).toEqual([EvolutionApiAdapter]);
    expect(legacyProvider.useFactory(evolution)).toBe(evolution);
  });

  it('módulo não registra processors nem controller dos desligados', () => {
    const providers = Reflect.getMetadata(
      'providers',
      WhatsappProvidersModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      'controllers',
      WhatsappProvidersModule,
    ) as unknown[];

    expect(controllers).toEqual([WhatsappProvidersController]);
    expect(controllers).not.toContain(ZernioBroadcastSyncController);
    for (const removed of [
      GozapConnectionReconcilerProcessor,
      TwilioTierSyncProcessor,
      ZernioBroadcastSyncProcessor,
    ]) {
      expect(providers).not.toContain(removed);
    }
    // R8: nenhum provider do módulo é um @Processor do BullMQ.
    const processors = providers.filter(
      (p) =>
        typeof p === 'function' &&
        Reflect.getMetadata(PROCESSOR_METADATA, p) !== undefined,
    );
    expect(processors).toEqual([]);
  });
});
