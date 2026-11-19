import { describe, it, expect } from 'vitest';
import {
  AUTHORIZATION_SOURCE_CELL,
  PEOPLE_COLUMN_MEANING,
  PEOPLE_EXPORT_COLUMNS,
  PEOPLE_TEMPLATE_COLUMNS,
  PERSON_STATUS_CELL,
} from './people-columns';

describe('PEOPLE_EXPORT_COLUMNS', () => {
  it('são as 11 do modelo mais situacao e tem_acesso, nesta ordem', () => {
    expect(PEOPLE_TEMPLATE_COLUMNS).toEqual([
      'matricula',
      'nome',
      'telefone',
      'funcao',
      'setor',
      'turno',
      'nivel',
      'autorizacao_contato',
      'origem_autorizacao',
      'detalhe_origem',
      'data_autorizacao',
    ]);
    expect(PEOPLE_EXPORT_COLUMNS).toEqual([
      ...PEOPLE_TEMPLATE_COLUMNS,
      'situacao',
      'tem_acesso',
    ]);
  });

  it('toda coluna tem significado e toda origem tem rótulo', () => {
    for (const column of PEOPLE_EXPORT_COLUMNS) {
      expect(PEOPLE_COLUMN_MEANING[column]).toMatch(/\S/);
    }
    expect(PEOPLE_COLUMN_MEANING.telefone).toBe(
      'Telefone no formato (92) 99111-2008; número de fora do Brasil sai no formato internacional. Mascarado (•••• 2008) para quem não pode vê-lo completo.',
    );
    expect(AUTHORIZATION_SOURCE_CELL).toEqual({
      TERMO_ASSINADO: 'Termo assinado',
      FICHA_ADMISSAO: 'Ficha de admissão',
      ACEITE_WHATSAPP: 'Aceite por WhatsApp',
      OUTRO: 'Outro',
      CADASTRO_ANTERIOR: 'Cadastro anterior',
    });
    expect(PERSON_STATUS_CELL).toEqual({
      active: 'Ativa',
      inactive: 'Inativa',
    });
  });
});
