import { describe, it, expect } from 'vitest';
import {
  ZERNIO_MAX_QUICK_REPLIES,
  ZERNIO_MAX_URL_BUTTONS,
  buildZernioComponents,
  validateZernioTemplateInput,
  type ZernioTemplateValidationInput,
} from './zernio-template-validation';

const base: ZernioTemplateValidationInput = {
  name: 'reapresentacao_optin',
  language: 'pt_BR',
  category: 'MARKETING',
  body: 'Olá! Aqui é a campanha. Podemos continuar te enviando novidades?',
  bodyExamples: [],
};

/** Atalho: monta o par [Sim] / [Não] da campanha de reapresentação. */
const optInPair = [
  { type: 'QUICK_REPLY' as const, text: 'Sim, quero receber', role: 'OPT_IN' as const },
  { type: 'QUICK_REPLY' as const, text: 'Não quero receber', role: 'OPT_OUT' as const },
];

describe('validateZernioTemplateInput — o par de opt-in da campanha', () => {
  it('aceita o template de reapresentação [Sim, quero receber] / [Não quero receber]', () => {
    expect(
      validateZernioTemplateInput({ ...base, buttons: optInPair }),
    ).toEqual([]);
  });

  it('aceita template sem botões (o caminho que já existia não pode quebrar)', () => {
    expect(validateZernioTemplateInput(base)).toEqual([]);
  });
});

describe('validateZernioTemplateInput — O CORAÇÃO: rótulo ↔ reconhecedor', () => {
  it('RECUSA um botão de opt-in cujo rótulo o sistema não reconhece', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Bora!', role: 'OPT_IN' },
        { type: 'QUICK_REPLY', text: 'Não quero receber', role: 'OPT_OUT' },
      ],
    });
    expect(problems.join(' ')).toMatch(/não (é|será) reconhecid/i);
    expect(problems.join(' ')).toContain('Sim, quero receber');
  });

  it.each(['Quero sim', 'Aceito', 'Pode enviar', 'OK', 'Confirmo'])(
    'RECUSA o rótulo de opt-in %s (clique iria para o lixo)',
    (text) => {
      const problems = validateZernioTemplateInput({
        ...base,
        buttons: [
          { type: 'QUICK_REPLY', text, role: 'OPT_IN' },
          { type: 'QUICK_REPLY', text: 'Não quero receber', role: 'OPT_OUT' },
        ],
      });
      expect(problems.length).toBeGreaterThan(0);
    },
  );

  it('RECUSA um botão de opt-out cujo rótulo não suprime de fato', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sim, quero receber', role: 'OPT_IN' },
        { type: 'QUICK_REPLY', text: 'Agora não, obrigado', role: 'OPT_OUT' },
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('RECUSA um botão COMUM cujo rótulo o sistema leria como consentimento', () => {
    // O reconhecimento é AGNÓSTICO DE TEMPLATE (chat-ingest casa o payload
    // sintetizado a partir do rótulo de QUALQUER botão): um quick reply
    // "comum" rotulado "Quero receber" FABRICARIA um GRANT.
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', text: 'Quero receber', role: 'NONE' }],
    });
    expect(problems.join(' ')).toMatch(/consentimento/i);
  });

  it('RECUSA um botão COMUM cujo rótulo silenciaria o contato', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', text: 'Cancelar', role: 'NONE' }],
    });
    expect(problems.join(' ')).toMatch(/silencia|suprim/i);
  });

  it('opt-in SEM opt-out é recusado (recusa não é cortesia, é conformidade)', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sim, quero receber', role: 'OPT_IN' },
      ],
    });
    expect(problems.join(' ')).toMatch(/opt-out|recusa/i);
  });

  it('dois botões de opt-in são recusados', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sim, quero receber', role: 'OPT_IN' },
        { type: 'QUICK_REPLY', text: 'Quero receber', role: 'OPT_IN' },
        { type: 'QUICK_REPLY', text: 'Não quero receber', role: 'OPT_OUT' },
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('um botão de URL não pode assumir papel de consentimento', () => {
    // Um clique em URL não gera inbound nenhum — não há como registrar aceite.
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        // @ts-expect-error — o papel não existe no tipo URL; a checagem é o backstop de runtime
        { type: 'URL', text: 'Sim, quero receber', url: 'https://x.com', role: 'OPT_IN' },
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('validateZernioTemplateInput — limites da Meta', () => {
  it('rótulo acima do limite de caracteres é recusado', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'a'.repeat(26), role: 'NONE' },
      ],
    });
    expect(problems.join(' ')).toMatch(/caracteres/i);
  });

  it(`no máximo ${ZERNIO_MAX_QUICK_REPLIES} botões de resposta rápida`, () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: Array.from({ length: ZERNIO_MAX_QUICK_REPLIES + 1 }, (_, i) => ({
        type: 'QUICK_REPLY' as const,
        text: `Opcao ${i + 1}`,
        role: 'NONE' as const,
      })),
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('não mistura resposta rápida com botão de URL no mesmo template', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Ver depois', role: 'NONE' },
        { type: 'URL', text: 'Abrir site', url: 'https://exemplo.com' },
      ],
    });
    expect(problems.join(' ')).toMatch(/misturar/i);
  });

  it(`no máximo ${ZERNIO_MAX_URL_BUTTONS} botões de URL`, () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: Array.from({ length: ZERNIO_MAX_URL_BUTTONS + 1 }, (_, i) => ({
        type: 'URL' as const,
        text: `Link ${i + 1}`,
        url: 'https://exemplo.com',
      })),
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('botão de URL exige URL https', () => {
    expect(
      validateZernioTemplateInput({
        ...base,
        buttons: [{ type: 'URL', text: 'Abrir', url: 'ftp://x' }],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rótulos repetidos são recusados (o reconhecedor não os distingue)', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Ver mais', role: 'NONE' },
        { type: 'QUICK_REPLY', text: 'ver mais!', role: 'NONE' },
      ],
    });
    expect(problems.join(' ')).toMatch(/repetid|igua/i);
  });

  it('rótulo com variável {{n}} é recusado', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', text: 'Ver {{1}}', role: 'NONE' }],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('nome fora do regex da Meta é recusado', () => {
    expect(
      validateZernioTemplateInput({ ...base, name: '1_reapresentacao' }).length,
    ).toBeGreaterThan(0);
    expect(
      validateZernioTemplateInput({ ...base, name: 'Reapresentacao' }).length,
    ).toBeGreaterThan(0);
  });

  it('body vazio é recusado', () => {
    expect(validateZernioTemplateInput({ ...base, body: '  ' }).length).toBe(1);
  });

  it('variável {{n}} sem amostra é recusada (a Meta rejeita sem `example`)', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      body: 'Olá {{1}}, tudo bem?',
      bodyExamples: [],
    });
    expect(problems.join(' ')).toMatch(/amostra/i);
  });

  it('variáveis precisam ser numéricas e sequenciais a partir de 1', () => {
    expect(
      validateZernioTemplateInput({
        ...base,
        body: 'Olá {{nome}}',
        bodyExamples: ['João'],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateZernioTemplateInput({
        ...base,
        body: 'Olá {{2}}',
        bodyExamples: ['João'],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('body com variável + amostra correspondente passa', () => {
    expect(
      validateZernioTemplateInput({
        ...base,
        body: 'Olá {{1}}, podemos continuar?',
        bodyExamples: ['João'],
        buttons: optInPair,
      }),
    ).toEqual([]);
  });
});

describe('buildZernioComponents', () => {
  it('monta BODY + BUTTONS no shape da Meta (sem id/payload — o Zernio não tem)', () => {
    const components = buildZernioComponents({
      ...base,
      body: 'Olá {{1}}, podemos continuar?',
      bodyExamples: ['João'],
      footer: 'Responda com um toque',
      buttons: optInPair,
    });
    expect(components).toEqual([
      {
        type: 'BODY',
        text: 'Olá {{1}}, podemos continuar?',
        example: { body_text: [['João']] },
      },
      { type: 'FOOTER', text: 'Responda com um toque' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sim, quero receber' },
          { type: 'QUICK_REPLY', text: 'Não quero receber' },
        ],
      },
    ]);
  });

  it('sem variável não manda `example`; sem botão não manda BUTTONS', () => {
    expect(buildZernioComponents(base)).toEqual([
      { type: 'BODY', text: base.body },
    ]);
  });

  it('botão de URL leva a url', () => {
    const components = buildZernioComponents({
      ...base,
      buttons: [{ type: 'URL', text: 'Abrir site', url: 'https://exemplo.com' }],
    }) as Array<Record<string, unknown>>;
    expect(components[1]).toEqual({
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Abrir site', url: 'https://exemplo.com' },
      ],
    });
  });
});

/**
 * Categoria — a UI oferecia AUTHENTICATION e nada barrava.
 *
 * Um template AUTHENTICATION na Meta tem forma RÍGIDA (corpo de autenticação
 * fixo + botão OTP/copy-code; não aceita corpo livre nem quick reply
 * arbitrária), e o `buildZernioComponents` só sabe emitir BODY/FOOTER/BUTTONS.
 * Submeter era rejeição CERTA 24h depois — e mais uma rejeição no histórico da
 * WABA da campanha, que é justamente o que a validação pré-POST existe para
 * evitar.
 */
describe('categoria', () => {
  const base = {
    name: 'reapresentacao_optin',
    language: 'pt_BR',
    body: 'Podemos continuar te enviando novidades?',
    buttons: [],
  };

  it('recusa AUTHENTICATION', () => {
    const problems = validateZernioTemplateInput({
      ...base,
      category: 'AUTHENTICATION',
    });
    expect(problems.join(' ')).toContain('Categoria não suportada');
  });

  it.each(['MARKETING', 'UTILITY'] as const)('aceita %s', (category) => {
    expect(validateZernioTemplateInput({ ...base, category })).toEqual([]);
  });
});
