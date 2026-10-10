import { describe, expect, it } from 'vitest';
import {
  createInternalCommunicationSchema,
  internalCommunicationListQuerySchema,
  updateDemandSchema,
} from './internal-communication.schema';

const base = {
  subject: 'Reposição de componentes',
  message: 'Precisamos confirmar o estoque para a próxima entrega.',
  originSectorId: 'sector-a',
  destinationSectorId: 'sector-b',
  ccSectorIds: ['sector-c'],
  notifyTeam: true,
  notifyAssignee: false,
  clientRequestId: '550e8400-e29b-41d4-a716-446655440000',
};

describe('internal communication contracts', () => {
  it('accepts a DEMAND with its task-only fields', () => {
    const parsed = createInternalCommunicationSchema.parse({
      ...base,
      kind: 'DEMAND',
      priority: 'HIGH',
      dueDate: '2026-10-31',
      assigneeId: 'user-b',
    });

    expect(parsed).toMatchObject({ kind: 'DEMAND', priority: 'HIGH' });
  });

  it('accepts an ANNOUNCEMENT without task-only fields', () => {
    const withoutFlags = {
      subject: base.subject,
      message: base.message,
      originSectorId: base.originSectorId,
      destinationSectorId: base.destinationSectorId,
      ccSectorIds: base.ccSectorIds,
      clientRequestId: base.clientRequestId,
    };
    expect(
      createInternalCommunicationSchema.parse({
        ...withoutFlags,
        kind: 'ANNOUNCEMENT',
      }),
    ).toMatchObject({
      kind: 'ANNOUNCEMENT',
      notifyTeam: true,
      notifyAssignee: true,
    });
  });

  it('rejects task fields on an ANNOUNCEMENT and duplicate destinations', () => {
    expect(() =>
      createInternalCommunicationSchema.parse({
        ...base,
        kind: 'ANNOUNCEMENT',
        priority: 'URGENT',
        ccSectorIds: ['sector-b'],
      }),
    ).toThrow();
  });

  it('accepts demand mutation guarded by expectedVersion', () => {
    expect(
      updateDemandSchema.parse({ expectedVersion: 3, status: 'COMPLETED' }),
    ).toMatchObject({ expectedVersion: 3, status: 'COMPLETED' });
  });

  it('rejects a demand mutation without expectedVersion', () => {
    expect(() => updateDemandSchema.parse({ status: 'OPEN' })).toThrow();
  });

  it('parses only explicit booleans for the unassigned query filter', () => {
    expect(
      internalCommunicationListQuerySchema.parse({ unassigned: 'false' })
        .unassigned,
    ).toBe(false);
    expect(
      internalCommunicationListQuerySchema.parse({ unassigned: 'true' })
        .unassigned,
    ).toBe(true);
    expect(() =>
      internalCommunicationListQuerySchema.parse({ unassigned: 'no' }),
    ).toThrow();
  });
});
