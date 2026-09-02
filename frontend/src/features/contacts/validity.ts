/**
 * ESPELHO de `backend/src/shared/contact-validity.ts`.
 *
 * O front não importa `@prisma/client` nem o código do back, então as três
 * classes e os rótulos são mantidos à mão aqui — mesmo arranjo (e mesmo risco
 * conhecido) de `FAILURE_REASONS`/`FAILURE_REASON_LABELS` em
 * `features/campaigns/schemas.ts`. Se o back mudar, este arquivo muda junto.
 *
 * O DESEMPATE é o mesmo do back: quando os dois sinais colidem, INVÁLIDO
 * VENCE. Se a tela desempatasse ao contrário, o operador veria "Válido" numa
 * linha que o disparo exclui — e o produto voltaria a ter duas verdades.
 */
export const CONTACT_VALIDITIES = ['valid', 'invalid', 'unvalidated'] as const;
export type ContactValidity = (typeof CONTACT_VALIDITIES)[number];

/** Como a LINHA é rotulada (singular) — é o texto que a planilha imprime. */
export const CONTACT_VALIDITY_LABELS: Record<ContactValidity, string> = {
  valid: 'Válido',
  invalid: 'Inválido confirmado',
  unvalidated: 'Não validado',
};

/** Como a OPÇÃO DO FILTRO é rotulada (plural). */
export const CONTACT_VALIDITY_FILTER_LABELS: Record<ContactValidity, string> = {
  valid: 'Válidos',
  invalid: 'Inválidos confirmados',
  unvalidated: 'Não validados',
};

/**
 * A explicação de uma linha — vai no `title` da coluna "WA" e como legenda da
 * opção do filtro. Escrita para o OPERADOR: diz o que aconteceu, não qual
 * coluna está preenchida.
 */
export const CONTACT_VALIDITY_HINTS: Record<ContactValidity, string> = {
  valid: 'Válido — o WhatsApp confirmou este número, ou uma mensagem já foi entregue nele.',
  invalid:
    'Inválido confirmado — o WhatsApp recusou este número, ou um envio falhou por número inexistente/telefone inválido.',
  unvalidated: 'Não validado — ninguém checou este número ainda, e nada foi entregue nele.',
};

/** Os dois motivos de falha que provam invalidez DO NÚMERO (espelho do back). */
const INVALID_FAILURE_REASONS = ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'];

/**
 * Classifica UMA LINHA da lista.
 *
 * B.6, review (achado 1) — o back agora manda `validity` JÁ CLASSIFICADO na
 * própria linha (`classifyContactValidity`, com a sonda de entrega provada
 * que só ele pode fazer): esta função usa ele quando presente. A derivação
 * por `whatsappValid`+`lastFailureReason` abaixo é só o FALLBACK para uma
 * resposta em cache de ANTES desta mudança (o React Query pode servir dados
 * antigos do cache local antes do próximo fetch) — sem ela, o front nunca via
 * a terceira evidência (entrega provada) e uma linha com mensagem
 * DELIVERED/READ mas `whatsappValid: null` aparecia como "Não validado" na
 * coluna enquanto `?validity=valid`, o export e o N do diálogo de
 * sincronização já a contavam como válida.
 */
export function contactValidityOf(c: {
  whatsappValid: boolean | null;
  lastFailureReason: string | null;
  validity?: ContactValidity;
}): ContactValidity {
  if (c.validity) return c.validity;
  if (c.whatsappValid === false) return 'invalid';
  if (c.lastFailureReason && INVALID_FAILURE_REASONS.includes(c.lastFailureReason)) {
    return 'invalid';
  }
  if (c.whatsappValid === true) return 'valid';
  return 'unvalidated';
}
