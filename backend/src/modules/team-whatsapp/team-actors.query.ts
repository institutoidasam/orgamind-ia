import type { Prisma, Role } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findEffectivePermissions } from '../permissions/permissions.query';
import type { HandlerState } from '../../schemas/contracts/team-pendency.schema';
import { handlerStateOf, type PendencyScopeFacts } from './team-pendency.rules';
import type { TeamActor } from './team-whatsapp.policy';

/** Ator com o nome, para os rótulos de responsável e a lista de destinos (K2-2, K2-7). */
export type NamedTeamActor = TeamActor & { name: string };

/** Papéis que podem tratar pendência (o VIEWER nunca é remetente). */
const HANDLER_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

const ACTOR_SELECT = {
  id: true,
  name: true,
  role: true,
  isActive: true,
  hasAccess: true,
  managedSectors: { where: { isActive: true }, select: { id: true } },
} satisfies Prisma.UserSelect;

type ActorRow = Prisma.UserGetPayload<{ select: typeof ACTOR_SELECT }>;

/**
 * Formato de `findTeamActor` (setores ATIVOS geridos e permissões efetivas lidas
 * agora, sem cache), em lote: uma leitura de permissões por papel, não por pessoa.
 */
async function toTeamActors(
  prisma: PrismaService,
  rows: readonly ActorRow[],
): Promise<NamedTeamActor[]> {
  const roles = [...new Set(rows.map((row) => row.role))];
  const byRole = new Map(
    await Promise.all(
      roles.map(
        async (role) =>
          [role, await findEffectivePermissions(prisma, role)] as const,
      ),
    ),
  );
  return rows.map(({ managedSectors, name, ...rest }) => ({
    ...rest,
    // Usuário sem nome grava `null`; o rótulo vazio segue o K1 (`findAssigneeRef`).
    name: name ?? '',
    managedSectorIds: managedSectors.map((sector) => sector.id),
    permissions: [...(byRole.get(rest.role) ?? [])],
  }));
}

/** Atores por id; id que não existe fica fora do mapa. */
export async function findTeamActors(
  prisma: PrismaService,
  ids: readonly string[],
): Promise<Map<string, NamedTeamActor>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: ACTOR_SELECT,
  });
  const actors = await toTeamActors(prisma, rows);
  return new Map(actors.map((actor) => [actor.id, actor]));
}

/** Quem pode receber uma pendência em tese: ADMIN, SUPERVISOR e OPERATOR ativos com acesso, por nome. */
export async function listHandlerCandidates(
  prisma: PrismaService,
): Promise<NamedTeamActor[]> {
  const rows = await prisma.user.findMany({
    where: {
      role: { in: [...HANDLER_ROLES] },
      isActive: true,
      hasAccess: true,
    },
    select: ACTOR_SELECT,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return toTeamActors(prisma, rows);
}

export type HandlerStateView = { state: HandlerState; name: string | null };

/**
 * Estado do responsável de cada linha (K2-2, DK4), na ordem das linhas; `null`
 * = sem responsável. Os responsáveis são lidos em lote e uma vez cada.
 */
export async function handlerStatesFor(
  prisma: PrismaService,
  rows: ReadonlyArray<PendencyScopeFacts & { handlerId: string | null }>,
): Promise<Array<HandlerStateView | null>> {
  const ids = new Set<string>();
  for (const row of rows) if (row.handlerId !== null) ids.add(row.handlerId);
  const handlers = await findTeamActors(prisma, [...ids]);
  return rows.map((row) => {
    if (row.handlerId === null) return null;
    const handler = handlers.get(row.handlerId) ?? null;
    return { state: handlerStateOf(handler, row), name: handler?.name ?? null };
  });
}
