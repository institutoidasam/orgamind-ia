import type { PermissionActor } from '../../shared/authz/person-actions.policy';
import {
  hasPermission,
  permissionDenied,
} from '../../shared/authz/permissions';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import { importNoManagedSector } from './people-import.errors';

/**
 * Quem importa, montado a cada pedido (sem cache): permissões efetivas e
 * alcance de agora. `reach` nulo = ADMIN (alcança tudo); nos demais é a lista
 * de setores ATIVOS que gerencia. `policy` alimenta as políticas de pessoa.
 */
export type ImportActor = {
  id: string;
  isAdmin: boolean;
  fullPhone: boolean;
  canEditPeople: boolean;
  reach: readonly string[] | null;
  policy: PermissionActor;
};

export function toImportActor(actor: TeamActor): ImportActor {
  const isAdmin = actor.role === 'ADMIN';
  return {
    id: actor.id,
    isAdmin,
    fullPhone: hasPermission(actor, 'telefone.ver_completo'),
    canEditPeople: hasPermission(actor, 'pessoas.editar'),
    reach: isAdmin ? null : [...actor.managedSectorIds],
    policy: {
      id: actor.id,
      role: actor.role,
      permissions: [...actor.permissions],
    },
  };
}

/** Ator ausente, inativo ou sem acesso ao sistema: 403 igual ao de quem não tem a chave. */
export async function loadImportActor(
  prisma: PrismaService,
  id: string,
): Promise<ImportActor> {
  const actor = await findTeamActor(prisma, id);
  if (!actor || !actor.isActive || !actor.hasAccess) {
    throw permissionDenied('pessoas.importar');
  }
  return toImportActor(actor);
}

/** GX6/EX32: quem não é ADMIN precisa de `pessoas.editar` e de ao menos um setor. */
export function assertCanWrite(actor: ImportActor): void {
  if (actor.isAdmin) return;
  if (!actor.canEditPeople) throw permissionDenied('pessoas.editar');
  if (!actor.reach || actor.reach.length === 0) throw importNoManagedSector();
}

/** GX9: ADMIN vê todos os lotes; os demais só os que enviaram. */
export function canSeeBatch(
  actor: ImportActor,
  batch: { createdById: string },
): boolean {
  return actor.isAdmin || batch.createdById === actor.id;
}

/** ADMIN tem todas as chaves; quem não é ADMIN só toca pessoa sem login. */
export function phoneFullFor(actor: ImportActor): boolean {
  return actor.fullPhone;
}
