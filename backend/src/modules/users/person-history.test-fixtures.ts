import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** Cada lugar onde `personHasHistory` procura (A3/D7), por nome de teste. */
export const HISTORY_KINDS = [
  'destinatária de envio da equipe',
  'autora de envio da equipe',
  'autora de comunicado interno',
  'responsável por comunicado interno',
  'comentário em comunicado',
  'conversa atribuída',
  'escala (StaffSchedule)',
  'exceção de escala (StaffScheduleException)',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

type Db = PrismaClient;
// Quantas linhas ainda apontam para a pessoa: depois da recusa, tem de ser 1.
type Seeded = (db: Db, userId: string) => Promise<() => Promise<number>>;

const dispatch = (db: Db, authorId?: string) =>
  db.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 's-1',
      targetLabel: 'Produção',
      text: 'oi',
      authorId,
    },
  });

const communication = async (
  db: Db,
  who: { authorId?: string; assigneeId?: string },
) => {
  const tag = randomUUID().slice(0, 8);
  const [origin, destination] = await Promise.all([
    db.sector.create({ data: { name: `Origem ${tag}`, code: `O${tag}` } }),
    db.sector.create({ data: { name: `Destino ${tag}`, code: `D${tag}` } }),
  ]);
  return db.internalCommunication.create({
    data: {
      reference: `DM-${tag}`,
      clientRequestId: randomUUID(),
      kind: 'DEMAND',
      subject: 'Assunto',
      message: 'Texto',
      originSectorId: origin.id,
      destinationSectorId: destination.id,
      ...who,
    },
  });
};

const day = new Date('2026-10-19T00:00:00Z');

const SEEDERS: Record<HistoryKind, Seeded> = {
  'destinatária de envio da equipe': async (db, userId) => {
    const { id: dispatchId } = await dispatch(db);
    await db.teamWhatsappRecipient.create({
      data: { dispatchId, userId, userName: 'Maria' },
    });
    return () => db.teamWhatsappRecipient.count({ where: { userId } });
  },
  'autora de envio da equipe': async (db, userId) => {
    await dispatch(db, userId);
    return () => db.teamWhatsappDispatch.count({ where: { authorId: userId } });
  },
  'autora de comunicado interno': async (db, userId) => {
    await communication(db, { authorId: userId });
    return () =>
      db.internalCommunication.count({ where: { authorId: userId } });
  },
  'responsável por comunicado interno': async (db, userId) => {
    await communication(db, { assigneeId: userId });
    return () =>
      db.internalCommunication.count({ where: { assigneeId: userId } });
  },
  'comentário em comunicado': async (db, userId) => {
    const { id: communicationId } = await communication(db, {});
    await db.internalEvent.create({
      data: {
        communicationId,
        kind: 'COMMENTED',
        message: 'ok',
        actorId: userId,
      },
    });
    return () => db.internalEvent.count({ where: { actorId: userId } });
  },
  'conversa atribuída': async (db, userId) => {
    const channel = await db.channel.create({ data: { name: randomUUID() } });
    await db.conversation.create({
      data: {
        instanceId: channel.id,
        remoteJid: `${randomUUID()}@s.whatsapp.net`,
        assignedUserId: userId,
      },
    });
    return () => db.conversation.count({ where: { assignedUserId: userId } });
  },
  'escala (StaffSchedule)': async (db, userId) => {
    await db.staffSchedule.create({
      data: { userId, template: 'CUSTOM', startDate: day, cycleLength: 1 },
    });
    return () => db.staffSchedule.count({ where: { userId } });
  },
  'exceção de escala (StaffScheduleException)': async (db, userId) => {
    await db.staffScheduleException.create({
      data: { userId, kind: 'VACATION', startDate: day, endDate: day },
    });
    return () => db.staffScheduleException.count({ where: { userId } });
  },
};

/** Grava um registro do tipo dado ligado à pessoa e devolve o contador dele. */
export const seedHistory = (db: Db, kind: HistoryKind, userId: string) =>
  SEEDERS[kind](db, userId);

/** Só marcadores que NÃO contam como histórico (leitura e evento que não é comentário). */
export async function seedNonHistory(db: Db, userId: string): Promise<void> {
  const { id: communicationId } = await communication(db, {});
  await db.internalRead.create({ data: { communicationId, userId } });
  await db.internalEvent.create({
    data: { communicationId, kind: 'STATUS_CHANGED', actorId: userId },
  });
}
