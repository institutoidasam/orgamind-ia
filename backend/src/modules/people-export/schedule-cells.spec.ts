import { describe, expect, it } from 'vitest';
import type { DaySituationContract } from '../../schemas/contracts/staff-schedule.schema';
import {
  SCHEDULE_FIXED_COLUMNS,
  scheduleCellLabel,
  scheduleFixedCells,
} from './schedule-cells';

const shiftNames = new Map([['noite', 'Noite']]);
const sectorNames = new Map([
  ['prod', 'Produção'],
  ['log', 'Logística'],
]);

function work(
  sectorId: string | null,
  shiftId = 'noite',
): DaySituationContract {
  return { kind: 'WORK', sectorId, shiftId, source: 'CYCLE' };
}

describe('scheduleCellLabel', () => {
  it.each<[string, DaySituationContract, string]>([
    ['trabalha no setor do quadro: nome do turno', work('prod'), 'Noite'],
    ['folga', { kind: 'OFF', reason: 'DAY_OFF', source: 'CYCLE' }, 'Folga'],
    [
      'férias',
      { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' },
      'Férias',
    ],
    ['sem escala: vazio', { kind: 'NONE' }, ''],
    ['trabalha em outro setor: Em <setor>', work('log'), 'Em Logística'],
    [
      'outro setor sem nome conhecido: Em outro setor',
      work('xyz'),
      'Em outro setor',
    ],
    ['outro setor nulo: Em outro setor', work(null), 'Em outro setor'],
    ['turno desconhecido no setor do quadro: vazio', work('prod', 'zzz'), ''],
  ])('%s', (_name, situation, expected) => {
    expect(
      scheduleCellLabel({
        situation,
        sectorId: 'prod',
        shiftNames,
        sectorNames,
      }),
    ).toBe(expected);
  });
});

describe('SCHEDULE_FIXED_COLUMNS', () => {
  it('colunas fixas da pessoa, sem telefone nem e-mail', () => {
    expect([...SCHEDULE_FIXED_COLUMNS]).toEqual([
      'nome',
      'funcao',
      'visitante',
    ]);
  });
});

describe('scheduleFixedCells', () => {
  it.each([
    ['nome comum passa', 'Ana Souza', 'Ana Souza'],
    ['e-mail no lugar do nome sai vazio', 'maria@exemplo.com.br', ''],
    ['nome mascarado passa', '•••• 2008', '•••• 2008'],
    ['nome vazio continua vazio', '', ''],
  ])('%s', (_case, name, expected) => {
    const [nameCell] = scheduleFixedCells({
      name,
      jobTitle: null,
      fromOtherSector: false,
    });

    expect(nameCell).toBe(expected);
  });

  it('função vazia sem cargo e visitante como Sim/Não', () => {
    expect(
      scheduleFixedCells({
        name: 'Ana Souza',
        jobTitle: null,
        fromOtherSector: true,
      }),
    ).toEqual(['Ana Souza', '', 'Sim']);
  });
});
