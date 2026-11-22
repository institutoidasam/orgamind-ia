import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Nome do setor para o arquivo e a trilha da escala. O `sectors` do quadro só
 * traz os setores citados nas linhas, não o do próprio quadro (DX14).
 */
export async function findSectorName(
  prisma: PrismaService,
  sectorId: string,
): Promise<string | null> {
  const sector = await prisma.sector.findUnique({
    where: { id: sectorId },
    select: { name: true },
  });
  return sector?.name ?? null;
}
