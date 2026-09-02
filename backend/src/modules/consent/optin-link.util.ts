/**
 * C3 — o kit wa.me + QR (spec §3.1).
 *
 * A ideia inteira em uma frase: **o texto pré-preenchido do wa.me É a declaração
 * de consentimento**. Quando a pessoa toca em "enviar", ela pratica um ato
 * afirmativo cujo conteúdo é o texto — e o texto chega ao orgamind dentro de um
 * inbound com `wamid` verificável na Twilio. Isso satisfaz o art. 8º caput ("por
 * escrito ou por outro meio que demonstre a manifestação de vontade") e os dois
 * requisitos da Meta (declarar que está optando por receber + nomear o negócio),
 * porque a declaração vem do `ConsentText` versionado, que já nomeia o IDASAM.
 *
 * Um "Oi" genérico pré-preenchido não serviria para nada — e um inbound que NÃO
 * casa com o texto esperado continua não sendo consentimento: abre a janela de
 * atendimento e nada mais.
 */

/** Só isto entra num token de origem: o que cabe num cartaz e sobrevive a uma URL. */
const TOKEN_PATTERN = /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/;
const TOKEN_MIN = 3;
const TOKEN_MAX = 48;

/**
 * A DECLARAÇÃO: a 1ª linha do corpo canônico de `ConsentText` — a frase que
 * nomeia o IDASAM e a finalidade. As demais linhas (frequência, como sair,
 * não-retaliação, link da política) são indispensáveis num checkbox de tela,
 * mas num `?text=` de wa.me elas viram um parágrafo que o titular apaga antes de
 * enviar — e um texto apagado é um consentimento perdido. O que o link carrega é
 * a declaração; o corpo integral continua sendo o que a landing exibe (§3.2).
 */
export function declarationFrom(consentTextBody: string): string {
  const line = consentTextBody
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '';
}

/**
 * Normalização do casamento (spec §3.1): minúsculas, sem acentos, espaços
 * colapsados, pontuação final removida.
 *
 * NFD antes de remover os diacríticos porque "á" pode chegar composto (U+00E1)
 * ou decomposto (U+0061 U+0301) conforme o teclado do titular: sem normalizar a
 * forma Unicode, dois textos idênticos aos olhos têm bytes diferentes e o
 * casamento falharia — silenciosamente, e do lado errado (deixaria de consentir
 * quem consentiu).
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacríticos combinantes soltos pelo NFD
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?\s]+$/, '');
}

/**
 * O token de origem (`[FEIRA-MANAUS-2026]`) é o que resolve QUAL link o titular
 * usou — e, por consequência, qual finalidade ele autorizou e qual ponto de
 * coleta creditar no funil. Pegamos o ÚLTIMO grupo entre colchetes: o token é o
 * sufixo, e a declaração pode legitimamente conter colchetes.
 */
export function extractOriginToken(text: string): string | null {
  const matches = [...text.matchAll(/\[([^[\]]+)\]/g)];
  const last = matches.at(-1);
  const token = last?.[1]?.trim().toUpperCase();
  return token && token.length > 0 ? token : null;
}

export function isValidOriginToken(token: string): boolean {
  return (
    token.length >= TOKEN_MIN && token.length <= TOKEN_MAX && TOKEN_PATTERN.test(token)
  );
}

/** O texto pré-preenchido do link: declaração + token de origem. */
export function buildExpectedText(declaration: string, token: string): string {
  return `${declaration.trim()} [${token}]`;
}

/**
 * wa.me exige o número em formato internacional **sem `+`, sem `00` e sem zeros
 * à esquerda** — qualquer um dos três quebra o link (faq.whatsapp.com/5913398998672934).
 */
export function senderDigitsFrom(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

/**
 * `encodeURIComponent` (e não `URLSearchParams`) de propósito: o `+` que o
 * `URLSearchParams` usa para espaço é lido como `+` LITERAL pelo WhatsApp, e o
 * titular enviaria "Autorizo+o+IDASAM…" — que não casa com nada. Os colchetes
 * também são encodados: alguns clientes truncam o link no `[` cru, o que
 * decapitaria justamente o token de origem.
 */
export function buildWaMeUrl(senderDigits: string, expectedText: string): string {
  const encoded = encodeURIComponent(expectedText)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return `https://wa.me/${senderDigits}?text=${encoded}`;
}
