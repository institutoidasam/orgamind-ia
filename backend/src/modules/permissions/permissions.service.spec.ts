import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  DEFAULT_MATRIX,
  EDITABLE_ROLES,
  PERMISSION_KEYS,
  defaultPermissionsFor,
  type EditableRole,
  type PermissionKey,
} from '../../shared/authz/permissions';
import type { SavePermissionMatrix } from '../../schemas/contracts/permissions.schema';
import type { PermissionsRepository } from './permissions.repository';
import { PermissionsService } from './permissions.service';

const ACTOR = 'admin-1';
const TX = { tx: true };

/** Matriz como a migração semeia: as 16 células no padrão, com `changed` por cima. */
function rowsWith(
  changed: Partial<Record<`${EditableRole}:${PermissionKey}`, boolean>> = {},
) {
  return EDITABLE_ROLES.flatMap((role) =>
    PERMISSION_KEYS.map((key) => ({
      role,
      key,
      granted: changed[`${role}:${key}`] ?? DEFAULT_MATRIX[role].includes(key),
    })),
  );
}

function build(rows = rowsWith()) {
  const repo = {
    findRows: vi.fn().mockResolvedValue(rows),
    writeCells: vi.fn().mockResolvedValue(undefined),
    serializable: vi.fn((fn: (tx: unknown) => unknown) => fn(TX)),
  };
  const audit = { recordChange: vi.fn().mockResolvedValue(undefined) };
  const service = new PermissionsService(
    {} as PrismaService,
    repo as unknown as PermissionsRepository,
    audit as unknown as AuditService,
  );
  return { service, repo, audit };
}

/** Estado completo pedido: o padrão, com `operator`/`supervisor` no lugar do papel. */
function body(
  roles: Partial<Record<Role, readonly PermissionKey[]>> = {},
): SavePermissionMatrix {
  return {
    roles: {
      SUPERVISOR: [...DEFAULT_MATRIX.SUPERVISOR],
      OPERATOR: [...DEFAULT_MATRIX.OPERATOR],
      ...roles,
    },
  } as SavePermissionMatrix;
}

const without = (role: EditableRole, key: PermissionKey) =>
  DEFAULT_MATRIX[role].filter((k) => k !== key);

describe('PermissionsService.matrix', () => {
  it('matrix devolve keys, roles dos 4 papéis, defaults e editableRoles', async () => {
    const { service, repo } = build(
      rowsWith({ 'OPERATOR:escala.alterar': false }),
    );

    const matrix = await service.matrix();

    expect(repo.findRows).toHaveBeenCalledTimes(1);
    expect(matrix.keys).toEqual([...PERMISSION_KEYS]);
    expect(matrix.editableRoles).toEqual(['SUPERVISOR', 'OPERATOR']);
    expect(matrix.roles.ADMIN).toEqual(defaultPermissionsFor('ADMIN'));
    expect(matrix.roles.VIEWER).toEqual([]);
    expect(matrix.roles.SUPERVISOR).toEqual(
      defaultPermissionsFor('SUPERVISOR'),
    );
    expect(matrix.roles.OPERATOR).not.toContain('escala.alterar');
    expect(matrix.defaults).toEqual({
      SUPERVISOR: defaultPermissionsFor('SUPERVISOR'),
      OPERATOR: defaultPermissionsFor('OPERATOR'),
    });
  });
});

describe('PermissionsService.save — recusa e sem mudança', () => {
  it('save com ADMIN ou VIEWER no corpo → 422 permissions.fixed_role sem gravar', async () => {
    const { service, repo, audit } = build();
    const fixed = {
      status: 422,
      code: 'permissions.fixed_role',
      message: 'Permissões não alteradas',
      detail:
        'Administrador e Leitura têm permissões fixas e não podem ser alterados.',
    };

    await expect(
      service.save(ACTOR, body({ ADMIN: [...PERMISSION_KEYS] })),
    ).rejects.toMatchObject(fixed);
    await expect(
      service.save(ACTOR, body({ VIEWER: [] })),
    ).rejects.toMatchObject(fixed);

    expect(repo.serializable).not.toHaveBeenCalled();
    expect(repo.writeCells).not.toHaveBeenCalled();
    expect(audit.recordChange).not.toHaveBeenCalled();
  });

  it('save sem mudança não grava nem chama recordChange', async () => {
    const { service, repo, audit } = build();

    await service.save(ACTOR, body());

    expect(repo.writeCells).not.toHaveBeenCalled();
    expect(audit.recordChange).not.toHaveBeenCalled();
  });
});

describe('PermissionsService.save — gravação e trilha', () => {
  it('save tirando escala.alterar do OPERATOR grava uma célula e uma FieldChange escala.alterar:OPERATOR true→false', async () => {
    const { service, repo, audit } = build();

    await service.save(
      ACTOR,
      body({ OPERATOR: without('OPERATOR', 'escala.alterar') }),
    );

    expect(repo.findRows).toHaveBeenCalledWith(TX);
    expect(repo.writeCells).toHaveBeenCalledWith(
      TX,
      [{ role: 'OPERATOR', key: 'escala.alterar', granted: false }],
      ACTOR,
    );
    expect(audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'permission.matrix_updated',
      entity: 'RolePermission',
      entityId: null,
      category: 'PERMISSIONS',
      actorId: ACTOR,
      changes: [
        { field: 'escala.alterar:OPERATOR', before: true, after: false },
      ],
    });
  });
});

describe('PermissionsService.save — chave repetida no corpo', () => {
  it('chave repetida no corpo conta uma vez e conceder vira false→true', async () => {
    const { service, repo, audit } = build();
    const supervisor = [
      ...DEFAULT_MATRIX.SUPERVISOR,
      'estrutura.manter',
      'estrutura.manter',
    ] as PermissionKey[];

    await service.save(ACTOR, body({ SUPERVISOR: supervisor }));

    expect(repo.writeCells).toHaveBeenCalledWith(
      TX,
      [{ role: 'SUPERVISOR', key: 'estrutura.manter', granted: true }],
      ACTOR,
    );
    expect(audit.recordChange).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        changes: [
          { field: 'estrutura.manter:SUPERVISOR', before: false, after: true },
        ],
      }),
    );
  });
});

describe('PermissionsService.restoreDefaults', () => {
  it('restoreDefaults grava só as células diferentes do padrão com permission.matrix_restored', async () => {
    const { service, repo, audit } = build(
      rowsWith({
        'OPERATOR:escala.alterar': false,
        'SUPERVISOR:estrutura.manter': true,
      }),
    );

    await service.restoreDefaults(ACTOR);

    expect(repo.writeCells).toHaveBeenCalledWith(
      TX,
      [
        { role: 'SUPERVISOR', key: 'estrutura.manter', granted: false },
        { role: 'OPERATOR', key: 'escala.alterar', granted: true },
      ],
      ACTOR,
    );
    expect(audit.recordChange).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        action: 'permission.matrix_restored',
        changes: [
          { field: 'estrutura.manter:SUPERVISOR', before: true, after: false },
          { field: 'escala.alterar:OPERATOR', before: false, after: true },
        ],
      }),
    );
  });
});
