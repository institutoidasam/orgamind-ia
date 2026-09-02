import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Normalize a raw phone number string to E.164 format.
 * @param raw The raw input (e.g. "(92) 98765-4321", "+5592987654321").
 * @param defaultCountry ISO country code to use if no country prefix is provided.
 * @returns the E.164 string (e.g. "+5592987654321") or null when invalid/empty.
 */
export function normalizeToE164(
  raw: string,
  defaultCountry: CountryCode = 'BR',
): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Produce every E.164 form a Brazilian mobile may legitimately appear as.
 *
 * O Brasil PREFIXOU um 9 aos celulares em 2012, mas o WhatsApp (Evolution/
 * Baileys, e o Zernio) ainda reporta o JID de algumas contas na forma LEGADA de
 * 8 dígitos. Um contato salvo canonicamente como `+5592986550101` chega no
 * webhook como `+559286550101`. Para ligar a conversa ao contato — e para achar
 * a SUPRESSÃO — temos de casar as DUAS formas.
 *
 * A REGRA, e o bug que ela conserta:
 *
 *   O 9 é um PREFIXO. A forma legada é a moderna MENOS esse 9 — e o que sobra
 *   começa com o dígito ORIGINAL do celular, que a Anatel aloca em **6, 7, 8 ou
 *   9**. NÃO só 9.
 *
 *   O código anterior exigia `startsWith('9')` TAMBÉM na forma de 8 dígitos,
 *   então só reconhecia os celulares `9 9…`. Todo `9 8…`, `9 7…`, `9 6…` — a
 *   maioria da base — não gerava variante: o inbound chegava na forma legada,
 *   não casava com ninguém, e o ingest CRIAVA UM CONTATO NOVO. Aconteceu de
 *   verdade (~20 duplicatas na primeira campanha). E o mesmo furo estava
 *   debaixo de `phoneHashVariants`, ou seja, debaixo da lista de SUPRESSÃO: um
 *   "PARAR" gravado numa forma não seria encontrado pela outra.
 *
 * Layout: `+55` + DDD (2 díg.) + subscriber.
 *   - Celular moderno: 9 díg. = `9` + [6-9] + 7 díg. → legado = tira o 9.
 *   - Celular legado:  8 díg. = [6-9] + 7 díg.       → moderno = prefixa o 9.
 *   - Fixo:            8 díg. começando com 2-5      → SEM variante (prefixar um
 *     9 ali fabricaria um número que não é dessa pessoa).
 *
 * As duas regras formam uma BIJEÇÃO — por isso a função é idempotente: a
 * variante da variante devolve o original. Exigir [6-9] no miolo também cobre o
 * inverso do fixo: `+5592932145678` é `9` + `3…`, não é celular, e tirar o 9
 * fabricaria o fixo de outra pessoa.
 *
 * Returns the input first, then any alternate, de-duplicated. Non-BR or
 * unrecognized inputs return just `[input]`.
 */
export function brazilianPhoneVariants(e164: string): string[] {
  const variants = [e164];
  const m = /^\+55(\d{2})(\d+)$/.exec(e164);
  if (m) {
    const ddd = m[1];
    const subscriber = m[2];
    if (/^9[6-9]\d{7}$/.test(subscriber)) {
      // Celular moderno (9 díg.) → forma legada, sem o 9 prefixado.
      variants.push(`+55${ddd}${subscriber.slice(1)}`);
    } else if (/^[6-9]\d{7}$/.test(subscriber)) {
      // Celular legado (8 díg.) → forma moderna, com o 9 prefixado.
      variants.push(`+55${ddd}9${subscriber}`);
    }
  }
  return [...new Set(variants)];
}

/**
 * A CHAVE DE IDENTIDADE do assinante: a forma MODERNA (13 díg., com o 9
 * prefixado) quando o número é um celular brasileiro; o próprio número em
 * qualquer outro caso.
 *
 * As duas grafias do 9º dígito são a MESMA conta de WhatsApp, mas o banco guarda
 * uma string. Quando é preciso escolher UMA — a chave de um Map, o desempate
 * entre dois gêmeos que ainda coexistem na base, o canônico de uma fusão — a
 * escolha tem de ser a MESMA em todo lugar, senão dois caminhos de escrita
 * elegem linhas diferentes e o gêmeo volta a nascer.
 *
 * Escolhemos a de 13 dígitos porque é a forma que o operador digita e a que a
 * planilha traz.
 *
 * ⚠️ Isto é um desempate de LEITURA, e vale só enquanto as duas linhas coexistem.
 * NÃO use esta função para decidir quem sobrevive a uma fusão: a fusão APAGA uma
 * linha, e o incidente do 9º dígito ([[picoa-9o-digito-entrega]]) mostrou que a
 * grafia de 13 dígitos pode ser justamente a que NÃO entrega. Quem decide isso é
 * `elect`, em `prisma/merge-duplicate-phone-contacts.ts`, olhando a evidência de
 * entrega — e depois da fusão sobra uma linha só, então este desempate some.
 *
 * A bijeção garante no máximo duas variantes, diferindo por um único dígito
 * prefixado — por isso "a mais longa" é sempre a moderna.
 */
export function canonicalBrPhoneForm(e164: string): string {
  return brazilianPhoneVariants(e164).reduce((a, b) =>
    b.length > a.length ? b : a,
  );
}
