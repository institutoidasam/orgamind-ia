import { describe, it, expect } from 'vitest';
import { fileSlug } from './file-name';

describe('fileSlug', () => {
  it('tira acento, barra e símbolos; vazio vira setor', () => {
    expect(fileSlug('Manutenção / Elétrica (2º)')).toBe(
      'manutencao-eletrica-2o',
    );
    expect(fileSlug('  Logística  ')).toBe('logistica');
    expect(fileSlug('***')).toBe('setor');
    expect(fileSlug('')).toBe('setor');
  });
});
