import { describe, it, expect } from 'vitest';
import { renderTemplateBody } from './render-template-body';

/**
 * O corpo aprovado do template + as variáveis já resolvidas é a ÚNICA fonte do
 * texto que a pessoa leu. Este helper existe para que o envio (worker) e o
 * provedor não-oficial (Evolution) interpolem EXATAMENTE do mesmo jeito — uma
 * implementação só, sem um segundo vocabulário de renderização.
 */
describe('renderTemplateBody', () => {
  it('interpola {{k}} com o valor da variável', () => {
    expect(renderTemplateBody('Olá {{nome}}, tudo bem?', { nome: 'Andre' })).toBe(
      'Olá Andre, tudo bem?',
    );
  });

  it('substitui TODAS as ocorrências da mesma variável', () => {
    expect(renderTemplateBody('{{nome}} e {{nome}}', { nome: 'Ana' })).toBe('Ana e Ana');
  });

  it('deixa literal a variável ausente (mesma regra do interpolate do Evolution)', () => {
    expect(renderTemplateBody('Olá {{nome}}', {})).toBe('Olá {{nome}}');
  });

  it('body vazio/nulo/indefinido rende string vazia (deixa o chamador decidir o fallback)', () => {
    expect(renderTemplateBody('', { nome: 'Ana' })).toBe('');
    expect(renderTemplateBody(null, { nome: 'Ana' })).toBe('');
    expect(renderTemplateBody(undefined, { nome: 'Ana' })).toBe('');
  });

  it('sem variáveis, devolve o corpo intacto', () => {
    expect(renderTemplateBody('Texto fixo', {})).toBe('Texto fixo');
  });
});
