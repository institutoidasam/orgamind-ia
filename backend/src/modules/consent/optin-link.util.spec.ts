import { describe, it, expect } from 'vitest';
import {
  buildExpectedText,
  buildWaMeUrl,
  declarationFrom,
  extractOriginToken,
  isValidOriginToken,
  normalizeForMatch,
  senderDigitsFrom,
} from './optin-link.util';

/**
 * Corpo canônico como ele vive em ConsentText (spec §3.0): 4 linhas, a primeira
 * é a DECLARAÇÃO (nomeia o IDASAM + a finalidade — os dois requisitos da Meta).
 */
const BODY = [
  'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.',
  'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.',
  'Minha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.',
  'Política de privacidade: {url}',
].join('\n');

const DECLARATION = declarationFrom(BODY);

describe('declarationFrom', () => {
  it('extrai a 1ª linha do texto canônico — a frase que nomeia o IDASAM e a finalidade', () => {
    expect(DECLARATION).toBe(
      'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.',
    );
  });

  it('ignora linhas em branco à frente', () => {
    expect(declarationFrom('\n\n  Autorizo o IDASAM a receber.  \n resto')).toBe(
      'Autorizo o IDASAM a receber.',
    );
  });
});

describe('normalizeForMatch (spec §3.1)', () => {
  it('baixa a caixa, tira acentos, colapsa espaços e remove pontuação final', () => {
    expect(normalizeForMatch('  Autorizo   o IDASAM a  ME enviar.  ')).toBe(
      'autorizo o idasam a me enviar',
    );
  });

  it('trata quebras de linha como espaço (o WhatsApp reflui o texto colado)', () => {
    expect(normalizeForMatch('Autorizo o\nIDASAM')).toBe('autorizo o idasam');
  });

  it('é estável sob acentuação divergente (NFD vs NFC) — o teclado do titular não é o nosso', () => {
    // "Agropecuário" composto (NFC) vs decomposto (NFD): bytes diferentes, mesma palavra.
    const nfc = 'Agropecuário';
    const nfd = 'Agropecuário';
    expect(nfc).not.toBe(nfd);
    expect(normalizeForMatch(nfc)).toBe(normalizeForMatch(nfd));
  });
});

describe('extractOriginToken', () => {
  it('extrai o token entre colchetes, normalizado em caixa alta', () => {
    expect(extractOriginToken('Autorizo o IDASAM ... [feira-manaus-2026]')).toBe(
      'FEIRA-MANAUS-2026',
    );
  });

  it('pega o ÚLTIMO grupo entre colchetes (o token é o sufixo)', () => {
    expect(extractOriginToken('bla [NAO] bla [FEIRA-MANAUS-2026]')).toBe('FEIRA-MANAUS-2026');
  });

  it('devolve null quando não há token — a pessoa apagou o texto pré-preenchido', () => {
    expect(extractOriginToken('oi')).toBeNull();
    expect(extractOriginToken('')).toBeNull();
  });
});

describe('isValidOriginToken', () => {
  it('aceita o formato legível de cartaz (A–Z, 0–9, hífen)', () => {
    expect(isValidOriginToken('FEIRA-MANAUS-2026')).toBe(true);
  });

  it('recusa o que quebraria o casamento ou o link (minúsculas, espaço, colchete)', () => {
    for (const bad of ['feira', 'FEIRA MANAUS', 'FEIRA[2026]', '-FEIRA', 'F', '']) {
      expect(isValidOriginToken(bad)).toBe(false);
    }
  });
});

describe('buildExpectedText', () => {
  it('o texto pré-preenchido É a declaração + o token de origem (spec §3.1)', () => {
    expect(buildExpectedText(DECLARATION, 'FEIRA-MANAUS-2026')).toBe(`${DECLARATION} [FEIRA-MANAUS-2026]`);
  });
});

describe('senderDigitsFrom', () => {
  it('remove o "+" — o wa.me exige o número sem +, sem 00 e sem zero à esquerda', () => {
    expect(senderDigitsFrom('+55 (92) 3155-0103')).toBe(559231550103n.toString());
  });

  it('descarta o prefixo internacional 00 e os zeros à esquerda', () => {
    expect(senderDigitsFrom('00559231550103')).toBe('559231550103');
    expect(senderDigitsFrom('0559231550103')).toBe('559231550103');
  });
});

describe('buildWaMeUrl', () => {
  it('gera o link com o texto URL-encoded (espaço e acento quebram o wa.me)', () => {
    const url = buildWaMeUrl('559231550103', 'Autorizo o IDASAM. [FEIRA-MANAUS-2026]');
    expect(url.startsWith('https://wa.me/559231550103?text=')).toBe(true);
    expect(url).not.toContain(' ');
    // ida e volta: o que o titular envia é exatamente o texto esperado
    const roundTrip = decodeURIComponent(url.split('?text=')[1]);
    expect(roundTrip).toBe('Autorizo o IDASAM. [FEIRA-MANAUS-2026]');
  });

  it('encoda os colchetes do token (o WhatsApp trunca o link em [ cru)', () => {
    const url = buildWaMeUrl('559231550103', 'x [T]');
    expect(url).toContain('%5BT%5D');
  });
});
