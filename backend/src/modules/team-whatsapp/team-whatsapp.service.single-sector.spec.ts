import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamDispatchSchema } from './dto/create-team-dispatch.dto';
import {
  ADMIN,
  SHIFT_FIRST,
  SHIFT_SECOND,
  createHarness,
  dayPerson,
  givenNumber,
  numberRow,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';
import { withAudienceKey } from './team-whatsapp.sector-send.test-fixtures';

// R5 (anti-objetivo): envio a um setor sem nível é exatamente o de hoje. O
// literal abaixo foi copiado da chamada real de `createDispatch` antes da T7;
// daqui em diante só se acrescentam chaves (nenhuma chave antiga muda).
// T7 acrescentou `sectors` e o snapshot de setor/nível nos destinatários;
// T8b, setor/nível na foto e a entrada `sectorIds: [id]` (C5); a T8 do número
// por área, o canal e o snapshot do número em cada destinatário.
// Noite de 21/10 começa às 22:00 de Manaus = 2026-10-22T02:00Z.
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const DATE = '2026-10-21';
const PROD = 's1';
const joao = dayPerson({
  id: 'joao',
  name: 'João',
  jobTitle: 'Operador',
  ...onShift(NOITE),
});
const bia = dayPerson({
  id: 'bia',
  name: 'Bia',
  jobTitle: 'Técnica',
  phoneE164: null,
  ...onShift(NOITE),
});
const caio = dayPerson({ id: 'caio', name: 'Caio', ...onShift(SHIFT_FIRST) });
const maria = dayPerson({
  id: 'maria',
  name: 'Maria',
  jobTitle: 'Técnica',
  ...onShift(NOITE),
  exceptions: [
    {
      id: 'ex-ferias',
      kind: 'VACATION',
      startDate: '2026-10-20',
      endDate: '2026-10-24',
      shiftId: null,
      sectorId: null,
    },
  ],
});

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  h = createHarness();
  // O setor tem como número o canal que o corpo antigo mandava: o literal não muda.
  givenNumber(h);
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSector.mockResolvedValue(sector({ id: PROD, name: 'Produção' }));
  h.repo.listActiveShifts.mockResolvedValue([SHIFT_FIRST, SHIFT_SECOND, NOITE]);
  h.repo.loadDayPeople.mockResolvedValue([joao, bia, caio, maria]);
});
afterEach(() => {
  vi.useRealTimers();
});

const TODAY = {
  authorId: ADMIN.id,
  targetType: 'SECTOR',
  targetId: PROD,
  targetLabel: 'Produção · Noite · 21/10',
  shiftId: NOITE.id,
  shiftName: 'Noite',
  shiftStartTime: '22:00',
  shiftEndTime: '06:00',
  rosterDate: DATE,
  includeOff: false,
  channelId: 'c1',
  text: 'Oi',
  // T7 (C6): uma linha por setor; `targetId` segue = o setor (o primeiro).
  sectors: [{ sectorId: PROD, sectorName: 'Produção' }],
  // DF4: envio novo grava roster null; a finalidade, a base e os excluídos
  // (inclusive o pulado sem telefone, DF3) vão nas colunas próprias.
  roster: null,
  purpose: 'SHIFT_NOTICE',
  audienceBase: 'ON_DUTY',
  audienceExcluded: [
    {
      userId: 'maria',
      name: 'Maria',
      sectorId: PROD,
      sectorName: 'Produção',
      // Turno considerado: o do vínculo (a pessoa está de férias, sem escala).
      shiftName: 'Noite',
      levelName: null,
      reason: 'vacation',
    },
    {
      userId: 'bia',
      name: 'Bia',
      sectorId: PROD,
      sectorName: 'Produção',
      shiftName: 'Noite',
      levelName: null,
      reason: 'no_phone',
    },
  ],
};
// T7: setor em que a pessoa entrou; nível só a partir da T8b (null).
const PROD_SNAPSHOT = {
  sectorId: PROD,
  sectorName: 'Produção',
  levelName: null,
};
// T8 (D3): o número da área vai para cada destinatário (inclusive o pulado).
const PROD_NUMBER = {
  channelId: 'c1',
  channelName: numberRow().name,
  channelPhoneE164: numberRow().phoneE164,
};
const recipientsOf = (pending: 'QUEUED' | 'SCHEDULED') => [
  {
    userId: 'bia',
    userName: 'Bia',
    shiftId: NOITE.id,
    shiftName: 'Noite',
    status: 'SKIPPED',
    skipReason: 'NO_PHONE',
    ...PROD_SNAPSHOT,
    ...PROD_NUMBER,
  },
  {
    userId: 'joao',
    userName: 'João',
    shiftId: NOITE.id,
    shiftName: 'Noite',
    status: pending,
    skipReason: null,
    ...PROD_SNAPSHOT,
    ...PROD_NUMBER,
  },
];

// O corpo passa pelo schema (apelidos, D9) e leva a impressão do público (CF2);
// a chave de zeros só satisfaz o schema e o helper a troca pela calculada.
const sendProd = async (when: 'now' | 'shift_start', shift: object) => {
  const parsed = createTeamDispatchSchema.parse({
    channelId: 'c1',
    text: 'Oi',
    purpose: 'shift_notice',
    audienceKey: '0'.repeat(64),
    when,
    target: { type: 'sector', sectorIds: [PROD], date: DATE, ...shift },
  });
  return h.service.dispatch(
    ADMIN.id,
    await withAudienceKey(h, ADMIN.id, parsed),
  );
};

// D9: `shiftId` (apelido) e `shiftIds: [id]` chegam ao mesmo envio de hoje.
describe.each([
  ['shiftId', { shiftId: NOITE.id }],
  ['shiftIds [id]', { shiftIds: [NOITE.id] }],
])('um setor sem nível = hoje (%s)', (_forma, shift) => {
  it.each([
    ['now', 'QUEUED', {}],
    [
      'shift_start',
      'SCHEDULED',
      {
        state: 'SCHEDULED',
        scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      },
    ],
  ] as const)(
    'createDispatch recebe o mesmo de hoje (%s)',
    async (when, pending, extra) => {
      await sendProd(when, shift);
      expect(h.repo.createDispatch.mock.calls).toHaveLength(1);
      const created = h.repo.createDispatch.mock.calls[0][0];
      expect(created).toMatchObject({
        ...TODAY,
        ...extra,
        recipients: recipientsOf(pending),
      });
      if (when === 'now') {
        expect(created).not.toHaveProperty('state');
        expect(created).not.toHaveProperty('scheduledFor');
      }
    },
  );
});
