import { describe, it, expect } from 'vitest';
import { planBroadcastVariables } from './zernio-broadcast-variables';

describe('planBroadcastVariables — a porta que impede "Olá , tudo bem?" para 13.400 pessoas', () => {
  it('template SEM variáveis => pode ir por broadcast, mapping vazio', () => {
    const plan = planBroadcastVariables({});
    expect(plan.broadcastable).toBe(true);
    if (!plan.broadcastable) throw new Error('unreachable');
    expect(plan.variableMapping).toEqual({});
  });

  it('variáveis LITERAIS => viram customValue (iguais para todo mundo, e é isso mesmo)', () => {
    const plan = planBroadcastVariables({
      '1': { source: 'literal', value: 'Matheus Garcia' },
      '2': { source: 'literal', value: '22 de julho' },
    });
    expect(plan.broadcastable).toBe(true);
    if (!plan.broadcastable) throw new Error('unreachable');
    expect(plan.variableMapping).toEqual({
      '1': { field: 'custom', customValue: 'Matheus Garcia' },
      '2': { field: 'custom', customValue: '22 de julho' },
    });
  });

  it('★ variável de CAMPO DO CONTATO => NÃO é broadcastable', () => {
    // O `phones[]` do Zernio auto-cria o contato no CRM DELE com telefone e MAIS
    // NADA. Um `{{1}} = nome` seria resolvido contra um `name` VAZIO — e 13.400
    // pessoas receberiam "Olá , tudo bem?". O 1-a-1 do orgamind monta a variável do
    // NOSSO banco e não tem esse problema.
    const plan = planBroadcastVariables({
      '1': { source: 'field', field: 'name' },
    });
    expect(plan.broadcastable).toBe(false);
    if (plan.broadcastable) throw new Error('unreachable');
    expect(plan.perContactKeys).toEqual(['1']);
    expect(plan.reason).toMatch(/nome|campo do contato|CRM/i);
  });

  it('mistura literal + campo => bloqueia, e diz EXATAMENTE qual variável é a culpada', () => {
    const plan = planBroadcastVariables({
      '1': { source: 'literal', value: 'Olá' },
      '2': { source: 'field', field: 'name' },
      '3': { source: 'field', field: 'city' },
    });
    expect(plan.broadcastable).toBe(false);
    if (plan.broadcastable) throw new Error('unreachable');
    expect(plan.perContactKeys).toEqual(['2', '3']);
  });

  it('a ordem das chaves é NUMÉRICA (1,2,10 — nunca 1,10,2)', () => {
    const plan = planBroadcastVariables({
      '10': { source: 'literal', value: 'dez' },
      '2': { source: 'literal', value: 'dois' },
      '1': { source: 'literal', value: 'um' },
    });
    expect(plan.broadcastable).toBe(true);
    if (!plan.broadcastable) throw new Error('unreachable');
    expect(Object.keys(plan.variableMapping)).toEqual(['1', '2', '10']);
  });
});
