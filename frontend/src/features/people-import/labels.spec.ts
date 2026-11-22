import { describe, expect, it } from 'vitest';
import { confirmText, FIELD_LABEL, ROW_CLASS_LABEL, SITUATION_LABEL } from './labels';

describe('rótulos da importação', () => {
  it('confirmText: os dois lados, um lado só e singular', () => {
    expect(confirmText(12, 30)).toBe('Criar 12 e atualizar 30 pessoas');
    expect(confirmText(12, 0)).toBe('Criar 12 pessoas');
    expect(confirmText(0, 30)).toBe('Atualizar 30 pessoas');
    expect(confirmText(1, 0)).toBe('Criar 1 pessoa');
    expect(confirmText(0, 1)).toBe('Atualizar 1 pessoa');
    expect(confirmText(12, 1)).toBe('Criar 12 e atualizar 1 pessoa');
    expect(confirmText(0, 0)).toBe('Nenhuma pessoa selecionada');
  });

  it('rótulos de classificação e situação', () => {
    expect(Object.values(ROW_CLASS_LABEL)).toEqual([
      'Criar',
      'Atualizar',
      'Sem alteração',
      'Inválida',
      'Duplicada',
      'Conflito',
      'Ignorada',
    ]);
    expect(Object.values(SITUATION_LABEL)).toEqual([
      'Em prévia',
      'Gravando',
      'Gravação interrompida',
      'Concluída',
      'Encerrada',
    ]);
    expect(FIELD_LABEL.authorization).toBe('Autorização de contato');
    expect(Object.keys(FIELD_LABEL)).toHaveLength(11);
  });
});
