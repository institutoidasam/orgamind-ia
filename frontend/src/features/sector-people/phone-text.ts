import { formatPhoneBR } from '@/lib/format-phone';

/**
 * DB8: o telefone completo formatado quando a API o mandou (`telefone.ver_completo`); senão a máscara
 * ("•••• 1234"); sem nenhum dos dois (pessoa com acesso para quem não é ADMIN), "—".
 * Nunca deriva o número de outro campo: sem a chave ele não chega à tela.
 */
export function phoneText(phone: { phoneE164: string | null; phoneMasked: string | null }): string {
  return phone.phoneE164 ? formatPhoneBR(phone.phoneE164) : (phone.phoneMasked ?? '—');
}

const MASKED_NAME = /^•{4} \d{4}$/;

/** Nome gravado que é o próprio telefone, devolvido mascarado ("•••• 1234") a quem não tem `telefone.ver_completo`. */
export function isMaskedName(name: string): boolean {
  return MASKED_NAME.test(name);
}
