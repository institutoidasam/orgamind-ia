import { describe, it, expect } from 'vitest';
import {
  canBroadSend,
  canSendToSector,
  canViewDispatch,
  canSendToUser,
  isBroadSend,
  isTeamProvider,
  isTeamSender,
  TEAM_PROVIDERS,
  type TeamActor,
  type TeamTargetUser,
} from './team-whatsapp.policy';
import { actorWith } from '../../shared/authz/actor.test-fixtures';

const admin: TeamActor = {
  ...actorWith('ADMIN', { id: 'a' }),
  managedSectorIds: [],
};
const manager: TeamActor = {
  ...actorWith('OPERATOR', { id: 'm' }),
  managedSectorIds: ['s1'],
};
const plain: TeamActor = {
  ...actorWith('SUPERVISOR', { id: 'p' }),
  managedSectorIds: [],
};
// Rebaixado a VIEWER, mas ainda `managerId` do setor (o JWT antigo vale até 15 min).
const viewerManager: TeamActor = {
  ...actorWith('VIEWER', { id: 'm' }),
  managedSectorIds: ['s1'],
};
const inactiveManager: TeamActor = { ...manager, isActive: false };
const on = { isActive: true };
const off = { isActive: false };

describe('team-whatsapp policy — disparo amplo', () => {
  const ACTIVE = ['s1', 's2', 's3'];

  it.each<[string, string[], string[], boolean]>([
    ['alvo com todos os ativos', ['s1', 's2', 's3'], ACTIVE, true],
    ['alvo com 2 dos 3 ativos', ['s1', 's2'], ACTIVE, false],
    ['um único setor ativo, mesmo coberto', ['s1'], ['s1'], false],
    ['nenhum setor ativo', ['s1'], [], false],
    ['alvo vazio', [], ACTIVE, false],
    ['s1 repetido não cobre s3', ['s1', 's1', 's2'], ACTIVE, false],
    ['repetido com todos presentes', ['s1', 's1', 's2', 's3'], ACTIVE, true],
    ['id alheio não cobre s3', ['s1', 's2', 'x'], ACTIVE, false],
  ])('isBroadSend: %s', (_label, target, active, expected) => {
    expect(isBroadSend(target, active)).toBe(expected);
  });

  it('canBroadSend segue a chave equipe.disparo_amplo, não o papel', () => {
    const without: TeamActor = {
      ...actorWith('OPERATOR', { revoke: ['equipe.disparo_amplo'] }),
      managedSectorIds: ['s1'],
    };
    expect(canBroadSend(manager)).toBe(true);
    expect(canBroadSend(admin)).toBe(true);
    expect(canBroadSend(without)).toBe(false);
  });
});

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

  // Pessoa sem acesso (GC5) nunca é ator: nem ADMIN nem gestor de setor ativo.
  it.each<[string, TeamActor]>([
    ['ADMIN', { ...admin, hasAccess: false }],
    ['gestor com setor', { ...manager, hasAccess: false }],
  ])('isTeamSender falso sem acesso — %s', (_label, actor) => {
    expect(isTeamSender(actor)).toBe(false);
  });

  it('TEAM_PROVIDERS só traz os provedores ligados (D1)', () => {
    expect(TEAM_PROVIDERS).toEqual(['EVOLUTION']);
    expect(
      (['GOZAP', 'EVOLUTION', 'META', 'TWILIO', 'ZERNIO'] as const).map(
        isTeamProvider,
      ),
    ).toEqual([false, true, false, false, false]);
  });
});

describe('canViewDispatch (GC5)', () => {
  it.each<[string, TeamActor, string | null, boolean]>([
    ['ADMIN vê envio de outro autor', admin, 'x', true],
    ['ADMIN vê envio sem autor (apagado)', admin, null, true],
    ['gestor vê o próprio', manager, 'm', true],
    ['gestor não vê o de outro autor', manager, 'x', false],
    ['gestor não vê envio sem autor', manager, null, false],
  ])('%s', (_label, actor, authorId, esperado) => {
    expect(canViewDispatch(actor, { authorId })).toBe(esperado);
  });
});
