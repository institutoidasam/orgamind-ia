import { describe, expect, it } from 'vitest';
import {
  canChangeDemand,
  canCreateOrComment,
  canReadCommunication,
} from './internal-communications.policy';

const operatorA = {
  id: 'a',
  name: 'Ana',
  email: 'ana@example.test',
  role: 'OPERATOR' as const,
  sectorId: 'sector-a',
  isActive: true,
};
const demand = {
  authorId: 'creator',
  originSectorId: 'sector-a',
  destinationSectorId: 'sector-b',
  recipients: [{ sectorId: 'sector-c' }],
};

describe('internal communication policy', () => {
  it('scopes visibility to the involved sectors, author or admin', () => {
    expect(canReadCommunication(operatorA, demand)).toBe(true);
    expect(
      canReadCommunication({ ...operatorA, sectorId: 'sector-z' }, demand),
    ).toBe(false);
    expect(
      canReadCommunication(
        { ...operatorA, role: 'ADMIN', sectorId: null },
        demand,
      ),
    ).toBe(true);
  });

  it('rejects writes by a viewer or inactive user', () => {
    expect(canCreateOrComment({ ...operatorA, role: 'VIEWER' })).toBe(false);
    expect(canCreateOrComment({ ...operatorA, isActive: false })).toBe(false);
  });

  it('allows demand mutations only to destination staff or admins', () => {
    expect(
      canChangeDemand({ ...operatorA, sectorId: 'sector-b' }, demand),
    ).toBe(true);
    expect(canChangeDemand(operatorA, demand)).toBe(false);
    expect(
      canChangeDemand({ ...operatorA, role: 'ADMIN', sectorId: null }, demand),
    ).toBe(true);
  });
});
