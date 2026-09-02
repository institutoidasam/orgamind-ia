import { createHash } from 'crypto';
import { brazilianPhoneVariants } from '../contacts/phone.util';

/**
 * Chave DURÁVEL do consentimento: sha256(E164 + PICOA_CONSENT_SALT).
 *
 * É ela — e não `contactId` — que amarra um ConsentEvent / uma supressão ao
 * titular, porque o evento tem de sobreviver à exclusão do contato e à
 * reimportação da planilha (spec §2.1.5). O sal impede que a lista de
 * supressão, vazando, vire uma lista de telefones em claro reversível por
 * dicionário (o espaço de números BR é pequeno demais para sha256 puro).
 *
 * ATENÇÃO: trocar o sal orfaniza toda a supressão já gravada — na prática,
 * ressuscita quem deu PARAR. Ver o comentário em env.schema.ts.
 */
export function phoneHash(phoneE164: string, salt: string): string {
  return createHash('sha256').update(`${phoneE164}${salt}`).digest('hex');
}

/**
 * Hashes das DUAS formas brasileiras do número (com e sem o 9º dígito).
 *
 * Sem isto a supressão teria um furo silencioso: a Evolution ecoa o JID legado
 * de 8 dígitos enquanto o contato está salvo canonicamente com o 9 (ou
 * vice-versa), e o hash de uma forma não casa com o da outra. O resto do código
 * já se defende assim (`brazilianPhoneVariants` no chat-ingest e no webhook);
 * a lista de supressão, que é a garantia de que "PARAR" significa parar, não
 * pode ser o único lugar que não se defende.
 */
export function phoneHashVariants(phoneE164: string, salt: string): string[] {
  return brazilianPhoneVariants(phoneE164).map((v) => phoneHash(v, salt));
}
