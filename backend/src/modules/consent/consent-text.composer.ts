/**
 * A composição do texto canônico de consentimento a partir da IDENTIDADE
 * CONFIGURADA da organização (spec §3.0).
 *
 * Antes disto, o corpo do `ConsentText` nascia numa migração de referência com o
 * nome de uma organização específica escrito dentro. Aqui o nome vira parâmetro:
 * quem o fornece é `Organization` (semeada do env, editável em Configurações).
 *
 * **Isto NÃO reescreve texto já publicado.** `ConsentText` é versionado e
 * imutável por design: os `ConsentEvent` já gravados apontam para a versão que a
 * pessoa LEU, e é ela que prova o consentimento em 2028 (art. 8º §2º — o ônus da
 * prova é do controlador). O composer só produz o corpo de uma versão NOVA.
 *
 * Puro de propósito: usado pelo app (sugestão na tela do admin) e pelo
 * `prisma/seed.ts` (tsx, sem container de DI).
 */

import type { OrgIdentity } from '../organization/organization-identity';

/** O que o composer precisa da organização — nada além de como ela se chama. */
type OrgNames = Pick<OrgIdentity, 'name' | 'legalName'>;

export type ComposeOptions = {
  /**
   * Frequência declarada. `null` = finalidade utility (avisos operacionais do
   * serviço), que não promete cadência — a frase de frequência sai, mas a de
   * SAÍDA (PARAR) nunca sai: ela é obrigatória.
   */
  messagesPerMonth?: number | null;
};

/** Minúsculas, sem acento — para comparar nome de organização dentro de um texto. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A DECLARAÇÃO (1ª linha) — a única que viaja no `?text=` do wa.me. Ela sozinha
 * tem de cumprir os dois requisitos da Meta: declarar que está optando por
 * receber E nomear o negócio. E a finalidade determinada da LGPD (art. 8º §4º:
 * autorização genérica é nula) vem do rótulo.
 *
 * A razão social entra entre parênteses quando difere do nome curto — mesma
 * forma do texto de referência ("Autorizo o X (Razão Social por Extenso) …").
 */
function declarationLine(org: OrgNames, purposeLabel: string): string {
  const name = org.name.trim();
  const legalName = org.legalName.trim();
  const quem =
    fold(legalName) === fold(name) ? name : `${name} (${legalName})`;
  return `Autorizo ${quem} a me enviar mensagens no WhatsApp sobre ${purposeLabel.trim().toLowerCase()}.`;
}

/**
 * O corpo canônico completo — o que a landing exibe ao lado do checkbox e o que,
 * palavra por palavra, é copiado para `ConsentEvent.evidenceText`.
 *
 * `{url}` fica como PLACEHOLDER: quem o resolve é o ponto de coleta (a política
 * de privacidade configurada, ou `APP_BASE_URL/privacidade`). Isso mantém a
 * troca da URL como correção de configuração, não de texto publicado.
 */
export function composeConsentBody(
  org: OrgNames,
  purpose: { label: string },
  options: ComposeOptions = {},
): string {
  const { messagesPerMonth = 2 } = options;

  const saida =
    messagesPerMonth === null || messagesPerMonth === undefined
      ? 'Posso sair quando quiser respondendo PARAR.'
      : `São no máximo ${messagesPerMonth} mensagens por mês. Posso sair quando quiser respondendo PARAR.`;

  return [
    declarationLine(org, purpose.label),
    saida,
    // art. 5º XII — o consentimento tem de ser LIVRE. Numa relação assimétrica
    // (organização ↔ beneficiário/cliente), a ANPD não aceita base legal quando
    // a parte vulnerável não tem meio efetivo de oposição: esta frase é a
    // salvaguarda, escrita.
    `Minha resposta não afeta em nada meu acesso aos projetos e serviços de ${org.name.trim()}.`,
    'Política de privacidade: {url}',
  ].join('\n');
}

/**
 * O texto nomeia a organização deste deploy? É o sinal (e só o sinal) de que uma
 * versão nova precisa ser publicada — um corpo que nomeia OUTRA organização é um
 * consentimento inválido, e a tela do admin avisa em vez de reescrever sozinha.
 */
export function namesOrganization(body: string, org: OrgNames): boolean {
  const t = fold(body);
  return t.includes(fold(org.name)) || t.includes(fold(org.legalName));
}

/** `Associação São João` → `associacao-sao-joao` (cabe no `version` do schema). */
function slug(text: string): string {
  return fold(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Rótulo sugerido para a versão nova: `optin-<organização>-vN`. Incrementa até
 * não colidir — o par (version, purposeKey) é único, e publicar é sempre CRIAR.
 */
export function suggestTextVersion(
  org: OrgNames,
  existingVersions: readonly string[],
): string {
  const base = `optin-${slug(org.name) || 'org'}`;
  const taken = new Set(existingVersions.map((v) => v.toLowerCase()));
  let n = 1;
  while (taken.has(`${base}-v${n}`)) n += 1;
  return `${base}-v${n}`;
}
