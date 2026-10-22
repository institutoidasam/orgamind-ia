import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  LevelAdmin,
  LevelRef,
} from '../../schemas/contracts/level.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';

const levelSelect = {
  id: true,
  name: true,
  isActive: true,
  sortOrder: true,
  _count: { select: { users: true } },
} satisfies Prisma.StaffLevelSelect;

type LevelRow = Prisma.StaffLevelGetPayload<{ select: typeof levelSelect }>;
export type LevelCreateData = { name: string; sortOrder: number };
export type LevelUpdateData = { name?: string; isActive?: boolean };

function toAdmin({ _count, ...row }: LevelRow): LevelAdmin {
  return { ...row, userCount: _count.users };
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase('pt-BR');
}

@Injectable()
export class LevelsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<LevelAdmin[]> {
    const rows = await this.prisma.staffLevel.findMany({
      select: levelSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toAdmin);
  }

  /** Só o necessário para validar um `levelId` (existe? está ativo?). */
  findById(id: string): Promise<{ id: string; isActive: boolean } | null> {
    return this.prisma.staffLevel.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
  }

  /** Níveis ativos por sortOrder: seletores e filtros (usuários, página do setor, envio). */
  listActive(): Promise<LevelRef[]> {
    return this.prisma.staffLevel.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Comparação sem caixa feita aqui, não no banco: `mode: 'insensitive'` vira
   * ILIKE ('_' e '%' seriam curinga) e o `lower()` do Postgres depende do locale
   * para acentos. A tabela é pequena (a ordem aceita até 100).
   */
  async findByNameInsensitive(
    name: string,
    exceptId?: string,
  ): Promise<{ id: string } | null> {
    const key = nameKey(name);
    const rows = await this.prisma.staffLevel.findMany({
      select: { id: true, name: true },
      where: exceptId ? { id: { not: exceptId } } : undefined,
    });
    return rows.find((row) => nameKey(row.name) === key) ?? null;
  }

  async maxSortOrder(): Promise<number> {
    const result = await this.prisma.staffLevel.aggregate({
      _max: { sortOrder: true },
    });
    return result._max.sortOrder ?? 0;
  }

  async create(data: LevelCreateData): Promise<LevelAdmin> {
    return toAdmin(
      await this.prisma.staffLevel.create({ data, select: levelSelect }),
    );
  }

  async update(id: string, data: LevelUpdateData): Promise<LevelAdmin> {
    return toAdmin(
      await this.prisma.staffLevel.update({
        where: { id },
        data,
        select: levelSelect,
      }),
    );
  }

  /** sortOrder 1..n na ordem recebida, tudo ou nada. */
  async setOrder(ids: readonly string[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.staffLevel.update({
          where: { id },
          data: { sortOrder: index + 1 },
          select: { id: true },
        }),
      ),
    );
  }
}
