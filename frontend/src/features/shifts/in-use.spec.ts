import { describe, expect, it } from 'vitest';
import { inUseText } from './in-use';

describe('inUseText', () => {
  it('lista os motivos de em uso na frase "Em uso: ..."', () => {
    expect(
      inUseText([
        { kind: 'users', count: 3 },
        { kind: 'scheduled', count: 1 },
      ]),
    ).toBe('Em uso: 3 pessoa(s) com este turno no cadastro, 1 envio(s) agendado(s)');
  });

  it('cobre escalas e exceções de hoje em diante', () => {
    expect(
      inUseText([
        { kind: 'schedules', count: 2 },
        { kind: 'exceptions', count: 4 },
      ]),
    ).toBe('Em uso: 2 escala(s), 4 exceção(ões) de hoje em diante');
  });

  it('sem motivos devolve null', () => {
    expect(inUseText([])).toBeNull();
  });
});
