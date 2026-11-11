import { describe, it, expect, beforeEach } from 'vitest';
import type { TeamMember } from './team-whatsapp.repository';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import {
  ADMIN,
  MANAGER,
  NO_SNAPSHOT,
  PHONE,
  SHIFT_FIRST,
  SUPPRESSED,
  createHarness,
  givenNumber,
  givenSector,
  member,
  numberRow,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

const TEXT = 'Reunião às 15h na sala 2';
const toUser = (userId = 'u1'): CreateTeamDispatchInput => ({
  text: TEXT,
  target: { type: 'user', userId },
});
const toSector = (sectorId = 's1'): CreateTeamDispatchInput => ({
  text: TEXT,
  target: { type: 'sector', sectorIds: [sectorId], date: '2026-10-21' },
});
// Membro no 1º turno do cadastro: "Todos os turnos" só alcança quem tem WORK no dia (D2).
const onDuty = (over: Partial<TeamMember> = {}) =>
  member({ ...onShift(SHIFT_FIRST), ...over });
const FIRST = { shiftId: SHIFT_FIRST.id, shiftName: SHIFT_FIRST.name };

let h: Harness;
beforeEach(() => {
  h = createHarness();
  // Toda área tem o número `c1`; a pessoa do alvo pessoa atua em `s1` (D8).
  givenNumber(h);
  h.repo.findSector.mockResolvedValue(sector());
});

async function expectRejected(
  input: CreateTeamDispatchInput,
  code: string,
  status: number,
) {
  await expect(h.service.dispatch('x', input)).rejects.toMatchObject({
    code,
    status,
  });
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
}
const expectForbidden = (input: CreateTeamDispatchInput) =>
  expectRejected(input, 'team_whatsapp.forbidden', 403);

describe('TeamWhatsappService.dispatch — remetente fora da política (403)', () => {
  it('remetente inexistente recebe 403', async () => {
    h.repo.findActor.mockResolvedValue(null);
    await expectForbidden(toSector());
  });

  it('remetente inativo recebe 403', async () => {
    h.repo.findActor.mockResolvedValue({ ...MANAGER, isActive: false });
    h.repo.findSector.mockResolvedValue(sector());
    await expectForbidden(toSector());
  });

  it('gestor rebaixado a VIEWER recebe 403', async () => {
    h.repo.findActor.mockResolvedValue({ ...MANAGER, role: 'VIEWER' });
    h.repo.findSector.mockResolvedValue(sector());
    await expectForbidden(toSector());
  });

  it('SUPERVISOR sem setor gerido recebe 403', async () => {
    h.repo.findActor.mockResolvedValue({
      ...MANAGER,
      role: 'SUPERVISOR',
      managedSectorIds: [],
    });
    h.repo.findTargetUser.mockResolvedValue(member());
    await expectForbidden(toUser());
  });

  it('política vem antes do número: não consulta número nem provedor de quem não pode', async () => {
    h.repo.findActor.mockResolvedValue(null);
    await expectForbidden(toUser());
    expect(h.repo.findSectorChannels.mock.calls).toHaveLength(0);
    expect(h.live.checkMany.mock.calls).toHaveLength(0);
  });
});

describe('TeamWhatsappService.dispatch — alvo fora da política (403)', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(MANAGER));

  it('gestor enviando a setor que não gerencia recebe 403', async () => {
    h.repo.findSector.mockResolvedValue(sector({ id: 's2' }));
    await expectForbidden(toSector('s2'));
  });

  it('gestor enviando a usuário de outro setor recebe 403', async () => {
    h.repo.findTargetUser.mockResolvedValue(member({ sectorId: 's2' }));
    await expectForbidden(toUser());
  });

  it('setor desativado depois de carregar a tela recebe 403', async () => {
    h.repo.findSector.mockResolvedValue(sector({ isActive: false }));
    await expectForbidden(toSector());
  });

  it('gestor → usuário de setor desativado → 403', async () => {
    // O mock ignora o filtro de findActor: a política checa o setor do ALVO.
    h.repo.findTargetUser.mockResolvedValue(
      member({ sector: { isActive: false } }),
    );
    await expectForbidden(toUser());
  });

  it('alvo inexistente ou inativo recebe 403', async () => {
    h.repo.findTargetUser.mockResolvedValueOnce(null);
    await expectForbidden(toUser('nope'));
    h.repo.findTargetUser.mockResolvedValueOnce(member({ isActive: false }));
    await expectForbidden(toUser());
    h.repo.findSector.mockResolvedValueOnce(null);
    await expectForbidden(toSector('nope'));
  });
});

describe('TeamWhatsappService.dispatch — sem destinatário válido (422)', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(MANAGER));

  it('pessoa sem telefone → 422 no_recipients e nada criado', async () => {
    h.repo.findTargetUser.mockResolvedValue(member({ phoneE164: null }));
    await expectRejected(toUser(), 'team_whatsapp.no_recipients', 422);
  });

  it('pessoa em supressão → 422 no_recipients e nada criado', async () => {
    h.repo.findTargetUser.mockResolvedValue(member({ phoneE164: SUPPRESSED }));
    await expectRejected(toUser(), 'team_whatsapp.no_recipients', 422);
  });

  it('setor sem destinatário válido → 422 no_recipients e nada criado', async () => {
    const members = [
      onDuty({ phoneE164: null }),
      onDuty({ id: 'u2', phoneE164: null }),
    ];
    givenSector(h, members);
    await expectRejected(toSector(), 'team_whatsapp.no_recipients', 422);
  });

  it('supressão usa o telefone do contato ligado antes do do usuário', async () => {
    const linked = member({
      phoneE164: PHONE,
      contact: { phoneE164: SUPPRESSED },
    });
    h.repo.findTargetUser.mockResolvedValue(linked);
    await expectRejected(toUser(), 'team_whatsapp.no_recipients', 422);
    expect(h.consent.isSuppressed.mock.calls).toContainEqual([SUPPRESSED]);
  });
});

describe('TeamWhatsappService.dispatch — setor enfileira e pula', () => {
  beforeEach(() => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    const members = [
      onDuty({ id: 'u1', name: 'Ana' }),
      onDuty({
        id: 'u2',
        name: null,
        email: 'bia@idasam.org',
        phoneE164: null,
      }),
      onDuty({ id: 'u3', name: 'Caio', phoneE164: SUPPRESSED }),
    ];
    givenSector(h, members);
  });

  it('enfileira quem tem telefone e pula NO_PHONE/SUPPRESSED', async () => {
    await expect(h.service.dispatch('m', toSector())).resolves.toEqual({
      dispatchId: 'd1',
      queued: 1,
      scheduled: 0,
      scheduledFor: null,
      skipped: [
        { userId: 'u2', name: 'bia@idasam.org', reason: 'NO_PHONE' },
        { userId: 'u3', name: 'Caio', reason: 'SUPPRESSED' },
      ],
    });
    expect(h.queue.addBulk.mock.calls).toContainEqual([
      [{ name: 'send', data: { recipientId: 'r1' }, opts: { jobId: 'r1' } }],
    ]);
  });
});

// Ana entra; Bia (sem nome nem telefone) e Caio (suprimido) são pulados.
const recordedMembers = () => [
  onDuty({ id: 'u1', name: 'Ana' }),
  onDuty({
    id: 'u2',
    name: null,
    email: 'bia@idasam.org',
    phoneE164: null,
  }),
  onDuty({ id: 'u3', name: 'Caio', phoneE164: SUPPRESSED }),
];

// T7 (C6): setor em que a pessoa entrou; nível só a partir da T8b.
const FIN_SNAPSHOT = {
  sectorId: 's1',
  sectorName: 'Financeiro',
  levelName: null,
};
// T8 (D3): o número da área, em cada destinatário (inclusive o pulado).
const NUMBER = {
  channelId: 'c1',
  channelName: numberRow().name,
  channelPhoneE164: numberRow().phoneE164,
};

describe('TeamWhatsappService.dispatch — setor grava o envio', () => {
  beforeEach(() => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    givenSector(h, recordedMembers());
  });

  it('grava o envio com o alvo e um destinatário por pessoa, sem telefone', async () => {
    await h.service.dispatch('m', toSector());
    const data = h.repo.createDispatch.mock.calls[0][0];
    expect(data).toMatchObject({
      authorId: 'm',
      targetType: 'SECTOR',
      targetId: 's1',
      targetLabel: 'Financeiro · todos os turnos · 21/10',
      ...NO_SNAPSHOT,
      channelId: 'c1',
      text: TEXT,
    });
    expect(data.recipients).toEqual([
      {
        userId: 'u1',
        userName: 'Ana',
        ...FIRST,
        status: 'QUEUED',
        skipReason: null,
        ...FIN_SNAPSHOT,
        ...NUMBER,
      },
      {
        userId: 'u2',
        userName: 'bia@idasam.org',
        ...FIRST,
        status: 'SKIPPED',
        skipReason: 'NO_PHONE',
        ...FIN_SNAPSHOT,
        ...NUMBER,
      },
      {
        userId: 'u3',
        userName: 'Caio',
        ...FIRST,
        status: 'SKIPPED',
        skipReason: 'SUPPRESSED',
        ...FIN_SNAPSHOT,
        ...NUMBER,
      },
    ]);
  });
});

describe('TeamWhatsappService.dispatch — setor audita contagens', () => {
  beforeEach(() => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    const members = [
      onDuty({ id: 'u1', name: 'Ana' }),
      onDuty({
        id: 'u2',
        name: null,
        email: 'bia@idasam.org',
        phoneE164: null,
      }),
      onDuty({ id: 'u3', name: 'Caio', phoneE164: SUPPRESSED }),
    ];
    givenSector(h, members);
  });

  it('audita contagens sem texto nem telefone', async () => {
    await h.service.dispatch('m', toSector());
    expect(h.audit.log.mock.calls).toContainEqual([
      'team_whatsapp.dispatch',
      'TeamWhatsappDispatch',
      'd1',
      {
        actorId: 'm',
        targetType: 'SECTOR',
        targetId: 's1',
        sectorIds: ['s1'],
        channelIds: ['c1'],
        queued: 1,
        skipped: 2,
      },
    ]);
    const logged = JSON.stringify(h.audit.log.mock.calls);
    for (const secret of [TEXT, PHONE, SUPPRESSED])
      expect(logged).not.toContain(secret);
  });
});

describe('TeamWhatsappService.dispatch — ADMIN e falha da fila', () => {
  it('ADMIN envia a um usuário', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    h.repo.findTargetUser.mockResolvedValue(member());
    await expect(h.service.dispatch('a', toUser())).resolves.toEqual({
      dispatchId: 'd1',
      queued: 1,
      scheduled: 0,
      scheduledFor: null,
      skipped: [],
    });
    expect(h.repo.createDispatch.mock.calls[0][0]).toMatchObject({
      targetType: 'USER',
      targetId: 'u1',
      targetLabel: 'Ana',
    });
  });

  it('falha ao enfileirar marca os QUEUED como FAILED e relança', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    h.repo.findTargetUser.mockResolvedValue(member());
    h.queue.addBulk.mockRejectedValue(new Error('redis'));
    await expect(h.service.dispatch('a', toUser())).rejects.toThrow('redis');
    expect(h.repo.markFailed.mock.calls).toContainEqual([
      ['r1'],
      'team_whatsapp.queue_unavailable',
    ]);
    expect(h.audit.log.mock.calls).toHaveLength(0);
  });
});
