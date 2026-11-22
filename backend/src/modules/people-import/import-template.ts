import { formatDateCell } from '../../shared/spreadsheet/cell-rules';
import {
  PEOPLE_COLUMN_MEANING,
  PEOPLE_TEMPLATE_COLUMNS,
} from '../../shared/spreadsheet/people-columns';
import type { CivilDate } from '../staff-schedule/civil-date';

/** Matrícula da linha de exemplo: a importação sempre a ignora (spec E2). */
const EXAMPLE_REGISTRATION = 'EXEMPLO';

/** Regras do modelo, na ordem da aba "Instruções" (CX12, EX24). */
const TEMPLATE_RULES: readonly string[] = [
  `Preencha uma pessoa por linha, a partir da linha 2. A linha com matrícula ${EXAMPLE_REGISTRATION} é ignorada.`,
  'Aceita arquivos .csv e .xlsx de até 5 MB e 5.000 linhas.',
  'A pessoa é encontrada pela matrícula; sem matrícula, pelo telefone (quem não vê telefone completo: só pela matrícula).',
  'Pessoa nova precisa de nome e telefone. Setor, turno, nível, função e matrícula são opcionais. Quem não é administrador informa o setor em todas as linhas.',
  'Célula vazia não altera o que já está cadastrado. A planilha não apaga valores, não inativa nem reativa pessoas e não cria acesso ao sistema.',
  'Setor, turno e nível pelo nome (setor também pelo código), como estão cadastrados e ativos.',
  'autorizacao_contato: Sim ou Não. Sim só vale com origem_autorizacao (Termo assinado, Ficha de admissão, Aceite por WhatsApp ou Outro; Outro exige detalhe_origem). data_autorizacao em DD/MM/AAAA; vazia = dia da gravação. A planilha não retira autorização.',
];

/** Aba "Pessoas" do modelo: cabeçalho e a linha de exemplo com a data de hoje (EX24). */
export function templateRows(today: CivilDate): string[][] {
  return [
    [...PEOPLE_TEMPLATE_COLUMNS],
    [
      EXAMPLE_REGISTRATION,
      'Maria Exemplo',
      '(92) 99111-0000',
      'Auxiliar',
      'Nome do setor',
      'Nome do turno',
      'Nome do nível',
      'Sim',
      'Termo assinado',
      '',
      formatDateCell(today),
    ],
  ];
}

/** Aba "Instruções": uma regra por linha na coluna A, depois o significado das colunas. */
export function templateInstructionRows(): string[][] {
  return [
    ...TEMPLATE_RULES.map((rule) => [rule]),
    [],
    ['Coluna', 'Significado'],
    ...PEOPLE_TEMPLATE_COLUMNS.map((column) => [
      column,
      PEOPLE_COLUMN_MEANING[column],
    ]),
  ];
}
