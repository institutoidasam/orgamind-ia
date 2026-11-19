import {
  PEOPLE_COLUMN_MEANING,
  PEOPLE_EXPORT_COLUMNS,
} from '../../shared/spreadsheet/people-columns';
import { formatDateCell } from '../../shared/spreadsheet/cell-rules';
import { timeIn, todayIn, type CivilDate } from '../staff-schedule/civil-date';
import type { PhoneVisibility } from './export-trail';

type PeopleStatus = 'active' | 'inactive' | 'all';

const STATUS_TEXT: Readonly<Record<PeopleStatus, string>> = {
  active: 'Ativas',
  inactive: 'Inativas',
  all: 'Todas',
};

const PHONE_TEXT: Readonly<Record<PhoneVisibility, string>> = {
  full: 'Completo',
  masked: 'Mascarado (só os 4 últimos dígitos)',
  partial:
    'Completo só de pessoas sem acesso ao sistema que estão hoje nos setores que você gerencia; mascarado nas demais',
};

const REFERENCE_NOTICE =
  'Setor, turno e nível são os que valiam na data de referência. Telefone, função, autorização de contato, situação e acesso são sempre os de hoje.';

const IMPORT_NOTICE =
  'Para atualizar pessoas pela importação, use uma exportação com data de referência de hoje. Não envie de volta um arquivo exportado com data passada: setor, turno e nível voltariam aos daquele dia.';

/** Linhas da aba "Instruções" (coluna A, coluna B); data e hora em America/Manaus. */
export function peopleInstructionRows(input: {
  exportedAt: Date;
  sectorLabel: string;
  shiftLabel: string;
  status: PeopleStatus;
  date: CivilDate;
  phoneVisibility: PhoneVisibility;
}): string[][] {
  const { exportedAt, sectorLabel, shiftLabel, status, date } = input;
  const exportedOn = formatDateCell(todayIn(exportedAt));
  return [
    ['Exportado em', `${exportedOn} ${timeIn(exportedAt)}`],
    ['Setor', sectorLabel],
    ['Turno', shiftLabel],
    ['Situação', STATUS_TEXT[status]],
    ['Data de referência', formatDateCell(date)],
    ['Telefone', PHONE_TEXT[input.phoneVisibility]],
    ['Atenção', REFERENCE_NOTICE],
    ['Atenção', IMPORT_NOTICE],
    [],
    ['Coluna', 'Significado'],
    ...PEOPLE_EXPORT_COLUMNS.map((column) => [
      column,
      PEOPLE_COLUMN_MEANING[column],
    ]),
  ];
}
