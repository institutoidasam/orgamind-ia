import { describe, it, expect } from 'vitest';
import {
  canSendToSector,
  canSendToUser,
  isTeamProvider,
  isTeamSender,
  TEAM_PROVIDERS,
  type TeamActor,
  type TeamTargetUser,
} from './team-whatsapp.policy';

const admin: TeamActor = {
  id: 'a',
  role: 'ADMIN',
  isActive: true,
  managedSectorIds: [],
};
const manager: TeamActor = {
  id: 'm',
  role: 'OPERATOR',
  isActive: true,
  managedSectorIds: ['s1'],
};
const plain: TeamActor = {
  id: 'p',
  role: 'SUPERVISOR',
  isActive: true,
  managedSectorIds: [],
};
// Rebaixado a VIEWER, mas ainda `managerId` do setor (o JWT antigo vale até 15 min).
const viewerManager: TeamActor = { ...manager, role: 'VIEWER' };
const inactiveManager: TeamActor = { ...manager, isActive: false };
const on = { isActive: true };
const off = { isActive: false };

describe('team-whatsapp policy — setor', () => {
  it.each<[TeamActor, { id: string; isActive: boolean }, boolean]>([
    [admin, { id: 's9', isActive: true }, true],
    [admin, { id: 's9', isActive: false }, false],
    [manager, { id: 's1', isActive: true }, true],
    [manager, { id: 's1', isActive: false }, false],
    [manager, { id: 's2', isActive: true }, false],
    [inactiveManager, { id: 's1', isActive: true }, false],
    [plain, { id: 's1', isActive: true }, false],
    [viewerManager, { id: 's1', isActive: true }, false],
  ])('canSendToSector #%#', (actor, sector, ok) => {
    expect(canSendToSector(actor, sector)).toBe(ok);
  });
});

describe('team-whatsapp policy — usuário', () => {
  it.each<[TeamActor, TeamTargetUser, boolean]>([
    [admin, { isActive: true, sectorId: null, sector: null }, true],
    [admin, { isActive: false, sectorId: 's1', sector: on }, false],
    [manager, { isActive: true, sectorId: 's1', sector: on }, true],
    [manager, { isActive: true, sectorId: 's1', sector: off }, false],
    [manager, { isActive: true, sectorId: 's1', sector: null }, false],
    [manager, { isActive: true, sectorId: 's2', sector: on }, false],
    [manager, { isActive: true, sectorId: null, sector: null }, false],
    [manager, { isActive: false, sectorId: 's1', sector: on }, false],
    [inactiveManager, { isActive: true, sectorId: 's1', sector: on }, false],
    [plain, { isActive: true, sectorId: 's1', sector: on }, false],
    [viewerManager, { isActive: true, sectorId: 's1', sector: on }, false],
  ])('canSendToUser #%#', (actor, target, ok) => {
    expect(canSendToUser(actor, target)).toBe(ok);
  });
});

describe('team-whatsapp policy — remetente', () => {
  it('isTeamSender: ADMIN ativo ou gestor ativo com papel de escrita', () => {
    expect(
      [admin, manager, plain, viewerManager, inactiveManager].map(isTeamSender),
    ).toEqual([true, true, false, false, false]);
  });

  it('ADMIN inativo não envia', () => {
    expect(isTeamSender({ ...admin, isActive: false })).toBe(false);
  });

  it('TEAM_PROVIDERS só traz os provedores não oficiais', () => {
    expect(TEAM_PROVIDERS).toEqual(['GOZAP', 'EVOLUTION']);
    expect(
      (['GOZAP', 'EVOLUTION', 'META', 'TWILIO', 'ZERNIO'] as const).map(
        isTeamProvider,
      ),
    ).toEqual([true, true, false, false, false]);
  });
});
