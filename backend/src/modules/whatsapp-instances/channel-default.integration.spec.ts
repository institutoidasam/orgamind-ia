import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * Regression guard for a defect only a REAL database can catch: the initial
 * migration created `WhatsappInstance_isDefault_unique` — a partial unique
 * index allowing exactly ONE default channel table-wide. Multi-provider
 * channels need one default PER PROVIDER (the router falls back to
 * `findDefault(provider)` scoped to the campaign's provider).
 *
 * Every unit test mocks PrismaService, so none of them can see a unique
 * violation. Before `20260710061500_per_provider_default_index` dropped the old
 * index, marking a TWILIO channel as default while an EVOLUTION default existed
 * failed at runtime with a 500.
 */
describe('Channel default is scoped per provider (real Postgres)', () => {
  let postgres: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('picoa_test')
      .withUsername('picoa')
      .withPassword('picoa')
      .start();

    const url = postgres.getConnectionUri();
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    });

    prisma = new PrismaClient({ datasources: { db: { url } } });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('allows one default per provider, and rejects two defaults within a provider', async () => {
    await prisma.channel.create({
      data: {
        name: 'Evolution',
        provider: 'EVOLUTION',
        evolutionInstanceName: 'evo-1',
        apiKey: 'k',
        isDefault: true,
      },
    });

    // The whole point: a Twilio default must coexist with the Evolution one.
    await expect(
      prisma.channel.create({
        data: {
          name: 'Twilio',
          provider: 'TWILIO',
          phoneE164: '+15550001111',
          isDefault: true,
        },
      }),
    ).resolves.toMatchObject({ provider: 'TWILIO', isDefault: true });

    // ...while a SECOND default inside one provider is still refused by the DB.
    await expect(
      prisma.channel.create({
        data: {
          name: 'Twilio 2',
          provider: 'TWILIO',
          phoneE164: '+15550002222',
          isDefault: true,
        },
      }),
    ).rejects.toThrow(/[Uu]nique constraint/);

    const defaults = await prisma.channel.findMany({
      where: { isDefault: true },
      select: { provider: true },
    });
    expect(defaults.map((d) => d.provider).sort()).toEqual(['EVOLUTION', 'TWILIO']);
  }, 60_000);
});
