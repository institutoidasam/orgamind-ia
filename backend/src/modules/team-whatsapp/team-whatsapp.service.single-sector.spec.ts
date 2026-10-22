import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  SHIFT_FIRST,
  SHIFT_SECOND,
  createHarness,
  dayPerson,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

// R5 (anti-objetivo): envio a um setor sem nível é exatamente o de hoje. O
// literal abaixo foi copiado da chamada real de `createDispatch` antes da T7;
// daqui em diante só se acrescentam chaves (nenhuma chave antiga muda).
// T7 acrescentou `sectors` e o snapshot de setor/nível nos destinatários;
// T8b, setor/nível na foto e a entrada `sectorIds: [id]` (C5).
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
  roster: {
    working: [
      {
        userId: 'bia',
        name: 'Bia',
        jobTitle: 'Técnica',
        shiftName: 'Noite',
        reason: null,
        sectorName: 'Produção',
        levelName: null,
      },
      {
        userId: 'joao',
        name: 'João',
        jobTitle: 'Operador',
        shiftName: 'Noite',
        reason: null,
        sectorName: 'Produção',
        levelName: null,
      },
    ],
    off: [
      {
        userId: 'maria',
        name: 'Maria',
        jobTitle: 'Técnica',
        shiftName: null,
        reason: 'VACATION',
        sectorName: 'Produção',
        levelName: null,
      },
    ],
  },
};
// T7: setor em que a pessoa entrou; nível só a partir da T8b (null).
const PROD_SNAPSHOT = {
  sectorId: PROD,
  sectorName: 'Produção',
  levelName: null,
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
  },
  {
    userId: 'joao',
    userName: 'João',
    shiftId: NOITE.id,
    shiftName: 'Noite',
    status: pending,
    skipReason: null,
    ...PROD_SNAPSHOT,
  },
];

describe('um setor sem nível = hoje', () => {
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
      await h.service.dispatch(ADMIN.id, {
        channelId: 'c1',
        text: 'Oi',
        when,
        target: {
          type: 'sector',
          sectorIds: [PROD],
          date: DATE,
          shiftId: NOITE.id,
        },
      });
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
