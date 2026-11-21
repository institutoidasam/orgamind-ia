import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  T0,
  at,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  type NewPendencyInput,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import { TeamPendencyActionsService } from './team-pendency-actions.service';

/**
 * Cenário comum dos testes de Transferir e Registrar contato (T8a): um gestor
 * (SUPERVISOR) de um setor, um envio do ADMIN a esse setor e um segundo ADMIN
 * como destino possível. Datas a partir de `T0`/`at(min)` (GK8); dados fictícios.
 */
export async function setupHandling(db: PendencyDb) {
  const manager = await newTeamUser(db, { role: 'SUPERVISOR' });
  const sector = await newSector(db, { managerId: manager.id });
  const dispatchId = await newAlert(db, {
    authorId: db.ids.admin,
    createdAt: T0,
  });
  const otherAdmin = await newTeamUser(db, { role: 'ADMIN' });
  return {
    manager,
    sector,
    dispatchId,
    otherAdmin,
    actions: () =>
      new TeamPendencyActionsService(
        db.prisma as unknown as PrismaService,
        db.audit,
      ),
    /** Pendência do setor do gestor, aberta e sem responsável, salvo o que `extra` disser. */
    seed: (extra: Partial<NewPendencyInput> = {}) =>
      newPendency(db, { dispatchId, sectorId: sector.id, ...extra }),
  };
}

/** Pendência já assumida por `handlerId` em `at(1)`, com prazo até `at(61)`. */
export const heldBy = (handlerId: string) => ({
  handlerId,
  assignedAt: at(1),
  dueAt: at(61),
});

/** Encerrada pelo ADMIN em `at(5)`. */
export const closedBy = (adminId: string) => ({
  closedAt: at(5),
  closedById: adminId,
  closeReason: 'Resolvido',
});

/** Leituras diretas do banco para conferir o que a ação gravou (ou não). */
export function readers(db: PendencyDb) {
  const rowOf = (id: string) =>
    db.prisma.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });
  const notesOf = (id: string) =>
    db.prisma.teamPendencyNote.findMany({ where: { recipientId: id } });
  const trailOf = (id: string) =>
    db.prisma.auditEvent.findMany({
      where: { entity: 'TeamWhatsappRecipient', entityId: id },
    });
  /** Linha, anotações e trilha: uma recusa não muda nenhum dos três. */
  const snapshot = async (id: string) => ({
    row: await rowOf(id),
    notes: await notesOf(id),
    trail: await trailOf(id),
  });
  return { rowOf, notesOf, trailOf, snapshot };
}
