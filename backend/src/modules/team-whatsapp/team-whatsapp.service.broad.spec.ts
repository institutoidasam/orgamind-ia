import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { TeamActor } from './team-whatsapp.policy';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import {
  createHarness,
  dayPerson,
  givenNumber,
  member,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';
import { withAudienceKey } from './team-whatsapp.sector-send.test-fixtures';

// Noite de 21/10 começa às 22:00 de Manaus, depois do "agora" fixado abaixo.
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};

// Disparo amplo (B4/DB9): envio por setor que cobre todos os setores ativos da
// organização, havendo mais de um. Sem `equipe.disparo_amplo` é 403 antes de qualquer gravação.
const DENIED_TEXT =
  'Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador.';
const ACTIVE = ['ti', 'op', 'rh'];
const WITHOUT_KEY = { revoke: ['equipe.disparo_amplo'] } as const;

const operator = (
  managed: readonly string[],
  withoutKey = false,
): TeamActor => ({
  ...actorWith('OPERATOR', { id: 'm', ...(withoutKey ? WITHOUT_KEY : {}) }),
  managedSectorIds: managed,
});
const toSectors = (
  sectorIds: string[],
  when?: 'now' | 'shift_start',
): CreateTeamDispatchInput => ({
  text: 'Oi',
  purpose: 'shift_notice',
  ...(when ? { when } : {}),
  target: {
    type: 'sector',
    sectorIds,
    date: '2026-10-21',
    shiftIds: [NOITE.id],
  },
});
// `expectError`: o teste espera o 403 do público (a chave sai de zeros).
const sendTo = async (
  sectorIds: string[],
  when?: 'now' | 'shift_start',
  expectError = false,
) =>
  h.service.dispatch(
    'm',
    await withAudienceKey(h, 'm', toSectors(sectorIds, when), { expectError }),
  );
const person = (sectorId: string) =>
  dayPerson({
    id: `u-${sectorId}`,
    sectorId,
    sector: { isActive: true },
    ...onShift(NOITE),
  });

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  h = createHarness();
  givenNumber(h);
  h.repo.listActiveShifts.mockResolvedValue([NOITE]);
  h.repo.listActiveSectorIds.mockResolvedValue(ACTIVE);
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve(ACTIVE.includes(id) ? sector({ id, name: id }) : null),
  );
  h.repo.loadDayPeople.mockImplementation((id) =>
    Promise.resolve([person(id)]),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};

describe('disparo amplo', () => {
  it('matriz inicial: OPERATOR gestor de todos os setores ativos envia a todos', async () => {
    h.repo.findActor.mockResolvedValue(operator(ACTIVE));
    await expect(sendTo(ACTIVE)).resolves.toMatchObject({
      dispatchId: 'd1',
      queued: 3,
    });
    expect(h.repo.createDispatch.mock.calls).toHaveLength(1);
  });

  it.each([undefined, 'shift_start'] as const)(
    'sem equipe.disparo_amplo, alvo com todos os ativos → 403 broad_send_denied e createDispatch não é chamado (when %s)',
    async (when) => {
      h.repo.findActor.mockResolvedValue(operator(ACTIVE, true));
      await expect(sendTo(ACTIVE, when, true)).rejects.toMatchObject({
        status: 403,
        code: 'team_whatsapp.broad_send_denied',
        message: DENIED_TEXT,
      });
      expectNothingCreated();
      // Antes de `requireNumbers`: nem chegou a procurar número de área.
      expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
    },
  );
});

describe('disparo amplo — o que não é amplo ou não chega a ser conferido', () => {
  it('sem a chave, subconjunto passa; id repetido não cobre o setor que falta', async () => {
    h.repo.findActor.mockResolvedValue(operator(ACTIVE, true));
    await sendTo(['ti', 'op']);
    await sendTo(['ti', 'ti', 'op']);
    expect(h.repo.createDispatch.mock.calls).toHaveLength(2);
  });

  it('o alcance vem antes: setor fora dos que o ator gerencia é team_whatsapp.forbidden', async () => {
    h.repo.findActor.mockResolvedValue(operator(['ti'], true));
    await expect(sendTo(ACTIVE, undefined, true)).rejects.toMatchObject({
      status: 403,
      code: 'team_whatsapp.forbidden',
    });
    expectNothingCreated();
  });

  it('alvo user nunca é amplo', async () => {
    h.repo.findActor.mockResolvedValue(operator(['ti'], true));
    h.repo.findTargetUser.mockResolvedValue(member({ sectorId: 'ti' }));
    await expect(
      h.service.dispatch('m', {
        text: 'Oi',
        target: { type: 'user', userId: 'u1' },
      }),
    ).resolves.toMatchObject({ dispatchId: 'd1' });
  });
});

describe('disparo amplo — limite de um setor ativo só', () => {
  it('sem a chave, cobrir o único setor ativo não é disparo amplo', async () => {
    h.repo.listActiveSectorIds.mockResolvedValue(['ti']);
    h.repo.findActor.mockResolvedValue(operator(['ti'], true));
    await expect(sendTo(['ti'])).resolves.toMatchObject({
      dispatchId: 'd1',
    });
    expect(h.repo.createDispatch.mock.calls).toHaveLength(1);
  });
});
