import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosInstance } from 'axios';
import type { ConfigService } from '@nestjs/config';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { Env } from '../../../shared/config/env.schema';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import { EVOLUTION_WEBHOOK_EVENTS } from './evolution-webhook-config';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

/** Same digest pinned in docker-compose.{dev,prod}.yml (Evolution 2.3.7). */
const EVOLUTION_IMAGE =
  'evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252';
const API_KEY = 'it-key';
const WEBHOOK_URL = 'https://orgamind.example.com/webhooks/whatsapp';
const INSTANCE = 'it-1';

let network: StartedNetwork;
let postgres: StartedPostgreSqlContainer;
let evolution: StartedTestContainer;
let adapter: EvolutionApiAdapter;
let raw: AxiosInstance;

function configStub(baseUrl: string): ConfigService<Env> {
  const values: Record<string, string> = {
    EVOLUTION_BASE_URL: baseUrl,
    EVOLUTION_API_KEY: API_KEY,
    EVOLUTION_INSTANCE_NAME: 'it-default',
    EVOLUTION_WEBHOOK_URL: WEBHOOK_URL,
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env>;
}

/** Evolution env: docker-compose.dev.yml sem Redis (cache local, banco dedicado). */
function evolutionEnv(): Record<string, string> {
  const dbUri = 'postgresql://evo:evo@evo-db:5432/evolution?schema=public';
  return {
    SERVER_URL: 'http://localhost:8080',
    AUTHENTICATION_API_KEY: API_KEY,
    AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: 'true',
    DATABASE_ENABLED: 'true',
    DATABASE_PROVIDER: 'postgresql',
    DATABASE_CONNECTION_URI: dbUri,
    DATABASE_URL: dbUri,
    DATABASE_CONNECTION_CLIENT_NAME: 'evolution',
    DATABASE_SAVE_DATA_INSTANCE: 'true',
    DATABASE_SAVE_DATA_NEW_MESSAGE: 'false',
    DATABASE_SAVE_MESSAGE_UPDATE: 'false',
    DATABASE_SAVE_DATA_CONTACTS: 'false',
    DATABASE_SAVE_DATA_CHATS: 'false',
    DATABASE_SAVE_DATA_HISTORIC: 'false',
    CACHE_REDIS_ENABLED: 'false',
    CACHE_LOCAL_ENABLED: 'true',
    LOG_LEVEL: 'ERROR,WARN',
    LOG_BAILEYS: 'error',
    CONFIG_SESSION_PHONE_CLIENT: 'ORGAMIND',
    CONFIG_SESSION_PHONE_NAME: 'Chrome',
    DEL_INSTANCE: 'false',
    QRCODE_LIMIT: '30',
  };
}

async function webhookFind(instance: string): Promise<unknown> {
  return (await raw.get(`/webhook/find/${instance}`)).data;
}

async function instanceNames(): Promise<string[]> {
  const { data } = await raw.get<Array<{ name?: string }>>(
    '/instance/fetchInstances',
  );
  return data.map((i) => i.name ?? '');
}

/** Sobe Postgres + a imagem Evolution fixada e cria a instância `INSTANCE`. */
async function startEvolutionStack(): Promise<void> {
  network = await new Network().start();
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withNetwork(network)
    .withNetworkAliases('evo-db')
    .withDatabase('evolution')
    .withUsername('evo')
    .withPassword('evo')
    .start();
  evolution = await new GenericContainer(EVOLUTION_IMAGE)
    .withNetwork(network)
    .withEnvironment(evolutionEnv())
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/', 8080).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();
  const baseUrl = `http://${evolution.getHost()}:${evolution.getMappedPort(8080)}`;
  adapter = new EvolutionApiAdapter(configStub(baseUrl));
  raw = axios.create({ baseURL: baseUrl, headers: { apikey: API_KEY } });
  await adapter.adminCreateInstance({ instanceName: INSTANCE });
}

async function stopEvolutionStack(): Promise<void> {
  await evolution?.stop();
  await postgres?.stop();
  await network?.stop();
}

// Os testes compartilham a mesma instância e rodam em ordem: criação primeiro,
// remoção por último.
function creationTests() {
  it('GET / informa a versão 2.3.7', async () => {
    const { data } = await raw.get<{ version?: string }>('/');
    expect(data.version).toBe('2.3.7');
  });

  it('adminCreateInstance aplica os settings', async () => {
    const { data } = await raw.get<Record<string, unknown>>(
      `/settings/find/${INSTANCE}`,
    );
    expect(data).toMatchObject({
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      rejectCall: true,
    });
  });

  it('depois da criação, ensureWebhookArmed → ok sem set (sem re-arme em laço)', async () => {
    // 2.3.7: `find` devolve o registro plano do Prisma, com `headers` objeto.
    expect(await webhookFind(INSTANCE)).toMatchObject({
      enabled: true,
      url: WEBHOOK_URL,
      events: [...EVOLUTION_WEBHOOK_EVENTS],
      headers: { apikey: API_KEY },
      webhookByEvents: false,
      webhookBase64: false,
    });
    expect(await adapter.ensureWebhookArmed(INSTANCE)).toEqual({
      status: 'ok',
      fields: [],
    });
    expect(await adapter.ensureWebhookArmed(INSTANCE)).toEqual({
      status: 'ok',
      fields: [],
    });
  });
}

function lifecycleTests() {
  it('webhook desligado por fora → ensureWebhookArmed re-arma (enabled) e o ciclo seguinte dá ok', async () => {
    await raw.post(`/webhook/set/${INSTANCE}`, {
      webhook: { enabled: false, url: WEBHOOK_URL },
    });
    const rearmed = await adapter.ensureWebhookArmed(INSTANCE);
    expect(rearmed.status).toBe('rearmed');
    expect(rearmed.fields).toContain('enabled');
    expect(await adapter.ensureWebhookArmed(INSTANCE)).toEqual({
      status: 'ok',
      fields: [],
    });
  });

  it('adminRestart usa a rota aceita pela 2.3.7 (POST; PUT dá 404)', async () => {
    await expect(adapter.adminRestart(INSTANCE)).resolves.toBeUndefined();
    const put = await raw.put(`/instance/restart/${INSTANCE}`, undefined, {
      validateStatus: () => true,
    });
    expect(put.status).toBe(404);
  });

  it('adminDeleteInstance remove a instância', async () => {
    await vi.waitFor(async () =>
      expect(await instanceNames()).toContain(INSTANCE),
    );
    await adapter.adminDeleteInstance(INSTANCE);
    // A 2.3.7 responde 200 e some com a instância de fetchInstances ~2 s depois.
    await vi.waitFor(
      async () => expect(await instanceNames()).not.toContain(INSTANCE),
      { timeout: 20_000, interval: 500 },
    );
  });
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'EvolutionApiAdapter contra a imagem Evolution fixada (integration)',
  () => {
    beforeAll(startEvolutionStack, 300_000);
    afterAll(stopEvolutionStack, 60_000);

    describe('criação da instância', creationTests);
    describe('re-arme, restart e remoção', lifecycleTests);
  },
);
