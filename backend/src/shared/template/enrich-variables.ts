export type ContactSubset = {
  name: string | null;
  city: string | null;
  group: string | null;
  phoneE164: string;
};

/**
 * Completa as variáveis do template que o `variableMap` da campanha não cobriu,
 * adivinhando a partir do cadastro do contato. Sem isto, provedores não-oficiais
 * (Evolution) mandariam "Olá {{nome}}!" literal quando o operador esqueceu de
 * mapear a variável no wizard.
 *
 * Mora aqui (e não mais só no worker) porque o REPARO de dados
 * (prisma/repair-campaign-message-content.ts) precisa reproduzir, caractere a
 * caractere, o texto que o worker mandou pelo fio — importar o worker num script
 * de manutenção arrastaria BullMQ/Nest/Sentry junto.
 */
export function enrichVariablesWithContact(
  current: Record<string, string>,
  templateVars: string[],
  contact: ContactSubset,
): Record<string, string> {
  const out = { ...current };
  for (const v of templateVars) {
    if (out[v] !== undefined) continue;
    const lc = v.toLowerCase();
    if (/^(nome|name|cliente|contato|destinatario)/.test(lc)) {
      out[v] = contact.name ?? '';
    } else if (/^(cidade|city|local)/.test(lc)) {
      out[v] = contact.city ?? '';
    } else if (/^(grupo|group|categoria)/.test(lc)) {
      out[v] = contact.group ?? '';
    } else if (/^(tel|phone|fone|whats)/.test(lc)) {
      out[v] = contact.phoneE164;
    } else {
      out[v] = '';
    }
  }
  return out;
}
