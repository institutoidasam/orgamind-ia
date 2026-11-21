import type { Prisma } from '@prisma/client';
import { toDbDate, type CivilDate } from '../staff-schedule/civil-date';
import type { SectorAuditRow } from './sector-audit';
import { sectorInUse } from './sector.errors';

export type SectorUsage = {
  people: number;
  exceptions: number;
  scheduled: number;
  inactivePeople: number;
};

export type SectorUsageDb = Pick<
  Prisma.TransactionClient,
  'user' | 'staffScheduleException' | 'teamWhatsappDispatch'
>;

/**
 * Uso do setor (E2, DJ9), contado com o `db` recebido: o `tx` na gravação, o
 * cliente comum na tela. `today` é a data civil de Manaus.
 * - people: pessoas ativas com o setor como principal;
 * - exceptions: exceções de hoje em diante de pessoas ativas que apontam para ele;
 * - scheduled: envios agendados pendentes que o incluem (envio a pessoa não
 *   grava linha de setor, então não entra);
 * - inactivePeople: só informação, não bloqueia.
 */
export async function sectorUsage(
  db: SectorUsageDb,
  sectorId: string,
  today: CivilDate,
): Promise<SectorUsage> {
  const [people, exceptions, scheduled, inactivePeople] = await Promise.all([
    db.user.count({ where: { sectorId, isActive: true } }),
    db.staffScheduleException.count({
      where: {
        sectorId,
        endDate: { gte: toDbDate(today) },
        user: { isActive: true },
      },
    }),
    db.teamWhatsappDispatch.count({
      where: { state: 'SCHEDULED', sectors: { some: { sectorId } } },
    }),
    db.user.count({ where: { sectorId, isActive: false } }),
  ]);
  return { people, exceptions, scheduled, inactivePeople };
}

/** Em uso = tem pessoa ativa, exceção futura de pessoa ativa ou envio agendado pendente. */
export function isSectorInUse(usage: SectorUsage): boolean {
  return usage.people + usage.exceptions + usage.scheduled > 0;
}

/** Roda dentro da transação do setor, depois da trava e da leitura do "antes"; lançar desfaz a gravação. */
export type SectorUpdateGuard = (
  tx: Prisma.TransactionClient,
  before: SectorAuditRow,
) => Promise<void>;

/**
 * Guard da inativação: setor já inativo não é conferido (reativar e editar
 * seguem livres); ativo e em uso → `sector.in_use` 409. A conferência usa o
 * `tx` da gravação, com a linha do setor travada.
 */
export function inactivationGuard(
  sectorId: string,
  today: CivilDate,
): SectorUpdateGuard {
  return async (tx, before) => {
    if (!before.isActive) return;
    const usage = await sectorUsage(tx, sectorId, today);
    if (isSectorInUse(usage)) throw sectorInUse(usage);
  };
}
