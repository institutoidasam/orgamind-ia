import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  MANAGER,
  SUPPRESSED,
  createHarness,
  member,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

const ana = member({ id: 'ana', name: 'Ana', shift: 'FIRST' });
const joao = member({ id: 'joao', name: 'João', shift: 'SECOND' });
const maria = member({ id: 'maria', name: 'Maria', shift: 'SECOND' });
const pedro = member({
  id: 'pedro',
  name: 'Pedro',
  shift: 'SECOND',
  phoneE164: null,
});
const ze = member({ id: 'ze', name: 'Zé', shift: null });
const producao = (members = [ana, joao, maria, pedro, ze]) =>
  sector({ id: 's1', name: 'Produção', members });

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSectorWithActiveMembers.mockResolvedValue(producao());
});

type SectorExtra = { shift?: 'FIRST' | 'SECOND'; userIds?: string[] };
const send = (extra: SectorExtra, actorId = ADMIN.id) =>
  h.service.dispatch(actorId, {
    channelId: 'c1',
    text: 'Oi',
    target: { type: 'sector', sectorId: 's1', ...extra },
  });
const created = () => h.repo.createDispatch.mock.calls[0][0];
const names = () => created().recipients.map((r) => r.userName);
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
const expectInvalidSelection = async (extra: SectorExtra) => {
  await expect(send(extra)).rejects.toMatchObject({
    code: 'team_whatsapp.invalid_selection',
    status: 422,
  });
  expectNothingCreated();
};

// Três describes (≤ 50 linhas cada): filtro e rótulo / seleção inválida R1+R2 / R4 + alvo pessoa.
describe('dispatch — setor e turno: filtro e rótulo', () => {
  it('seleção João e Maria no 2º turno cria só os dois, com snapshot e rótulo', async () => {
    await send({ shift: 'SECOND', userIds: ['joao', 'maria'] });
    expect(names()).toEqual(['João', 'Maria']);
    expect(created()).toMatchObject({
      shift: 'SECOND',
      targetLabel: 'Produção · 2º turno · seleção de 2',
    });
    expect(created().recipients.map((r) => r.shift)).toEqual([
      'SECOND',
      'SECOND',
    ]);
  });

  it('todos do 2º turno: os do turno entram e quem não tem telefone é pulado', async () => {
    const res = await send({ shift: 'SECOND' });
    expect(names()).toEqual(['João', 'Maria', 'Pedro']);
    expect(created().targetLabel).toBe('Produção · 2º turno');
    expect(res.skipped).toEqual([
      { userId: 'pedro', name: 'Pedro', reason: 'NO_PHONE' },
    ]);
  });

  it.each([
    [
      undefined,
      ['Ana', 'João', 'Maria', 'Pedro', 'Zé'],
      'Produção · todos os turnos',
      null,
    ],
    ['FIRST' as const, ['Ana'], 'Produção · 1º turno', 'FIRST'],
  ])(
    'filtro de turno %s (R3: sem turno só entra em "todos")',
    async (shift, expected, label, snap) => {
      await send(shift ? { shift } : {});
      expect(names()).toEqual(expected);
      expect(created()).toMatchObject({ targetLabel: label, shift: snap });
      const zeShift = created().recipients.find(
        (r) => r.userId === 'ze',
      )?.shift;
      expect(zeShift).toBe(shift ? undefined : null);
    },
  );
});

describe('dispatch — setor e turno: seleção inválida (R1, R2)', () => {
  it.each([
    ['de outro setor', ['joao', 'fora-do-setor']],
    ['de outro turno', ['joao', 'ana']],
    ['inexistente', ['nao-existe']],
    ['inativo', ['inativo']],
  ])('seleção inválida (%s) → 422 sem efeito (R1)', async (_caso, userIds) => {
    const inativo = member({ id: 'inativo', shift: 'SECOND', isActive: false });
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      producao([ana, joao, maria, inativo]),
    );
    await expectInvalidSelection({ shift: 'SECOND', userIds });
  });

  it('gestor fora da política com userIds → 403 antes da seleção (R1)', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER); // gerencia só s1
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      sector({ id: 's2', name: 'Outro', members: [joao] }),
    );
    await expect(
      h.service.dispatch(MANAGER.id, {
        channelId: 'c1',
        text: 'Oi',
        target: { type: 'sector', sectorId: 's2', userIds: ['joao'] },
      }),
    ).rejects.toMatchObject({ code: 'team_whatsapp.forbidden', status: 403 });
    expectNothingCreated();
  });

  it('turno mudou depois de carregar a tela → 422, nada parcial (R2)', async () => {
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      producao([member({ ...joao, shift: 'FIRST' }), maria]),
    );
    await expectInvalidSelection({
      shift: 'SECOND',
      userIds: ['joao', 'maria'],
    });
    expect(h.repo.findChannel.mock.calls).toHaveLength(0);
  });
});

describe('dispatch — setor e turno: sem telefone, suprimido e alvo pessoa (R4)', () => {
  it('seleção com sem telefone, suprimido e id repetido (R4)', async () => {
    const bia = member({
      id: 'bia',
      name: 'Bia',
      shift: 'SECOND',
      phoneE164: SUPPRESSED,
    });
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      producao([joao, pedro, bia]),
    );
    const res = await send({
      shift: 'SECOND',
      userIds: ['joao', 'pedro', 'bia', 'joao'],
    });
    expect(created().recipients).toHaveLength(3);
    expect(created().targetLabel).toBe('Produção · 2º turno · seleção de 3');
    expect(h.queue.addBulk.mock.calls[0][0]).toHaveLength(1);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual([
      'NO_PHONE',
      'SUPPRESSED',
    ]);
  });

  it('alvo pessoa grava dispatch.shift null e o turno atual do destinatário', async () => {
    h.repo.findTargetUser.mockResolvedValue(joao);
    await h.service.dispatch(ADMIN.id, {
      channelId: 'c1',
      text: 'Oi',
      target: { type: 'user', userId: 'joao' },
    });
    expect(created()).toMatchObject({ shift: null, targetLabel: 'João' });
    expect(created().recipients[0].shift).toBe('SECOND');
  });
});
