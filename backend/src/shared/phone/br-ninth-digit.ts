/**
 * O 9º dígito brasileiro — e por que ele custou uma campanha inteira.
 *
 * INCIDENTE DE PRODUÇÃO (2026-08-07): toda mensagem enviada pelo orgamind via
 * GoZap ficava eternamente em `Sent` e NUNCA era entregue, sem um único erro.
 * O orgamind manda o E.164 completo (`5592 9 9555-0101`, 13 dígitos), mas a conta
 * de WhatsApp do destinatário está registrada na forma ANTIGA, de 12 dígitos
 * (`5592 9555-0101`). O provedor monta um JID que não existe como identidade
 * registrada, o WhatsApp ACEITA a stanza e devolve um id — e descarta calado.
 *
 * Medido, no mesmo número e com minutos de diferença:
 *   13 dígitos → `Sent` para sempre;  12 dígitos → `Delivered` em 15s.
 *
 * A resolução do número canônico é do provedor (`POST /chat/check` no GoZap).
 * O papel DESTE módulo é a trava de segurança em cima dessa resposta: aceitar
 * o canônico SÓ quando ele for, comprovadamente, o mesmo assinante — porque
 * um endpoint de terceiro devolvendo outro número faria o orgamind disparar
 * campanha para a pessoa errada, que é dano muito pior que não entregar.
 */

/** `+55 92 99555-0101` / `5592995550101` → `5592995550101`. */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Decompõe um número BRASILEIRO em país+DDD e assinante. `null` para qualquer
 * coisa que não seja `55` + DDD(2) + assinante(8 ou 9) — inclusive números de
 * outros países, que NÃO ganham nenhuma tolerância aqui.
 */
function splitBr(value: string): { prefix: string; subscriber: string } | null {
  const d = digits(value);
  if (!d.startsWith('55')) return null;
  const rest = d.slice(2);
  // DDD (2) + assinante (8 fixo/antigo ou 9 móvel atual).
  if (rest.length !== 10 && rest.length !== 11) return null;
  return { prefix: d.slice(0, 4), subscriber: rest.slice(2) };
}

/**
 * `true` quando os dois números são o MESMO assinante, diferindo no máximo
 * pelo 9º dígito (nos dois sentidos: com→sem e sem→com).
 *
 * Fora do Brasil, e em qualquer formato que não reconheça, exige igualdade
 * EXATA — na dúvida, recusa. Um falso positivo aqui manda mensagem para
 * outra pessoa.
 */
export function isSameBrazilianSubscriber(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  if (da === db) return true;

  const pa = splitBr(da);
  const pb = splitBr(db);
  if (!pa || !pb) return false;
  if (pa.prefix !== pb.prefix) return false;

  const [curto, longo] =
    pa.subscriber.length <= pb.subscriber.length
      ? [pa.subscriber, pb.subscriber]
      : [pb.subscriber, pa.subscriber];
  // O único parentesco aceito: o longo é o curto com um `9` na frente — E o
  // curto precisa ser MÓVEL (assinante começando em 6-9). Sem essa checagem a
  // regra vale também para FIXO (começa em 2-5), e um fixo `3234-5678` seria
  // "o mesmo assinante" que o celular `9 3234-5678`, que é de OUTRA pessoa.
  // Mesma restrição de `contacts/phone.util.ts`, que só gera a variante para
  // `[6-9]\d{7}`.
  return (
    longo.length === 9 &&
    curto.length === 8 &&
    /^[6-9]/.test(curto) &&
    longo === `9${curto}`
  );
}
