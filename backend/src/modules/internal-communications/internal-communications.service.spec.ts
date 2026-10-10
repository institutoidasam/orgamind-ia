import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { CreateInternalCommunication } from '../../schemas/contracts/internal-communication.schema';
import { InternalCommunicationsService } from './internal-communications.service';
import type { InternalActor } from './internal-communications.policy';

const actor: InternalActor = {
  id: 'author-1',
  name: 'Ana',
  email: 'ana@example.test',
  role: 'OPERATOR' as const,
  sectorId: 'sector-a',
  isActive: true,
  sector: { id: 'sector-a', name: 'Compras', code: 'COM' },
};

const input: CreateInternalCommunication = {
  kind: 'DEMAND' as const,
  subject: 'Reposição',
  message: 'Confirmar estoque',
  originSectorId: 'sector-a',
  destinationSectorId: 'sector-b',
  ccSectorIds: ['sector-c'],
  notifyTeam: true,
  notifyAssignee: true,
  clientRequestId: '550e8400-e29b-41d4-a716-446655440000',
  priority: 'HIGH' as const,
  dueDate: '2026-10-31',
};

type TestableService = {
  createdSnapshot(
    value: InternalActor,
    request: CreateInternalCommunication,
  ): Prisma.InputJsonValue;
  assertIdempotentRepeat(
    row: {
      id: string;
      authorId: string | null;
      events: Array<{ actorSnapshot: Prisma.JsonValue | null }>;
    },
    value: InternalActor,
    request: CreateInternalCommunication,
  ): string;
};

describe('InternalCommunicationsService idempotency', () => {
  it('returns the same creation even after mutable demand fields change', () => {
    const service = new InternalCommunicationsService(
      {} as never,
    ) as unknown as TestableService;
    const snapshot = service.createdSnapshot(actor, input) as Prisma.JsonValue;
    const row = {
      id: 'communication-1',
      authorId: actor.id,
      events: [{ actorSnapshot: snapshot }],
    };

    expect(service.assertIdempotentRepeat(row, actor, input)).toBe(
      'communication-1',
    );
  });

  it('rejects reusing the request ID with a different original payload', () => {
    const service = new InternalCommunicationsService(
      {} as never,
    ) as unknown as TestableService;
    const snapshot = service.createdSnapshot(actor, input) as Prisma.JsonValue;
    const row = {
      id: 'communication-1',
      authorId: actor.id,
      events: [{ actorSnapshot: snapshot }],
    };

    expect(() =>
      service.assertIdempotentRepeat(row, actor, {
        ...input,
        subject: 'Outro',
      }),
    ).toThrow('A requisição já foi usada com outro conteúdo.');
  });
});
