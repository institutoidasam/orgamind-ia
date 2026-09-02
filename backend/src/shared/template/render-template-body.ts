/**
 * Renderiza o corpo APROVADO do template com as variáveis já resolvidas.
 *
 * Uma implementação só, compartilhada por dois chamadores que precisam
 * concordar caractere a caractere:
 *  - o adapter do Evolution, que MANDA este texto pelo fio (provedor não-oficial);
 *  - o worker de envio, que GRAVA este texto em `Message.content` — a bolha do
 *    Inbox, o export e a evidência de consentimento por botão (LGPD art. 8º §4º)
 *    saem daí.
 *
 * Variável ausente fica literal (`{{nome}}`), preservando o comportamento
 * histórico do interpolate do Evolution: sumir com o marcador esconderia do
 * operador que a campanha saiu com um buraco.
 */
export function renderTemplateBody(
  body: string | null | undefined,
  vars: Record<string, string>,
): string {
  if (!body) return '';
  let out = body;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}
