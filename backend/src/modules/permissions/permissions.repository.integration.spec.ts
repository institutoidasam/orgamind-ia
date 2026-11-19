import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import {
  DEFAULT_MATRIX,
  EDITABLE_ROLES,
  PERMISSION_KEYS,
  defaultPermissionsFor,
  type PermissionKey,
} from '../../shared/authz/permissions';
import type { SavePermissionMatrix } from '../../schemas/contracts/permissions.schema';
import { findEffectivePermissions } from './permissions.query';
import { PermissionsRepository } from './permissions.repository';
import { PermissionsService } from './permissions.service';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let audit: AuditService;
let service: PermissionsService;
const repo = () => new PermissionsRepository(prisma as never);
const serviceWith = (auditService: AuditService) =>
  new PermissionsService(prisma as never, repo(), auditService);

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  // Serviço de verdade sobre o banco de verdade: a trilha sai de recordChange.
  audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  service = serviceWith(audit);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Volta as 16 células ao padrão (como a migração semeia) e limpa a trilha. */
beforeEach(async () => {
  await prisma.auditEvent.deleteMany();
  for (const role of EDITABLE_ROLES) {
    for (const key of PERMISSION_KEYS) {
      await prisma.rolePermission.update({
        where: { role_key: { role, key } },
        data: {
          granted: DEFAULT_MATRIX[role].includes(key),
          updatedById: null,
        },
      });
    }
  }
});

/** O padrão, com `roles` por cima: o estado completo que a tela envia. */
function body(
  roles: Partial<Record<'SUPERVISOR' | 'OPERATOR', PermissionKey[]>>,
) {
  return {
    roles: {
      SUPERVISOR: [...DEFAULT_MATRIX.SUPERVISOR],
      OPERATOR: [...DEFAULT_MATRIX.OPERATOR],
      ...roles,
    },
  } as SavePermissionMatrix;
}

const operatorWithoutSchedule = () =>
  DEFAULT_MATRIX.OPERATOR.filter((key) => key !== 'escala.alterar');
const events = () =>
  prisma.auditEvent.findMany({
    where: { entity: 'RolePermission' },
    orderBy: { createdAt: 'asc' },
  });

describe('trilha da matriz na mesma transação (banco real)', () => {
  it('trilha que lança desfaz a mudança da matriz', async () => {
    const failing = {
      recordChange: () => Promise.reject(new Error('trilha falhou')),
    } as unknown as AuditService;

    await expect(
      serviceWith(failing).save(
        'admin-1',
        body({ OPERATOR: operatorWithoutSchedule() }),
      ),
    ).rejects.toThrow('trilha falhou');

    await expect(findEffectivePermissions(prisma, 'OPERATOR')).resolves.toEqual(
      defaultPermissionsFor('OPERATOR'),
    );
    const cell = await prisma.rolePermission.findUniqueOrThrow({
      where: { role_key: { role: 'OPERATOR', key: 'escala.alterar' } },
    });
    expect(cell).toMatchObject({ granted: true, updatedById: null });
    await expect(events()).resolves.toEqual([]);
  });
});

describe('evento da matriz (banco real)', () => {
  it('evento gravado tem category PERMISSIONS, subjectUserId nulo e changes por célula', async () => {
    const request = body({
      SUPERVISOR: [...DEFAULT_MATRIX.SUPERVISOR, 'estrutura.manter'],
      OPERATOR: operatorWithoutSchedule(),
    });

    const saved = await service.save('admin-1', request);

    expect(saved.roles.OPERATOR).not.toContain('escala.alterar');
    await expect(
      findEffectivePermissions(prisma, 'SUPERVISOR'),
    ).resolves.toContain('estrutura.manter');
    const [event, ...rest] = await events();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'permission.matrix_updated',
      entityId: null,
      category: 'PERMISSIONS',
      subjectUserId: null,
      actorId: 'admin-1',
      changes: [
        { field: 'estrutura.manter:SUPERVISOR', before: false, after: true },
        { field: 'escala.alterar:OPERATOR', before: true, after: false },
      ],
    });
    const cell = await prisma.rolePermission.findUniqueOrThrow({
      where: { role_key: { role: 'OPERATOR', key: 'escala.alterar' } },
    });
    expect(cell).toMatchObject({ granted: false, updatedById: 'admin-1' });
  });
});

describe('restauração do padrão (banco real)', () => {
  it('restoreDefaults devolve o padrão e registra permission.matrix_restored', async () => {
    await service.save(
      'admin-1',
      body({ OPERATOR: operatorWithoutSchedule() }),
    );

    const restored = await service.restoreDefaults('admin-2');

    expect(restored.roles.OPERATOR).toEqual(defaultPermissionsFor('OPERATOR'));
    const last = (await events()).at(-1);
    expect(last).toMatchObject({
      action: 'permission.matrix_restored',
      actorId: 'admin-2',
      changes: [
        { field: 'escala.alterar:OPERATOR', before: false, after: true },
      ],
    });
  });
});

describe('gravações concorrentes da matriz (GB7)', () => {
  it('duas gravações iguais ao mesmo tempo deixam um só evento, com o "antes" verdadeiro', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    // A primeira trilha espera depois de gravar a célula (lock de linha aberto).
    const slowAudit = {
      recordChange: async (
        ...args: Parameters<AuditService['recordChange']>
      ) => {
        if (!held) {
          held = true;
          await gate;
        }
        return audit.recordChange(...args);
      },
    } as unknown as AuditService;
    const request = body({ OPERATOR: operatorWithoutSchedule() });

    const first = serviceWith(slowAudit).save('admin-1', request);
    await vi.waitFor(() => expect(held).toBe(true));
    const second = service.save('admin-2', request);
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await Promise.all([first, second]);

    // Sem Serializable a segunda gravaria o mesmo true→false depois da primeira.
    const [only, ...rest] = await events();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      actorId: 'admin-1',
      changes: [
        { field: 'escala.alterar:OPERATOR', before: true, after: false },
      ],
    });
  });
});
