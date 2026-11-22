import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { diffFields } from '../../shared/audit/audit-change';
import {
  DEFAULT_MATRIX,
  EDITABLE_ROLES,
  PERMISSION_KEYS,
  defaultPermissionsFor,
  resolvePermissions,
  type EditableRole,
  type PermissionKey,
} from '../../shared/authz/permissions';
import type {
  PermissionMatrix,
  SavePermissionMatrix,
} from '../../schemas/contracts/permissions.schema';
import { fixedRole } from './permissions.errors';
import { findEffectivePermissions } from './permissions.query';
import {
  PermissionsRepository,
  type PermissionCell,
  type PermissionRow,
} from './permissions.repository';

/** Estado pedido por papel editável: as chaves liberadas (repetida conta uma vez). */
type Desired = Record<EditableRole, ReadonlySet<PermissionKey>>;
type Cell = PermissionCell & { before: boolean };

const ACTION_UPDATED = 'permission.matrix_updated';
const ACTION_RESTORED = 'permission.matrix_restored';

const label = (role: EditableRole, key: PermissionKey) => `${key}:${role}`;

function toMatrix(rows: readonly PermissionRow[]): PermissionMatrix {
  const effective = (role: EditableRole) =>
    resolvePermissions(
      role,
      rows.filter((row) => row.role === role),
    );
  return {
    keys: [...PERMISSION_KEYS],
    roles: {
      ADMIN: defaultPermissionsFor('ADMIN'),
      SUPERVISOR: effective('SUPERVISOR'),
      OPERATOR: effective('OPERATOR'),
      VIEWER: defaultPermissionsFor('VIEWER'),
    },
    defaults: {
      SUPERVISOR: defaultPermissionsFor('SUPERVISOR'),
      OPERATOR: defaultPermissionsFor('OPERATOR'),
    },
    editableRoles: [...EDITABLE_ROLES],
  };
}

/** As 16 células (papel × chave) com o valor de agora e o pedido, na ordem estável. */
function cellsOf(rows: readonly PermissionRow[], desired: Desired): Cell[] {
  const matrix = toMatrix(rows).roles;
  return EDITABLE_ROLES.flatMap((role) =>
    PERMISSION_KEYS.map((key) => ({
      role,
      key,
      before: matrix[role].includes(key),
      granted: desired[role].has(key),
    })),
  );
}

function asDesired(
  grants: Record<EditableRole, readonly PermissionKey[]>,
): Desired {
  return {
    SUPERVISOR: new Set(grants.SUPERVISOR),
    OPERATOR: new Set(grants.OPERATOR),
  };
}

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PermissionsRepository,
    private readonly audit: AuditService,
  ) {}

  /** Permissões efetivas do papel, lidas do banco a cada chamada (sem cache). */
  effectiveFor(role: Role): Promise<PermissionKey[]> {
    return findEffectivePermissions(this.prisma, role);
  }

  async matrix(): Promise<PermissionMatrix> {
    return toMatrix(await this.repo.findRows(this.prisma));
  }

  /** Estado completo de SUPERVISOR e OPERATOR; ADMIN ou VIEWER no corpo → 422. */
  async save(
    actorId: string,
    body: SavePermissionMatrix,
  ): Promise<PermissionMatrix> {
    const { ADMIN, VIEWER, SUPERVISOR, OPERATOR } = body.roles;
    if (ADMIN !== undefined || VIEWER !== undefined) throw fixedRole();
    await this.apply(
      actorId,
      ACTION_UPDATED,
      asDesired({ SUPERVISOR, OPERATOR }),
    );
    return this.matrix();
  }

  async restoreDefaults(actorId: string): Promise<PermissionMatrix> {
    await this.apply(actorId, ACTION_RESTORED, asDesired(DEFAULT_MATRIX));
    return this.matrix();
  }

  /**
   * Lê, grava só as células que mudam e registra a trilha na MESMA transação
   * Serializable: trilha que falha desfaz a matriz, e o "antes" vem da leitura
   * feita dentro dela. Sem mudança, nada é gravado.
   */
  private apply(
    actorId: string,
    action: string,
    desired: Desired,
  ): Promise<void> {
    return this.repo.serializable(async (tx) => {
      const cells = cellsOf(await this.repo.findRows(tx), desired);
      const changes = diffFields(
        Object.fromEntries(cells.map((c) => [label(c.role, c.key), c.before])),
        Object.fromEntries(cells.map((c) => [label(c.role, c.key), c.granted])),
      );
      if (changes.length === 0) return;
      const changed = new Set(changes.map((change) => change.field));
      const toWrite = cells
        .filter((c) => changed.has(label(c.role, c.key)))
        .map(({ role, key, granted }) => ({ role, key, granted }));
      await this.repo.writeCells(tx, toWrite, actorId);
      await this.audit.recordChange(tx, {
        action,
        entity: 'RolePermission',
        entityId: null,
        category: 'PERMISSIONS',
        changes,
        actorId,
      });
    });
  }
}
