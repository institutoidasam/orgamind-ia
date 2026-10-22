import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TeamActor } from './team-whatsapp.policy';

/**
 * Ator das políticas de envio e da escala. `managedSectorIds` só traz setores
 * ATIVOS em que ele é `managerId`. Compartilhado sem importar o módulo inteiro.
 */
export async function findTeamActor(
  prisma: PrismaService,
  id: string,
): Promise<TeamActor | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      isActive: true,
      hasAccess: true,
      managedSectors: { where: { isActive: true }, select: { id: true } },
    },
  });
  if (!user) return null;
  const { managedSectors, ...rest } = user;
  return { ...rest, managedSectorIds: managedSectors.map((s) => s.id) };
}
