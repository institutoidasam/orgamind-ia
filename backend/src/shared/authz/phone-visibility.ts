import { maskPhone } from '../audit/audit-change';

/**
 * Como o telefone sai na API (DB8/CB2). `phoneE164` só vai a quem tem a chave
 * `telefone.ver_completo`; os demais recebem `hasPhone` e a máscara. A regra do
 * setor (pessoa com login, só o ADMIN vê) vem por cima, com `hidden`.
 */
export type PhoneView = {
  phoneE164: string | null;
  hasPhone: boolean;
  phoneMasked: string | null;
};

export function phoneView(
  phoneE164: string | null | undefined,
  opts: { full: boolean; hidden?: boolean },
): PhoneView {
  if (!phoneE164)
    return { phoneE164: null, hasPhone: false, phoneMasked: null };
  // Regra do setor: o front mostra "—", sem máscara nem "Sem telefone".
  if (opts.hidden)
    return { phoneE164: null, hasPhone: true, phoneMasked: null };
  return {
    phoneE164: opts.full ? phoneE164 : null,
    hasPhone: true,
    phoneMasked: maskPhone(phoneE164),
  };
}

const PHONE_LIKE_CHARS = /^[\d+ ().-]+$/;
const MIN_PHONE_DIGITS = 8;
/** Formatação invisível (Unicode Cf): marcas de direção, embedding/isolado, zero-width, BOM. */
const INVISIBLE_CHARS = /\p{Cf}/gu;
/** NBSP e os demais espaços contam como espaço. */
const ANY_SPACE = /\s/g;

/**
 * D11: pessoa criada de contato sem nome tem o número como nome; sem ver o telefone
 * completo, o nome não pode revelar o número. m1: nome vindo do WhatsApp traz
 * caracteres invisíveis e NBSP, que somem antes do teste; o ponto também separa.
 * Continua exigindo 8+ dígitos e nenhuma letra.
 */
export function isPhoneLikeName(name: string): boolean {
  const visible = name.replace(INVISIBLE_CHARS, '').replace(ANY_SPACE, ' ');
  return (
    PHONE_LIKE_CHARS.test(visible) &&
    visible.replace(/\D/g, '').length >= MIN_PHONE_DIGITS
  );
}

/**
 * Nome como sai na API. `full` = este leitor vê o telefone completo DESTA pessoa
 * (tem a chave e a pessoa não está `hidden`). Só a saída muda: banco, trilha e
 * comparações usam o nome real.
 */
export function nameView(name: string, opts: { full: boolean }): string;
export function nameView(
  name: string | null,
  opts: { full: boolean },
): string | null;
export function nameView(
  name: string | null,
  opts: { full: boolean },
): string | null {
  if (opts.full || name === null || !isPhoneLikeName(name)) return name;
  // Mesma máscara de `phoneView`; com 8+ dígitos `maskPhone` nunca é nulo.
  return maskPhone(name.replace(/\D/g, '')) ?? '';
}

/**
 * Busca por nome sem a chave: nome-telefone (D11) só casa termo sem letra, então
 * termo sem nenhuma letra não busca por nome (ninguém confirma dígitos por tentativa).
 */
export function nameSearchAllowed(
  term: string,
  opts: { full: boolean },
): boolean {
  return opts.full || /\p{L}/u.test(term);
}
