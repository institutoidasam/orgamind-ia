import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import { OrganizationService, ORGANIZATION_ID } from './organization.service';

const ENV: Record<string, unknown> = {
  ORG_NAME: 'CONTINUUM',
  ORG_LEGAL_NAME: 'Canal do Matheus Garcia - CONTINUUM',
};

function makeService(env: Record<string, unknown> = ENV) {
  const prisma = mockDeep<PrismaService>();
  const audit = mockDeep<AuditService>();
  const config = {
    get: vi.fn((key: string) => env[key]),
  } as unknown as ConfigService<Env>;

  const service = new OrganizationService(prisma, audit, config);
  return { service, prisma, audit };
}

describe('OrganizationService.get', () => {
  let service: OrganizationService;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    ({ service, prisma } = makeService());
  });

  it('devolve a organização persistida (a que o operador editou na tela)', async () => {
    prisma.organization.findUnique.mockResolvedValue({
      id: ORGANIZATION_ID,
      name: 'CONTINUUM',
      legalName: 'Matheus Garcia Comunicação LTDA',
      privacyPolicyUrl: 'https://continuum.exemplo.br/privacidade',
      supportContact: 'suporte@continuum.exemplo.br',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const org = await service.get();

    expect(org.name).toBe('CONTINUUM');
    expect(org.legalName).toBe('Matheus Garcia Comunicação LTDA');
    expect(org.privacyPolicyUrl).toBe('https://continuum.exemplo.br/privacidade');
  });

  it('sem linha no banco (seed não rodou), cai no env — a landing PÚBLICA não pode quebrar', async () => {
    prisma.organization.findUnique.mockResolvedValue(null);

    const org = await service.get();

    expect(org.name).toBe('CONTINUUM');
    expect(org.legalName).toBe('Canal do Matheus Garcia - CONTINUUM');
  });

  it('sem linha e sem env, o fallback é NEUTRO — jamais o nome de outra organização', async () => {
    ({ service, prisma } = makeService({}));
    prisma.organization.findUnique.mockResolvedValue(null);

    const org = await service.get();

    expect(JSON.stringify(org)).not.toMatch(/idasam/i);
  });
});

describe('OrganizationService.update — PATCH /organization', () => {
  let service: OrganizationService;
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;

  beforeEach(() => {
    ({ service, prisma, audit } = makeService());
    prisma.organization.upsert.mockImplementation((async (args: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => ({
      id: ORGANIZATION_ID,
      privacyPolicyUrl: null,
      supportContact: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.create,
      ...args.update,
    })) as never);
  });

  it('persiste a identidade nova no singleton', async () => {
    const org = await service.update(
      {
        name: 'CONTINUUM',
        legalName: 'Matheus Garcia Comunicação LTDA',
        privacyPolicyUrl: 'https://continuum.exemplo.br/privacidade',
      },
      'user-1',
    );

    expect(prisma.organization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ORGANIZATION_ID } }),
    );
    expect(org.legalName).toBe('Matheus Garcia Comunicação LTDA');
  });

  it('um PATCH parcial não apaga o que não veio', async () => {
    await service.update({ name: 'CONTINUUM' }, 'user-1');

    const args = prisma.organization.upsert.mock.calls[0][0] as unknown as {
      update: Record<string, unknown>;
    };
    expect(args.update).toEqual({ name: 'CONTINUUM' });
    expect(args.update).not.toHaveProperty('legalName');
  });

  it('audita quem trocou a identidade — é ela que vai no consentimento dos titulares', async () => {
    await service.update({ name: 'CONTINUUM' }, 'user-1');

    expect(audit.log).toHaveBeenCalledWith(
      'organization.updated',
      'Organization',
      ORGANIZATION_ID,
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });
});
