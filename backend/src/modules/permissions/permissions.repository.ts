import { Injectable } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { permissionsConflict } from './permissions.errors';
import type {
  EditableRole,
  PermissionKey,
} from '../../shared/authz/permissions';

export type PermissionRow = { role: Role; key: string; granted: boolean };
export type PermissionCell = {
  role: EditableRole;
  key: PermissionKey;
  granted: boolean;
};

type Reader = Pick<PrismaService, 'rolePermission'> | Prisma.TransactionClient;

/** Tentativas da transação Serializable que perde a corrida (como `UsersRepository`). */
const MAX_ATTEMPTS = 3;
/** P2034: falha de serialização; P2002: a célula nasceu entre a leitura e o upsert. */
const RETRYABLE = new Set(['P2034', 'P2002']);

/**
 * Escrita da matriz (`RolePermission`). A leitura que o guard usa continua em
 * `permissions.query.ts`; aqui só a listagem completa para a tela e a gravação.
 */
@Injectable()
export class PermissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findRows(client: Reader): Promise<PermissionRow[]> {
    return client.rolePermission.findMany({
      select: { role: true, key: true, granted: true },
    });
  }

  /** Upsert célula a célula, na ordem recebida (ordem estável evita deadlock entre gravações). */
  async writeCells(
    tx: Prisma.TransactionClient,
    cells: ReadonlyArray<PermissionCell>,
    actorId: string,
  ): Promise<void> {
    for (const { role, key, granted } of cells) {
      await tx.rolePermission.upsert({
        where: { role_key: { role, key } },
        create: { role, key, granted, updatedById: actorId },
        update: { granted, updatedById: actorId },
      });
    }
  }

  /**
   * Transação Serializable (GB7): duas gravações da matriz ao mesmo tempo não
   * deixam a trilha com um "antes" que o estado final contradiz; a que perde é
   * refeita, relê a matriz já gravada pela outra e recalcula o que mudou.
   * Esgotadas as tentativas, `permissions.conflict` (409) em vez de erro cru.
   */
  async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isRetryable(error)) throw error;
      }
    }
    // Tentativas esgotadas: o rollback já aconteceu, nada ficou gravado.
    throw permissionsConflict();
  }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    RETRYABLE.has(error.code)
  );
}
