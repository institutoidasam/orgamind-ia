import { describe, expect, it } from 'vitest';
import {
  PEOPLE_COLUMN_MEANING,
  PEOPLE_EXPORT_COLUMNS,
} from '../../shared/spreadsheet/people-columns';
import { peopleInstructionRows } from './people-instructions';

const BASE = {
  exportedAt: new Date('2026-11-19T18:30:00Z'),
  sectorLabel: 'Logística',
  shiftLabel: 'Todos os turnos',
  status: 'active',
  date: '2026-11-19',
  phoneVisibility: 'full',
} as const;
const HEADER_ROWS = 10;

const EXPECTED_HEAD = [
  ['Exportado em', '19/11/2026 14:30'],
  ['Setor', 'Logística'],
  ['Turno', 'Todos os turnos'],
  ['Situação', 'Ativas'],
  ['Data de referência', '19/11/2026'],
  ['Telefone', 'Completo'],
  [
    'Atenção',
    'Setor, turno e nível são os que valiam na data de referência. Telefone, função, autorização de contato, situação e acesso são sempre os de hoje.',
  ],
  [
    'Atenção',
    'Para atualizar pessoas pela importação, use uma exportação com data de referência de hoje. Não envie de volta um arquivo exportado com data passada: setor, turno e nível voltariam aos daquele dia.',
  ],
  [],
  ['Coluna', 'Significado'],
];

describe('peopleInstructionRows', () => {
  it('linhas de filtro, data e hora em Manaus e os dois avisos', () => {
    expect(peopleInstructionRows(BASE).slice(0, HEADER_ROWS)).toEqual(
      EXPECTED_HEAD,
    );
    const past = { ...BASE, date: '2026-10-01' };
    const statusOf = (status: 'inactive' | 'all') =>
      peopleInstructionRows({ ...past, status })[3];
    expect(statusOf('inactive')).toEqual(['Situação', 'Inativas']);
    expect(statusOf('all')).toEqual(['Situação', 'Todas']);
    expect(peopleInstructionRows(past)[4]).toEqual([
      'Data de referência',
      '01/10/2026',
    ]);
  });

  it('uma linha por coluna exportada, com o significado', () => {
    const columns = peopleInstructionRows(BASE).slice(HEADER_ROWS);
    expect(columns).toHaveLength(13);
    expect(columns).toEqual(
      PEOPLE_EXPORT_COLUMNS.map((column) => [
        column,
        PEOPLE_COLUMN_MEANING[column],
      ]),
    );
  });

  it('texto do telefone para full, masked e partial', () => {
    const phoneRow = (phoneVisibility: 'full' | 'masked' | 'partial') =>
      peopleInstructionRows({ ...BASE, phoneVisibility })[5];
    expect(phoneRow('full')).toEqual(['Telefone', 'Completo']);
    expect(phoneRow('masked')).toEqual([
      'Telefone',
      'Mascarado (só os 4 últimos dígitos)',
    ]);
    expect(phoneRow('partial')).toEqual([
      'Telefone',
      'Completo só de pessoas sem acesso ao sistema que estão hoje nos setores que você gerencia; mascarado nas demais',
    ]);
  });
});
