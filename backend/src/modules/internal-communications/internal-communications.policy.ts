import type { Role } from '@prisma/client';

export type InternalActor = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  sectorId: string | null;
  isActive: boolean;
  sector?: { id: string; name: string; code: string } | null;
};

type VisibleCommunication = {
  authorId: string | null;
  originSectorId: string;
  destinationSectorId: string;
  recipients: Array<{ sectorId: string }>;
};

export function canCreateOrComment(actor: InternalActor): boolean {
  return actor.isActive && actor.role !== 'VIEWER';
}

export function canReadCommunication(
  actor: InternalActor,
  communication: VisibleCommunication,
): boolean {
  if (!actor.isActive) return false;
  if (actor.role === 'ADMIN' || communication.authorId === actor.id)
    return true;
  if (!actor.sectorId) return false;
  return involvedSectorIds(communication).has(actor.sectorId);
}

export function canChangeDemand(
  actor: InternalActor,
  communication: VisibleCommunication,
): boolean {
  if (!canCreateOrComment(actor)) return false;
  return (
    actor.role === 'ADMIN' ||
    actor.sectorId === communication.destinationSectorId
  );
}

function involvedSectorIds(communication: VisibleCommunication): Set<string> {
  return new Set([
    communication.originSectorId,
    communication.destinationSectorId,
    ...communication.recipients.map((recipient) => recipient.sectorId),
  ]);
}
