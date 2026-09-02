import { describe, it, expect } from 'vitest';
import {
  composeConsentBody,
  namesOrganization,
  suggestTextVersion,
} from './consent-text.composer';

const CONTINUUM = {
  name: 'CONTINUUM',
  legalName: 'Canal do Matheus Garcia - CONTINUUM',
};

const IDASAM_V1 =
  'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.\n' +
  'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\n' +
  'Minha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\n' +
  'Política de privacidade: {url}';

describe('composeConsentBody', () => {
  it('nomeia a organização CONFIGURADA — nunca uma constante de código', () => {
    const body = composeConsentBody(CONTINUUM, {
      label: 'Convites para cursos, oficinas e eventos',
    });

    expect(body).toContain('CONTINUUM');
    expect(body).toContain('Canal do Matheus Garcia - CONTINUUM');
    // O bug: um titular do Matheus autorizando "o IDASAM" é consentimento incoerente.
    expect(body).not.toMatch(/idasam/i);
  });

  it('a DECLARAÇÃO (1ª linha) nomeia a organização E a finalidade', () => {
    const body = composeConsentBody(CONTINUUM, {
      label: 'Convites para cursos, oficinas e eventos',
    });
    const declaration = body.split('\n')[0];

    // A Meta exige "clearly state the business's name" e a LGPD exige finalidade
    // determinada (art. 8º §4º) — as duas coisas na frase que viaja no wa.me.
    expect(declaration).toContain('CONTINUUM');
    expect(declaration.toLowerCase()).toContain(
      'convites para cursos, oficinas e eventos',
    );
    expect(declaration).toContain('WhatsApp');
  });

  it('razão social entre parênteses quando difere do nome curto', () => {
    const body = composeConsentBody(CONTINUUM, { label: 'Notícias e avisos' });

    expect(body.split('\n')[0]).toBe(
      'Autorizo CONTINUUM (Canal do Matheus Garcia - CONTINUUM) a me enviar mensagens no WhatsApp sobre notícias e avisos.',
    );
  });

  it('sem parênteses redundantes quando nome curto = razão social', () => {
    const body = composeConsentBody(
      { name: 'CONTINUUM', legalName: 'CONTINUUM' },
      { label: 'Notícias e avisos' },
    );

    expect(body.split('\n')[0]).toBe(
      'Autorizo CONTINUUM a me enviar mensagens no WhatsApp sobre notícias e avisos.',
    );
  });

  it('traz as cláusulas que a lei e a Meta exigem: frequência, saída, não-retaliação e política', () => {
    const body = composeConsentBody(CONTINUUM, { label: 'Notícias e avisos' });

    expect(body).toContain('2 mensagens por mês');
    expect(body).toContain('PARAR');
    // art. 5º XII — consentimento LIVRE. A assimetria organização ↔ beneficiário
    // exige a salvaguarda escrita.
    expect(body).toContain('não afeta em nada');
    expect(body).toContain('Política de privacidade: {url}');
  });

  it('finalidade utility (sem frequência declarada) omite a frase de frequência, mas nunca a de saída', () => {
    const body = composeConsentBody(
      CONTINUUM,
      { label: 'Avisos operacionais do projeto em que participo' },
      { messagesPerMonth: null },
    );

    expect(body).not.toContain('por mês');
    expect(body).toContain('PARAR');
  });

  it('`{url}` fica como placeholder — quem o resolve é o ponto de coleta', () => {
    const body = composeConsentBody(CONTINUUM, { label: 'Notícias e avisos' });

    expect(body).toContain('{url}');
  });
});

describe('namesOrganization', () => {
  it('reconhece o nome curto', () => {
    expect(
      namesOrganization('Autorizo CONTINUUM a me enviar…', CONTINUUM),
    ).toBe(true);
  });

  it('reconhece a razão social', () => {
    expect(
      namesOrganization(
        'Autorizo Canal do Matheus Garcia - CONTINUUM a me enviar…',
        { name: 'Outra', legalName: 'Canal do Matheus Garcia - CONTINUUM' },
      ),
    ).toBe(true);
  });

  it('é insensível a caixa e acento (o operador digita como quiser)', () => {
    expect(
      namesOrganization('autorizo a associação sao joao a me enviar…', {
        name: 'Associação São João',
        legalName: 'Associação São João',
      }),
    ).toBe(true);
  });

  it('o texto v1 do IDASAM NÃO nomeia a organização do Matheus — é o sinal que dispara a nova versão', () => {
    expect(namesOrganization(IDASAM_V1, CONTINUUM)).toBe(false);
  });
});

describe('suggestTextVersion', () => {
  it('deriva um rótulo de versão do nome da organização', () => {
    expect(suggestTextVersion(CONTINUUM, [])).toBe('optin-continuum-v1');
  });

  it('não colide com uma versão já publicada — incrementa', () => {
    expect(suggestTextVersion(CONTINUUM, ['optin-continuum-v1'])).toBe(
      'optin-continuum-v2',
    );
    expect(
      suggestTextVersion(CONTINUUM, [
        'optin-v1',
        'optin-continuum-v1',
        'optin-continuum-v2',
      ]),
    ).toBe('optin-continuum-v3');
  });

  it('aceita a versão do schema (letras, números, ponto, hífen e _)', () => {
    const version = suggestTextVersion(
      { name: 'Associação São João', legalName: 'Associação São João Ltda.' },
      [],
    );

    expect(version).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(version).toBe('optin-associacao-sao-joao-v1');
  });
});
