/**
 * ★ A PORTA QUE IMPEDE "Olá , tudo bem?" PARA 13.400 PESSOAS.
 *
 * ## O achado que muda o desenho do broadcast
 *
 * O `POST /v1/broadcasts/{id}/recipients` do Zernio aceita
 * `{contactIds[], phones[], useSegment}` — e **NADA MAIS**. Não existe "variáveis
 * por destinatário" nesse endpoint, por mais natural que a ideia pareça.
 *
 * As variáveis do template são resolvidas por um `variableMapping` declarado UMA
 * VEZ, na CRIAÇÃO do broadcast, e ele mapeia cada placeholder para um **campo do
 * CRM DO ZERNIO**:
 *
 *     variableMapping: { "1": { field: name|phone|email|company|custom,
 *                               customValue?: string } }
 *
 * Ou seja: quem personaliza é o **cadastro do contato lá**, não um payload nosso.
 *
 * ## Por que isso é PERIGOSO, e não só limitante
 *
 * Nós adicionamos destinatários por `phones[]` — que **auto-cria o contato no CRM
 * do Zernio com o TELEFONE e mais nada**. O `name` desse contato nasce VAZIO.
 * Um template com `{{1}} = nome do contato` seria então resolvido contra um campo
 * vazio, e a campanha eleitoral inteira sairia como:
 *
 *     "Olá , tudo bem?"
 *
 * — entregue, cobrada, e irreversível. O envio 1-a-1 do orgamind nunca teve esse
 * problema porque monta a variável a partir do NOSSO banco, no ato do envio
 * (`enrichVariablesWithContact`).
 *
 * ## A decisão
 *
 * O broadcast só é permitido quando TODA variável da campanha é **literal** (ou
 * quando não há variável nenhuma). Literal vira `custom`+`customValue`, que é
 * igual para todo mundo — e é exatamente o que um literal significa.
 *
 * Qualquer variável ligada a um CAMPO DO CONTATO (`source: 'field'`) **bloqueia o
 * caminho de broadcast**, com o nome da variável culpada no erro. A campanha
 * então segue pelo 1-a-1, que é o PADRÃO e continua correto.
 *
 * A alternativa — espelhar os 13.400 contatos (com NOME) dentro do CRM do Zernio
 * via `POST /v1/contacts/bulk` e usar `contactIds[]` + `field: 'name'` — é um
 * projeto à parte: copia dado pessoal de eleitor para um terceiro, precisa de
 * sincronização e de base legal própria. Não se faz isso de véspera, e muito
 * menos por acidente.
 */

/** Os campos que o `variableMapping` do Zernio entende. */
export type ZernioVariableField =
  | 'name'
  | 'phone'
  | 'email'
  | 'company'
  | 'custom';

export type ZernioVariableMapping = Record<
  string,
  { field: ZernioVariableField; customValue?: string }
>;

export type BroadcastVariablePlan =
  | { broadcastable: true; variableMapping: ZernioVariableMapping }
  | {
      broadcastable: false;
      /** As variáveis que dependem do contato — as culpadas, pelo nome. */
      perContactKeys: string[];
      reason: string;
    };

/** O `variableMap` da Campaign, na forma mínima que interessa aqui. */
type VariableMapLike = Record<
  string,
  { source: string; value?: string; field?: string }
>;

/** 1, 2, 10 — NUNCA 1, 10, 2. O placeholder é posicional. */
function byNumericKey(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}

/**
 * A campanha pode ir por BROADCAST? E, se pode, qual é o `variableMapping`?
 *
 * Ver o cabeçalho: é este predicado que separa "o Zernio consegue montar esta
 * mensagem sozinho" de "só o orgamind consegue, porque o dado é nosso".
 */
export function planBroadcastVariables(
  variableMap: VariableMapLike,
): BroadcastVariablePlan {
  const keys = Object.keys(variableMap ?? {}).sort(byNumericKey);

  const perContactKeys = keys.filter(
    (k) => variableMap[k]?.source === 'field',
  );

  if (perContactKeys.length > 0) {
    return {
      broadcastable: false,
      perContactKeys,
      reason:
        `As variáveis ${perContactKeys.map((k) => `{{${k}}}`).join(', ')} vêm de um CAMPO DO CONTATO ` +
        `(ex.: o nome). O broadcast do Zernio resolve variáveis contra o CRM DELE, e os destinatários ` +
        `adicionados por telefone nascem lá SEM nome — a mensagem sairia com a variável em branco ` +
        `("Olá , tudo bem?"). Esta campanha tem de sair pelo envio 1-a-1, que monta a variável a partir ` +
        `do banco do orgamind.`,
    };
  }

  const variableMapping: ZernioVariableMapping = {};
  for (const k of keys) {
    // Só sobram literais (o filtro acima já removeu os 'field').
    variableMapping[k] = {
      field: 'custom',
      customValue: variableMap[k]?.value ?? '',
    };
  }

  return { broadcastable: true, variableMapping };
}
