import type { Prisma } from '@prisma/client';
import type { LevelAuditRow } from './level-audit';
import { levelInUse } from './levels.errors';
import type { LevelUpdateData, LevelUpdateGuard } from './levels.repository';

export type LevelPeople = { activePeople: number; inactivePeople: number };

type UserDb = Pick<Prisma.TransactionClient, 'user'>;

/**
 * Pessoas por nível, ativas e inativas, de uma vez (E4). Sem `levelIds`, todos
 * os níveis; nível sem ninguém não aparece no mapa.
 */
export async function peopleByLevel(
  db: UserDb,
  levelIds?: readonly string[],
): Promise<Map<string, LevelPeople>> {
  const groups = await db.user.groupBy({
    by: ['levelId', 'isActive'],
    where: { levelId: levelIds ? { in: [...levelIds] } : { not: null } },
    _count: { _all: true },
  });
  const byLevel = new Map<string, LevelPeople>();
  for (const { levelId, isActive, _count } of groups) {
    if (!levelId) continue;
    const people = byLevel.get(levelId) ?? {
      activePeople: 0,
      inactivePeople: 0,
    };
    if (isActive) people.activePeople += _count._all;
    else people.inactivePeople += _count._all;
    byLevel.set(levelId, people);
  }
  return byLevel;
}

/** Pessoas ativas com o nível; o `db` é o `tx` quando a contagem decide a gravação. */
export function countActiveLevelPeople(
  db: UserDb,
  levelId: string,
): Promise<number> {
  return db.user.count({ where: { levelId, isActive: true } });
}

/**
 * Guard da desativação (E3): só confere quando o pedido desativa (`isActive`
 * false) e o nível estava ativo antes; reativar e renomear seguem livres. Roda
 * no `tx` da gravação, com a linha do nível travada: pessoa ativa →
 * `levels.in_use` 409. A pessoa inativa não bloqueia.
 */
export function deactivationGuard(levelId: string): LevelUpdateGuard {
  return async (
    tx: Prisma.TransactionClient,
    before: LevelAuditRow,
    data: LevelUpdateData,
  ) => {
    if (data.isActive !== false || !before.isActive) return;
    const people = await countActiveLevelPeople(tx, levelId);
    if (people > 0) throw levelInUse(people);
  };
}
