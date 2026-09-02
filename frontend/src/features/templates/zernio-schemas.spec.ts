import { describe, it, expect } from 'vitest';
import {
  buildCreateZernioTemplate,
  detectZernioVariables,
  makeZernioTemplateFormSchema,
  squashConsentLabel,
  type ConsentButtonChoices,
  type ZernioTemplateFormValues,
} from './zernio-schemas';

/**
 * As escolhas vêm do BACKEND (GET /templates/consent-buttons) — o frontend não
 * tem cópia da lista. Aqui o teste as injeta, exatamente como o form injeta o
 * que buscou.
 */
const choices: ConsentButtonChoices = {
  optIn: ['Sim, quero receber', 'Quero receber'],
  optOut: ['Não quero receber', 'Parar'],
};

const schema = makeZernioTemplateFormSchema(choices);

const base: ZernioTemplateFormValues = {
  channelId: 'ch1',
  name: 'reapresentacao_optin',
  language: 'pt_BR',
  category: 'MARKETING',
  body: 'Oi! Podemos continuar te enviando novidades?',
  samples: [],
  footer: '',
  buttons: [],
};

const optInPair: ZernioTemplateFormValues['buttons'] = [
  { type: 'QUICK_REPLY', role: 'OPT_IN', text: 'Sim, quero receber', url: '' },
  { type: 'QUICK_REPLY', role: 'OPT_OUT', text: 'Não quero receber', url: '' },
];

describe('makeZernioTemplateFormSchema — o loop do rótulo, no cliente', () => {
  it('aceita o par [Sim, quero receber] / [Não quero receber]', () => {
    expect(schema.safeParse({ ...base, buttons: optInPair }).success).toBe(true);
  });

  it('BLOQUEIA rótulo de opt-in fora da lista reconhecida', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', role: 'OPT_IN', text: 'Bora!', url: '' },
        ...optInPair.slice(1),
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/não será reconhecido/i);
  });

  it('BLOQUEIA rótulo de opt-out fora da lista reconhecida', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [
        optInPair[0]!,
        { type: 'QUICK_REPLY', role: 'OPT_OUT', text: 'Agora não', url: '' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('BLOQUEIA botão comum cujo rótulo seria lido como consentimento', () => {
    // O reconhecimento é agnóstico de template: um "Quero receber" solto grava
    // um aceite que a pessoa não deu.
    const r = schema.safeParse({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', role: 'NONE', text: 'Quero receber', url: '' },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/consentimento/i);
  });

  it('BLOQUEIA botão comum cujo rótulo silenciaria o contato', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', role: 'NONE', text: 'Parar', url: '' }],
    });
    expect(r.success).toBe(false);
  });

  it('opt-in sem opt-out é bloqueado', () => {
    const r = schema.safeParse({ ...base, buttons: [optInPair[0]!] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/recusa/i);
  });

  it('não mistura resposta rápida com botão de URL', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', role: 'NONE', text: 'Ver depois', url: '' },
        { type: 'URL', role: 'NONE', text: 'Abrir', url: 'https://x.com.br' },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/misturar/i);
  });

  it('rótulos repetidos são bloqueados', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', role: 'NONE', text: 'Ver mais', url: '' },
        { type: 'QUICK_REPLY', role: 'NONE', text: 'ver mais!', url: '' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('botão de URL exige https', () => {
    const r = schema.safeParse({
      ...base,
      buttons: [{ type: 'URL', role: 'NONE', text: 'Abrir', url: 'x.com' }],
    });
    expect(r.success).toBe(false);
  });

  it('variável {{n}} sem amostra é bloqueada (a Meta rejeita sem exemplo)', () => {
    const r = schema.safeParse({
      ...base,
      body: 'Olá {{1}}, tudo bem?',
      samples: [{ variable: '1', value: '' }],
    });
    expect(r.success).toBe(false);
  });

  it('nome precisa começar com letra minúscula', () => {
    expect(schema.safeParse({ ...base, name: '1_optin' }).success).toBe(false);
    expect(schema.safeParse({ ...base, name: 'Optin' }).success).toBe(false);
  });

  it('template sem botão continua válido', () => {
    expect(schema.safeParse(base).success).toBe(true);
  });
});

describe('detectZernioVariables', () => {
  it('só variáveis numeradas, em ordem de primeira aparição', () => {
    expect(detectZernioVariables('Oi {{1}}, seu {{2}} e {{1}}')).toEqual(['1', '2']);
  });
});

describe('buildCreateZernioTemplate', () => {
  it('monta o payload da API (sem buttonId — o Zernio não tem payload)', () => {
    expect(
      buildCreateZernioTemplate({
        ...base,
        body: 'Olá {{1}}, podemos continuar?',
        samples: [{ variable: '1', value: 'João' }],
        footer: 'Toque num botão',
        buttons: optInPair,
      }),
    ).toEqual({
      channelId: 'ch1',
      name: 'reapresentacao_optin',
      language: 'pt_BR',
      category: 'MARKETING',
      body: 'Olá {{1}}, podemos continuar?',
      bodyExamples: ['João'],
      footer: 'Toque num botão',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sim, quero receber', role: 'OPT_IN' },
        { type: 'QUICK_REPLY', text: 'Não quero receber', role: 'OPT_OUT' },
      ],
    });
  });

  it('botão de URL leva url e não leva role', () => {
    const payload = buildCreateZernioTemplate({
      ...base,
      buttons: [
        { type: 'URL', role: 'NONE', text: 'Abrir', url: 'https://x.com.br' },
      ],
    });
    expect(payload.buttons).toEqual([
      { type: 'URL', text: 'Abrir', url: 'https://x.com.br' },
    ]);
    expect(payload.footer).toBeUndefined();
  });
});

describe('squashConsentLabel', () => {
  it('normaliza acento, caixa e pontuação (mesma regra do backend)', () => {
    expect(squashConsentLabel('Sim, quero receber!')).toBe('sim quero receber');
    expect(squashConsentLabel('Não quero receber')).toBe('nao quero receber');
  });
});
