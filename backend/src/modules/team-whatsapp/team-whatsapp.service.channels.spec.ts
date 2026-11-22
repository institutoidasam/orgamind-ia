import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../whatsapp-providers/channel-live-state.service';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import { createTeamDispatchSchema } from './dto/create-team-dispatch.dto';
import {
  ADMIN,
  SHIFT_FIRST,
  createHarness,
  dayPerson,
  givenLive,
  givenNumbers,
  member,
  numberRow,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

// Número por área (D3/GC7): cada pessoa sai pelo número da área em que aparece
// na data; área sem número ou número não aberto trava o envio inteiro.
const DATE = '2026-10-21';
const TOMORROW = '2026-10-22';
const LOG = sector({ id: 'log', name: 'Logística' });
const EXP = sector({ id: 'exp', name: 'Expedição' });
const N1111 = numberRow({
  id: 'c1',
  name: 'Número 1111',
  phoneE164: '+559211111111',
});
const N2222 = numberRow({
  id: 'c2',
  name: 'Número 2222',
  phoneE164: '+559222222222',
});
const snapshotOf = (n: typeof N1111) => ({
  channelId: n.id,
  channelName: n.name,
  channelPhoneE164: n.phoneE164,
});
const onDuty = (id: string, name: string, sectorId: string) =>
  dayPerson({
    id,
    name,
    sectorId,
    sector: { isActive: true },
    ...onShift(SHIFT_FIRST),
  });
const borrowedBy = (sectorId: string): ScheduleExceptionInput => ({
  id: `ex-${sectorId}`,
  kind: 'OTHER_SECTOR',
  startDate: DATE,
  endDate: DATE,
  shiftId: SHIFT_FIRST.id,
  sectorId,
});

// Ana é da Logística; Rafael, da Expedição; Bruno é da Logística, mas hoje
// trabalha na Expedição (o repositório o devolve nas duas listas).
const ANA = onDuty('ana', 'Ana', 'log');
const RAFAEL = onDuty('rafael', 'Rafael', 'exp');
const BRUNO = {
  ...onDuty('bruno', 'Bruno', 'log'),
  exceptions: [borrowedBy('exp')],
};

const toSectors = (
  extra: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
) =>
  createTeamDispatchSchema.parse({
    text: 'Oi',
    ...body,
    target: {
      type: 'sector',
      sectorIds: ['log', 'exp'],
      date: DATE,
      ...extra,
    },
  });
const toUser = () =>
  createTeamDispatchSchema.parse({
    text: 'Oi',
    target: { type: 'user', userId: 'nelson' },
  });

let h: Harness;
const created = () => h.repo.createDispatch.mock.calls[0][0];
const channelsOf = () =>
  created().recipients.map((r) => [r.userId, r.channelId]);
const expectNothingDone = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};
const refused = async (
  promise: Promise<unknown>,
  code: string,
  status = 422,
) => {
  await expect(promise).rejects.toMatchObject({ code, status });
  expectNothingDone();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSector.mockImplementation((id) =>
    Promise.resolve([LOG, EXP].find((s) => s.id === id) ?? null),
  );
  h.repo.loadDayPeople.mockImplementation((id) =>
    Promise.resolve([ANA, RAFAEL].filter((p) => p.sectorId === id)),
  );
  givenNumbers(h, { log: N1111, exp: N2222 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('número de cada pessoa (D3)', () => {
  it('Logística (1111) + Expedição (2222): cada destinatário sai pelo número do seu setor e o envio fica sem canal único', async () => {
    await h.service.dispatch(ADMIN.id, toSectors());
    expect(created().channelId).toBeNull();
    expect(created().recipients).toMatchObject([
      { userId: 'rafael', ...snapshotOf(N2222) },
      { userId: 'ana', ...snapshotOf(N1111) },
    ]);
    // Auditoria só com ids e contagens: os dois números, sem telefone nem nome.
    expect(h.audit.log.mock.calls[0][3]).toMatchObject({
      channelIds: ['c2', 'c1'],
      queued: 2,
    });
    expect(JSON.stringify(h.audit.log.mock.calls)).not.toContain('+5592');
  });

  it('remanejado de Logística para Expedição recebe pelo 2222', async () => {
    h.repo.loadDayPeople.mockResolvedValue([ANA, BRUNO]);
    await h.service.dispatch(ADMIN.id, toSectors());
    expect(channelsOf()).toEqual([
      ['bruno', 'c2'],
      ['ana', 'c1'],
    ]);
  });

  it('dois setores com o mesmo número: dispatch.channelId é esse número, consultado uma vez', async () => {
    givenNumbers(h, { log: N1111, exp: N1111 });
    await h.service.dispatch(ADMIN.id, toSectors());
    expect(created().channelId).toBe('c1');
    expect(h.live.checkMany.mock.calls).toHaveLength(1);
    expect(h.live.checkMany.mock.calls[0][0].map((c) => c.id)).toEqual(['c1']);
  });
});

describe('destinatário e corpo do pedido', () => {
  it('pulado também guarda o número do seu setor', async () => {
    h.repo.loadDayPeople.mockResolvedValue([
      ANA,
      { ...RAFAEL, phoneE164: null },
    ]);
    await h.service.dispatch(ADMIN.id, toSectors());
    expect(created().recipients).toMatchObject([
      { userId: 'rafael', status: 'SKIPPED', ...snapshotOf(N2222) },
      { userId: 'ana', status: 'QUEUED', ...snapshotOf(N1111) },
    ]);
  });

  it('channelId no corpo apontando para outro canal é ignorado', async () => {
    await h.service.dispatch(ADMIN.id, toSectors({}, { channelId: 'c9' }));
    expect(channelsOf()).toEqual([
      ['rafael', 'c2'],
      ['ana', 'c1'],
    ]);
    expect(h.live.checkMany.mock.calls[0][0].map((c) => c.id)).not.toContain(
      'c9',
    );
  });
});

describe('área sem número trava o envio inteiro (422, GC7)', () => {
  it.each<[string, Record<string, ReturnType<typeof numberRow> | null>]>([
    ['uma das duas áreas', { log: N1111, exp: null }],
    ['todas as áreas', { log: null, exp: null }],
  ])(
    '%s sem número → sector_without_number, nada criado e nenhum provedor consultado',
    async (_label, numbers) => {
      givenNumbers(h, numbers);
      await refused(
        h.service.dispatch(ADMIN.id, toSectors()),
        'team_whatsapp.sector_without_number',
      );
      expect(h.live.checkMany.mock.calls).toHaveLength(0);
    },
  );

  it('a seleção vem antes: userIds fora da lista + área sem número → invalid_selection', async () => {
    givenNumbers(h, { log: N1111, exp: null });
    await refused(
      h.service.dispatch(ADMIN.id, toSectors({ userIds: ['ana', 'intruso'] })),
      'team_whatsapp.invalid_selection',
    );
  });

  it('área sem número vence o agendamento: início no passado → sector_without_number', async () => {
    givenNumbers(h, { log: N1111, exp: null });
    const input = toSectors(
      { shiftIds: [SHIFT_FIRST.id] },
      { when: 'shift_start' },
    );
    await refused(
      h.service.dispatch(ADMIN.id, input),
      'team_whatsapp.sector_without_number',
    );
  });
});

describe('número que a porta não disse open (envio imediato, 409)', () => {
  it.each<[LiveState, string]>([
    ['close', 'team_whatsapp.channel_disconnected'],
    ['connecting', 'team_whatsapp.channel_disconnected'],
    ['unknown', 'team_whatsapp.channel_unverified'],
  ])('número %s → 409 %s e nada criado', async (state, code) => {
    givenLive(h, { c2: state });
    await refused(h.service.dispatch(ADMIN.id, toSectors()), code, 409);
  });

  it('desconectado vence o não verificado', async () => {
    givenLive(h, { c1: 'unknown', c2: 'close' });
    await refused(
      h.service.dispatch(ADMIN.id, toSectors()),
      'team_whatsapp.channel_disconnected',
      409,
    );
  });

  it('a porta não responder por um canal vale unknown: nunca libera', async () => {
    h.live.checkMany.mockResolvedValue(new Map());
    await refused(
      h.service.dispatch(ADMIN.id, toSectors()),
      'team_whatsapp.channel_unverified',
      409,
    );
  });
});

describe('agendado congela o número (D7/GC6)', () => {
  const schedule = () =>
    toSectors(
      { date: TOMORROW, shiftIds: [SHIFT_FIRST.id] },
      { when: 'shift_start' },
    );

  it('número close no agendamento: cria SCHEDULED sem consultar o provedor, com o número de cada pessoa', async () => {
    givenLive(h, { c1: 'close', c2: 'close' });
    const out = await h.service.dispatch(ADMIN.id, schedule());
    expect(out).toMatchObject({ queued: 0, scheduled: 2 });
    expect(h.live.checkMany.mock.calls).toHaveLength(0);
    expect(created()).toMatchObject({ state: 'SCHEDULED', channelId: null });
    expect(created().recipients).toMatchObject([
      { userId: 'rafael', status: 'SCHEDULED', ...snapshotOf(N2222) },
      { userId: 'ana', status: 'SCHEDULED', ...snapshotOf(N1111) },
    ]);
  });
});

describe('alvo pessoa', () => {
  const NELSON = member({ id: 'nelson', name: 'Nelson', sectorId: 'log' });
  beforeEach(() => {
    h.repo.findTargetUser.mockResolvedValue(NELSON);
  });

  it('sai pelo número do setor do dia, e o envio guarda esse canal', async () => {
    await h.service.dispatch(ADMIN.id, toUser());
    expect(created()).toMatchObject({ channelId: 'c1', sectors: [] });
    expect(created().recipients).toMatchObject([snapshotOf(N1111)]);
  });

  it('remanejado hoje para a Expedição sai pelo número dela', async () => {
    h.repo.loadPersonSchedule.mockResolvedValue({
      cycle: null,
      exceptions: [borrowedBy('exp')],
    });
    await h.service.dispatch(ADMIN.id, toUser());
    expect(created().recipients).toMatchObject([snapshotOf(N2222)]);
  });

  it('sem setor no dia → 422 no_sector, nada criado', async () => {
    h.repo.findTargetUser.mockResolvedValue({
      ...NELSON,
      sectorId: null,
      sector: null,
    });
    await refused(
      h.service.dispatch(ADMIN.id, toUser()),
      'team_whatsapp.no_sector',
    );
  });

  it('setor sem número → 422 sector_without_number; número fechado → 409 channel_disconnected', async () => {
    givenNumbers(h, { log: null });
    await refused(
      h.service.dispatch(ADMIN.id, toUser()),
      'team_whatsapp.sector_without_number',
    );
    givenNumbers(h, { log: N1111 });
    givenLive(h, { c1: 'close' });
    await refused(
      h.service.dispatch(ADMIN.id, toUser()),
      'team_whatsapp.channel_disconnected',
      409,
    );
  });
});
