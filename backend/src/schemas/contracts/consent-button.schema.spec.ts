import { describe, it, expect } from 'vitest';
import {
  CONSENT_BUTTON_CHOICES,
  CONSENT_BUTTON_TEXT_MAX,
  auditConsentButtons,
  auditZernioTemplateRow,
  isZernioOptInButton,
  isZernioOptOutButton,
  readDeclaredConsentButtons,
  reconcileConsentButtonRoles,
  squashButton,
} from './consent-button.schema';

/**
 * ESTE É O TESTE QUE FECHA O LOOP.
 *
 * `CONSENT_BUTTON_CHOICES` é a lista que o operador VÊ (e a única que a UI
 * oferece); `OPT_IN_LABELS`/`OPT_OUT_*` é a lista que o webhook RECONHECE. Se as
 * duas divergirem — alguém acrescenta um rótulo bonito no picker, ou renomeia
 * uma entrada do reconhecedor — o clique do contato deixa de gravar
 * consentimento EM SILÊNCIO, e o operador acha que colheu 13.400 aceites tendo
 * colhido zero.
 *
 * Aqui não há como divergir: cada rótulo oferecido é passado pelo MESMO
 * reconhecedor que o `chat-ingest` usa. Divergência = vermelho.
 */
describe('CONSENT_BUTTON_CHOICES ↔ reconhecedor (o loop do rótulo)', () => {
  it('todo rótulo de OPT-IN oferecido é reconhecido como opt-in', () => {
    for (const label of CONSENT_BUTTON_CHOICES.optIn) {
      expect(
        isZernioOptInButton(label),
        `rótulo "${label}" (squash: "${squashButton(label)}") é oferecido no picker mas NÃO é reconhecido como opt-in — o clique iria para o lixo`,
      ).toBe(true);
    }
  });

  it('nenhum rótulo de OPT-IN é lido como opt-out (opt-out tem precedência absoluta)', () => {
    for (const label of CONSENT_BUTTON_CHOICES.optIn) {
      expect(isZernioOptOutButton(label), `rótulo "${label}"`).toBe(false);
    }
  });

  it('todo rótulo de OPT-OUT oferecido é reconhecido como opt-out', () => {
    for (const label of CONSENT_BUTTON_CHOICES.optOut) {
      expect(
        isZernioOptOutButton(label),
        `rótulo "${label}" é oferecido como recusa mas NÃO suprime o contato`,
      ).toBe(true);
    }
  });

  it('nenhum rótulo de OPT-OUT é lido como opt-in (não se fabrica consentimento)', () => {
    for (const label of CONSENT_BUTTON_CHOICES.optOut) {
      expect(isZernioOptInButton(label), `rótulo "${label}"`).toBe(false);
    }
  });

  it('todo rótulo oferecido cabe no limite de caracteres da Meta', () => {
    // Um rótulo maior que o limite é TRUNCADO pela Meta — e o rótulo truncado
    // que volta no clique não bate mais com o reconhecedor. Ou seja: oferecer um
    // rótulo longo é oferecer um botão que perde o clique.
    for (const label of [
      ...CONSENT_BUTTON_CHOICES.optIn,
      ...CONSENT_BUTTON_CHOICES.optOut,
    ]) {
      expect(label.length, `rótulo "${label}"`).toBeLessThanOrEqual(
        CONSENT_BUTTON_TEXT_MAX,
      );
    }
  });

  it('as duas listas não têm rótulo em comum', () => {
    const optIn = new Set(CONSENT_BUTTON_CHOICES.optIn.map(squashButton));
    for (const label of CONSENT_BUTTON_CHOICES.optOut) {
      expect(optIn.has(squashButton(label)), `rótulo "${label}"`).toBe(false);
    }
  });

  it('o "Sim, quero receber" da campanha de reapresentação está no picker', () => {
    expect(CONSENT_BUTTON_CHOICES.optIn).toContain('Sim, quero receber');
    expect(CONSENT_BUTTON_CHOICES.optOut).toContain('Não quero receber');
  });
});

/**
 * O comportamento do reconhecedor não muda ao sair do adapter — estes casos são
 * os mesmos do `zernio-cloud.adapter.spec.ts`, replicados aqui porque a lógica
 * agora MORA aqui.
 */
describe('reconhecedor (comportamento preservado na extração)', () => {
  it('rótulo fora da lista não vira consentimento', () => {
    expect(isZernioOptInButton('Bora!')).toBe(false);
    expect(isZernioOptInButton('Aceito')).toBe(false);
    expect(isZernioOptInButton('Pode enviar')).toBe(false);
  });

  it('a negação nunca vira "sim", nem com vírgula', () => {
    expect(isZernioOptInButton('Não quero receber')).toBe(false);
    expect(isZernioOptInButton('Não, quero receber')).toBe(false);
  });

  it('acento, caixa e pontuação são irrelevantes', () => {
    expect(isZernioOptInButton('SIM, QUERO RECEBER!')).toBe(true);
    expect(squashButton('Sim, quero receber!')).toBe('sim quero receber');
  });
});

/**
 * ★ A AUDITORIA — a regra que os TRÊS chamadores compartilham (criação pelo
 * orgamind, classificação de um template importado e o gate de campanha).
 *
 * O caso que ela existe para matar: um template de opt-in criado direto no
 * painel do Zernio, com o botão "Bora, quero!". A Meta aprova; o sync importa;
 * sem esta auditoria a campanha dispara para 13.400 pessoas e cada clique no
 * "sim" some — zero consentimento, zero erro no log.
 */
describe('auditConsentButtons (papel declarado × rótulo reconhecido)', () => {
  it('o par canônico do opt-in passa', () => {
    expect(
      auditConsentButtons([
        { position: 1, text: 'Sim, quero receber', role: 'OPT_IN' },
        { position: 2, text: 'Não quero receber', role: 'OPT_OUT' },
      ]),
    ).toEqual([]);
  });

  it('BLOQUEIA um opt-in cujo rótulo o reconhecedor não lê ("Bora, quero!")', () => {
    const problems = auditConsentButtons([
      { position: 1, text: 'Bora, quero!', role: 'OPT_IN' },
      { position: 2, text: 'Não quero receber', role: 'OPT_OUT' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NÃO será reconhecido como aceite');
  });

  it('BLOQUEIA um botão SEM papel declarado cujo rótulo não é reconhecido — do rótulo sozinho é indecidível', () => {
    // O caminho do template importado do painel do Zernio: [Bora, quero!] /
    // [Agora não]. Nenhum dos dois é reconhecido, e ninguém disse o que são.
    const problems = auditConsentButtons([
      { position: 1, text: 'Bora, quero!' },
      { position: 2, text: 'Agora não' },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('ninguém declarou');
  });

  it('um botão comum DECLARADO como NONE passa — a decisão é do operador', () => {
    expect(
      auditConsentButtons([{ position: 1, text: 'Ver proposta', role: 'NONE' }]),
    ).toEqual([]);
  });

  it('sem papel declarado, um rótulo RECONHECIDO é lido como o reconhecedor o lê (é o que o ingest fará)', () => {
    // O "Parar promoções" que a Meta anexa sozinha a um marketing não pode
    // bloquear a campanha: o clique nele suprime, corretamente, sem declaração.
    expect(
      auditConsentButtons([{ position: 1, text: 'Parar promoções' }]),
    ).toEqual([]);
  });

  it('BLOQUEIA um NONE cujo rótulo o reconhecedor lê como aceite (fabricação por acidente)', () => {
    const problems = auditConsentButtons([
      { position: 1, text: 'Quero receber', role: 'NONE' },
    ]);
    expect(problems[0]).toContain('gravaria um aceite que a pessoa não deu');
  });

  it('BLOQUEIA opt-in sem opt-out — sem a saída, o aceite não é livre', () => {
    const problems = auditConsentButtons([
      { position: 1, text: 'Sim, quero receber', role: 'OPT_IN' },
    ]);
    expect(problems.join(' ')).toContain('botão de recusa');
  });
});

describe('auditZernioTemplateRow (a row do banco: components × declaração)', () => {
  const componentsWith = (labels: string[]) => [
    { type: 'BODY', text: 'olá' },
    {
      type: 'BUTTONS',
      buttons: labels.map((text) => ({ type: 'QUICK_REPLY', text })),
    },
  ];

  it('template sem botões não tem o que auditar', () => {
    expect(
      auditZernioTemplateRow({
        components: [{ type: 'BODY', text: 'olá' }],
        consentButtonRoles: null,
      }),
    ).toEqual([]);
  });

  it('★ o template importado com [Bora, quero!] / [Agora não] NÃO passa (é o bug que fecha)', () => {
    const problems = auditZernioTemplateRow({
      components: componentsWith(['Bora, quero!', 'Agora não']),
      consentButtonRoles: null,
    });
    expect(problems).toHaveLength(2);
  });

  it('o MESMO template passa depois que o operador declara os papéis (e nenhum é aceite)', () => {
    expect(
      auditZernioTemplateRow({
        components: componentsWith(['Bora, quero!', 'Agora não']),
        consentButtonRoles: [
          { text: 'Bora, quero!', role: 'NONE' },
          { text: 'Agora não', role: 'NONE' },
        ],
      }),
    ).toEqual([]);
  });

  it('mas declarar "Bora, quero!" como OPT_IN continua sendo recusado — a declaração não faz o clique ser lido', () => {
    const problems = auditZernioTemplateRow({
      components: componentsWith(['Bora, quero!', 'Não quero receber']),
      consentButtonRoles: [
        { text: 'Bora, quero!', role: 'OPT_IN' },
        { text: 'Não quero receber', role: 'OPT_OUT' },
      ],
    });
    expect(problems[0]).toContain('NÃO será reconhecido como aceite');
  });

  it('botão de URL não conta — o clique num link não volta como mensagem', () => {
    expect(
      auditZernioTemplateRow({
        components: [
          { type: 'BODY', text: 'olá' },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Ver proposta', url: 'https://x.com' }],
          },
        ],
        consentButtonRoles: null,
      }),
    ).toEqual([]);
  });
});

describe('reconcileConsentButtonRoles (a Meta reescreveu o rótulo → a declaração cai)', () => {
  it('mantém o papel do rótulo que sobreviveu', () => {
    expect(
      reconcileConsentButtonRoles(
        [{ text: 'Sim, quero receber', role: 'OPT_IN' }],
        ['Sim, quero receber'],
      ),
    ).toEqual([{ text: 'Sim, quero receber', role: 'OPT_IN' }]);
  });

  it('★ DERRUBA o papel quando a Meta mudou o rótulo — o botão volta a bloquear', () => {
    // Sem isto, uma row aprovada continuaria "declarada" sobre um rótulo que não
    // existe mais, e a campanha rodaria colhendo zero.
    expect(
      reconcileConsentButtonRoles(
        [{ text: 'Sim, quero receber', role: 'OPT_IN' }],
        ['Sim quero receber as novidades da campanha'],
      ),
    ).toEqual([]);
  });
});

describe('readDeclaredConsentButtons (Json de banco é unknown de verdade)', () => {
  it('descarta o que não parse — "não declarado" é o estado seguro (bloqueia)', () => {
    expect(
      readDeclaredConsentButtons([
        { text: 'ok', role: 'OPT_IN' },
        { text: '', role: 'OPT_IN' },
        { text: 'x', role: 'TALVEZ' },
        'lixo',
        null,
      ]),
    ).toEqual([{ text: 'ok', role: 'OPT_IN' }]);
  });

  it('null/objeto → lista vazia, sem lançar', () => {
    expect(readDeclaredConsentButtons(null)).toEqual([]);
    expect(readDeclaredConsentButtons({ a: 1 })).toEqual([]);
  });
});
