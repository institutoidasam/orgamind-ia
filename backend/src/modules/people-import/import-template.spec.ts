import { describe, expect, it } from 'vitest';
import {
  PEOPLE_COLUMN_MEANING,
  PEOPLE_TEMPLATE_COLUMNS,
} from '../../shared/spreadsheet/people-columns';
import { templateInstructionRows, templateRows } from './import-template';

const RULES = [
  'Preencha uma pessoa por linha, a partir da linha 2. A linha com matrícula EXEMPLO é ignorada.',
  'Aceita arquivos .csv e .xlsx de até 5 MB e 5.000 linhas.',
  'A pessoa é encontrada pela matrícula; sem matrícula, pelo telefone (quem não vê telefone completo: só pela matrícula).',
  'Pessoa nova precisa de nome e telefone. Setor, turno, nível, função e matrícula são opcionais. Quem não é administrador informa o setor em todas as linhas.',
  'Célula vazia não altera o que já está cadastrado. A planilha não apaga valores, não inativa nem reativa pessoas e não cria acesso ao sistema.',
  'Setor, turno e nível pelo nome (setor também pelo código), como estão cadastrados e ativos.',
  'autorizacao_contato: Sim ou Não. Sim só vale com origem_autorizacao (Termo assinado, Ficha de admissão, Aceite por WhatsApp ou Outro; Outro exige detalhe_origem). data_autorizacao em DD/MM/AAAA; vazia = dia da gravação. A planilha não retira autorização.',
];

describe('templateRows (EX24)', () => {
  it('linha de exemplo com EXEMPLO e a data de hoje', () => {
    expect(templateRows('2026-11-19')).toEqual([
      [...PEOPLE_TEMPLATE_COLUMNS],
      [
        'EXEMPLO',
        'Maria Exemplo',
        '(92) 99111-0000',
        'Auxiliar',
        'Nome do setor',
        'Nome do turno',
        'Nome do nível',
        'Sim',
        'Termo assinado',
        '',
        '19/11/2026',
      ],
    ]);
  });
});

describe('templateInstructionRows (CX12)', () => {
  it('instruções com as regras e o significado das onze colunas', () => {
    expect(templateInstructionRows()).toEqual([
      ...RULES.map((rule) => [rule]),
      [],
      ['Coluna', 'Significado'],
      ...PEOPLE_TEMPLATE_COLUMNS.map((column) => [
        column,
        PEOPLE_COLUMN_MEANING[column],
      ]),
    ]);
    expect(PEOPLE_TEMPLATE_COLUMNS).toHaveLength(11);
  });
});
