import { describe, expect, it } from 'vitest';
import { cellLabel } from './board-cells';
import type { DaySituation } from './schemas';

const shiftNames = new Map([['noite', 'Noite']]);
const sectorNames = new Map([['prod', 'Produção'], ['log', 'Logística']]);

const work = (sectorId: string): DaySituation => ({ kind: 'WORK', sectorId, shiftId: 'noite', source: 'CYCLE' });

describe('cellLabel', () => {
  it.each<[string, DaySituation, string]>([
    ['trabalha neste setor: nome do turno', work('prod'), 'Noite'],
    ['folga', { kind: 'OFF', reason: 'DAY_OFF', source: 'CYCLE' }, 'Folga'],
    ['férias', { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' }, 'Férias'],
    ['sem escala: vazio', { kind: 'NONE' }, ''],
    ['trabalha em outro setor: Em <setor>', work('log'), 'Em Logística'],
  ])('%s', (_name, situation, expected) => {
    expect(cellLabel({ situation, sectorId: 'prod', shiftNames, sectorNames })).toBe(expected);
  });
});
