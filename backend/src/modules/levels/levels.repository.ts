import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  LevelAdmin,
  LevelRef,
} from '../../schemas/contracts/level.schema';
import type { OrderTrail } from '../../shared/audit/audit-order';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { type LevelAuditRow, levelAuditSelect } from './level-audit';
import { type LevelPeople, peopleByLevel } from './level-usage';

const levelSelect = {
  id: true,
  name: true,
  isActive: true,
  sortOrder: true,
} satisfies Prisma.StaffLevelSelect;

type LevelRow = Prisma.StaffLevelGetPayload<{ select: typeof levelSelect }>;
export type LevelCreateData = { name: string; sortOrder: number };
export type LevelUpdateData = { name?: string; isActive?: boolean };
/** Trilha do nível, gravada na transação da escrita; `before` nulo = criação. */
export type LevelTrail = (
  tx: Prisma.TransactionClient,
  before: LevelAuditRow | null,
  after: LevelAuditRow,
) => Promise<void>;
/** Roda no tx do `updateWithAudit`, com a linha travada e depois do "antes"; lançar desfaz a gravação. */
export type LevelUpdateGuard = (
  tx: Prisma.TransactionClient,
  before: LevelAuditRow,
  data: LevelUpdateData,
) => Promise<void>;

const NOBODY: LevelPeople = { activePeople: 0, inactivePeople: 0 };
const LEVEL_ORDER = [{ sortOrder: 'asc' }, { name: 'asc' }] as const;

// `userCount` é o total (ativas e inativas); o bloqueio de desativar olha só as ativas.
function toAdmin(row: LevelRow, people: LevelPeople = NOBODY): LevelAdmin {
  return {
    ...row,
    userCount: people.activePeople + people.inactivePeople,
    ...people,
  };
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase('pt-BR');
}

@Injectable()
export class LevelsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<LevelAdmin[]> {
    const [rows, people] = await Promise.all([
      this.prisma.staffLevel.findMany({
        select: levelSelect,
        orderBy: [...LEVEL_ORDER],
      }),
      peopleByLevel(this.prisma),
    ]);
    return rows.map((row) => toAdmin(row, people.get(row.id)));
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
    const row = await this.prisma.staffLevel.update({
      where: { id },
      data,
      select: levelSelect,
    });
    return toAdmin(row, (await peopleByLevel(this.prisma, [id])).get(id));
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

  /** Cria o nível e grava a trilha na mesma transação: falha de uma desfaz a outra. */
  createWithAudit(
    data: LevelCreateData,
    audit: LevelTrail,
  ): Promise<LevelAdmin> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.staffLevel.create({ data, select: levelSelect });
      await audit(tx, null, row);
      return toAdmin(row);
    });
  }

  /**
   * Edita o nível na transação: trava a linha (`FOR NO KEY UPDATE`), lê o
   * "antes", roda o `guard` (conferência de uso, E3), grava e registra a trilha.
   * A trava vem antes do "antes": sem ela, duas edições simultâneas leem o
   * mesmo "antes"; e a contagem de pessoas ativas do guard é decidida com a
   * linha travada, não numa leitura solta anterior. A criação de pessoa só pega
   * `FOR KEY SHARE` no nível e passa durante a trava (limite conhecido da spec).
   */
  updateWithAudit(
    id: string,
    data: LevelUpdateData,
    audit: LevelTrail,
    guard?: LevelUpdateGuard,
  ): Promise<LevelAdmin> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StaffLevel" WHERE id = ${id} FOR NO KEY UPDATE`;
      const before = await tx.staffLevel.findUniqueOrThrow({
        where: { id },
        select: levelAuditSelect,
      });
      await guard?.(tx, before, data);
      const row = await tx.staffLevel.update({
        where: { id },
        data,
        select: levelSelect,
      });
      await audit(tx, before, row);
      return toAdmin(row, (await peopleByLevel(tx, [id])).get(id));
    });
  }

  /**
   * sortOrder 1..n na ordem recebida, tudo ou nada, com a trilha (nomes antes e
   * depois) na mesma transação. Todas as linhas são travadas antes de ler a
   * ordem antiga, pela mesma razão do `updateWithAudit`.
   */
  reorderWithAudit(ids: readonly string[], audit: OrderTrail): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StaffLevel" ORDER BY id FOR NO KEY UPDATE`;
      const before = await this.namesInOrder(tx);
      for (const [index, id] of ids.entries()) {
        await tx.staffLevel.update({
          where: { id },
          data: { sortOrder: index + 1 },
        });
      }
      const after = await this.namesInOrder(tx);
      await audit(tx, before, after);
    });
  }

  private async namesInOrder(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.staffLevel.findMany({
      orderBy: [...LEVEL_ORDER],
      select: { name: true },
    });
    return rows.map(({ name }) => name);
  }
}
