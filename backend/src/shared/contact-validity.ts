import { FailureReason } from '@prisma/client';
import type { MessageStatus, Prisma } from '@prisma/client';
import type { FilterGroup } from '../schemas/contracts/filter.schema';

/**
 * A SEMÂNTICA ÚNICA DE VALIDADE (spec 2026-08-24, B.1).
 *
 * Antes deste arquivo, "número inválido" tinha três respostas diferentes no
 * produto: o toggle do assistente perguntava `whatsappValid = true` (numa base
 * toda NULL, seleciona ZERO), a aba de falhas olhava `Message.failureReason` e
 * a coluna "WA" da lista olhava só `whatsappValid`. Aqui existe UMA definição,
 * e todo mundo — lista, export, exclusão em massa, filtro de campanha — a
 * consome.
 *
 * ── POR QUE NADA AQUI USA `NOT` ──────────────────────────────────────────────
 * `NOT: { whatsappValid: false }` vira `NOT (whatsappValid = false)` no
 * Postgres. Para uma linha com NULL isso avalia NULL, e NULL não é TRUE: a
 * linha SOME do resultado. O mesmo vale para `notIn` sozinho. Como a base de
 * produção é majoritariamente NULL nos dois campos, a versão ingênua destes
 * predicados devolve conjuntos vazios em silêncio — o defeito que a Fase B
 * existe para consertar. Todo complemento abaixo é escrito como `OR`
 * EXPLÍCITO, incluindo o ramo `{ campo: null }`. É chato e é correto (mesma
 * ressalva de `handledInCampaignFilter`, batch-audience.ts, e do docblock de
 * `listFailedContactsPaged`, campaigns.repository.ts).
 *
 * ── AS TRÊS CLASSES SÃO DISJUNTAS E EXAUSTIVAS ───────────────────────────────
 * A spec define "inválido" e "válido" por sinais que PODEM coexistir na mesma
 * linha (`whatsappValid = true` + `lastFailureReason = SEM_WHATSAPP`). Quando
 * coexistem, INVÁLIDO VENCE: é a evidência negativa mais recente e o lado
 * seguro para decidir a quem NÃO enviar. Sem esse desempate o mesmo contato
 * apareceria em dois filtros e as três contagens não fechariam com o total.
 */
export const CONTACT_VALIDITIES = ['valid', 'invalid', 'unvalidated'] as const;
export type ContactValidity = (typeof CONTACT_VALIDITIES)[number];

/** Rótulo em PT-BR — é o que o operador lê na planilha e no filtro. */
export const CONTACT_VALIDITY_LABELS: Record<ContactValidity, string> = {
  valid: 'Válido',
  invalid: 'Inválido confirmado',
  unvalidated: 'Não validado',
};

/**
 * Os motivos de falha que provam invalidez DO NÚMERO (e não do envio, do
 * canal ou da vontade do destinatário). OPT_OUT, CANAL_FORA e
 * MARKETING_DESLIGADO ficam DE FORA de propósito: o número existe, a pessoa é
 * que não quer (ou o canal caiu). Mantém 1:1 com `SEM_WHATSAPP_CODES` e
 * `TELEFONE_INVALIDO_CODES` de campaigns/failure-reason.ts.
 */
export const INVALID_FAILURE_REASONS: FailureReason[] = [
  FailureReason.SEM_WHATSAPP,
  FailureReason.TELEFONE_INVALIDO,
];

/**
 * ENTREGA PROVA O NÚMERO. `SENT` sozinho NÃO prova: o incidente do 9º dígito
 * ([[picoa-9o-digito-entrega]]) mediu o mesmo número parar em `Sent` para
 * sempre na grafia errada — o WhatsApp aceita a stanza e a descarta calado.
 */
export const DELIVERY_PROVEN_STATUSES: MessageStatus[] = ['DELIVERED', 'READ'];

function deliveryProvenFilter(): Prisma.MessageWhereInput {
  return { direction: 'OUTBOUND', status: { in: DELIVERY_PROVEN_STATUSES } };
}

/** O motivo não é um dos dois que invalidam — NULL-SAFE. */
function failureReasonNotInvalidWhere(): Prisma.ContactWhereInput {
  return {
    OR: [
      { lastFailureReason: null },
      { lastFailureReason: { notIn: INVALID_FAILURE_REASONS } },
    ],
  };
}

/** Inválido confirmado: `whatsappValid = false` OU motivo que invalida o número. */
export function invalidContactWhere(): Prisma.ContactWhereInput {
  return {
    OR: [
      { whatsappValid: false },
      { lastFailureReason: { in: INVALID_FAILURE_REASONS } },
    ],
  };
}

/**
 * O COMPLEMENTO de `invalidContactWhere`, null-safe — as 4 regras que o toggle
 * do assistente emite (B.4). É o que "Excluir inválidos confirmados" significa.
 */
export function excludeInvalidWhere(): Prisma.ContactWhereInput {
  return {
    AND: [
      { OR: [{ whatsappValid: null }, { whatsappValid: true }] },
      failureReasonNotInvalidWhere(),
    ],
  };
}

/** Válido: não é inválido E (o WhatsApp confirmou OU alguma mensagem foi entregue). */
export function validContactWhere(): Prisma.ContactWhereInput {
  return {
    AND: [
      excludeInvalidWhere(),
      {
        OR: [
          { whatsappValid: true },
          { messages: { some: deliveryProvenFilter() } },
        ],
      },
    ],
  };
}

/**
 * Não validado: o resto. Escrito por extenso (e não como `NOT` do válido)
 * porque negar o `OR` acima reintroduziria a semântica três-valorada.
 * `messages: { none: … }` vira `NOT EXISTS`, que é seguro com NULL.
 */
export function unvalidatedContactWhere(): Prisma.ContactWhereInput {
  return {
    AND: [
      { whatsappValid: null },
      failureReasonNotInvalidWhere(),
      { messages: { none: deliveryProvenFilter() } },
    ],
  };
}

/** Despachante — o que lista, export e exclusão em massa chamam. */
export function contactValidityWhere(
  v: ContactValidity,
): Prisma.ContactWhereInput {
  switch (v) {
    case 'invalid':
      return invalidContactWhere();
    case 'valid':
      return validContactWhere();
    case 'unvalidated':
      return unvalidatedContactWhere();
  }
}

/**
 * A MESMA regra, em memória — para rotular UMA linha já carregada (a coluna
 * "situação" da planilha). A ordem dos ramos é a do desempate documentado no
 * topo: inválido primeiro.
 */
export function classifyContactValidity(c: {
  whatsappValid: boolean | null;
  lastFailureReason: FailureReason | null;
  hasProvenDelivery: boolean;
}): ContactValidity {
  if (c.whatsappValid === false) return 'invalid';
  if (
    c.lastFailureReason !== null &&
    INVALID_FAILURE_REASONS.includes(c.lastFailureReason)
  ) {
    return 'invalid';
  }
  if (c.whatsappValid === true || c.hasProvenDelivery) return 'valid';
  return 'unvalidated';
}

type FilterNode = {
  combinator?: unknown;
  rules?: unknown;
  field?: unknown;
  op?: unknown;
  value?: unknown;
};

function matchesRule(
  n: unknown,
  field: string,
  op: string,
  value?: unknown,
): boolean {
  const r = n as FilterNode | null;
  if (!r || r.combinator !== undefined) return false;
  if (r.field !== field || r.op !== op) return false;
  if (value === undefined) return r.value === undefined;
  return JSON.stringify(r.value) === JSON.stringify(value);
}

/**
 * Reconhece, DENTRO DO FILTRO DA CAMPANHA, o grupo que o toggle "Excluir
 * inválidos confirmados" emite (espelho de
 * `frontend/src/features/campaigns/exclude-invalid.ts`).
 *
 * Serve a uma pergunta só: QUANTOS a exclusão tirou. Para responder, a prévia
 * precisa da audiência SEM a exclusão — e é `stripExcludeInvalidGroup` que a
 * produz. Sem isto, a linha de exclusões mostraria sempre 0: o filtro que
 * chega já exclui os inválidos, então contá-los depois dá zero por
 * construção.
 */
export function isExcludeInvalidGroup(node: unknown): boolean {
  const g = node as FilterNode | null;
  if (!g || g.combinator !== 'and' || !Array.isArray(g.rules)) return false;
  if (g.rules.length !== 2) return false;
  const [a, b] = g.rules as FilterNode[];

  const validOk =
    a?.combinator === 'or' &&
    Array.isArray(a.rules) &&
    a.rules.length === 2 &&
    matchesRule(a.rules[0], 'whatsappValid', 'isNull') &&
    matchesRule(a.rules[1], 'whatsappValid', 'eq', true);

  const reasonOk =
    b?.combinator === 'or' &&
    Array.isArray(b.rules) &&
    b.rules.length === 2 &&
    matchesRule(b.rules[0], 'lastFailureReason', 'isNull') &&
    matchesRule(b.rules[1], 'lastFailureReason', 'notIn', [
      ...INVALID_FAILURE_REASONS,
    ]);

  return validOk && reasonOk;
}

export function hasExcludeInvalidGroup(g: FilterGroup): boolean {
  return g.rules.some(
    (r) =>
      isExcludeInvalidGroup(r) ||
      ('combinator' in r && hasExcludeInvalidGroup(r)),
  );
}

/**
 * O filtro sem o grupo de exclusão — em qualquer profundidade.
 *
 * Achado (review): um grupo ANINHADO que fica vazio depois do strip (era só
 * o GRUPO de exclusão, sob um `or`) não pode sobreviver como
 * `{combinator:'or', rules:[]}`. `groupToPrisma` (filter.converter.ts)
 * renderiza grupo vazio como `{}`, e `{}` dentro de um `OR` do Prisma é
 * sempre-verdadeiro — o `or` pai colapsaria para "casa todo mundo" e
 * `excludedInvalid` contaria cada inválido da janela, não só os que a
 * exclusão de fato tirou. Por isso o filtro final, depois de recursar e
 * remover o próprio GRUPO, também descarta os filhos que a recursão deixou
 * vazios. A RAIZ nunca é descartada por este filtro — só filhos são — então
 * um filtro que vira totalmente vazio ainda volta como
 * `{combinator, rules:[]}`, que `toPrismaWhere` já trata como "sem filtro do
 * usuário" (ver o `if (!g.rules.length) return {};` de `groupToPrisma`).
 */
export function stripExcludeInvalidGroup(g: FilterGroup): FilterGroup {
  return {
    combinator: g.combinator,
    rules: g.rules
      .filter((r) => !isExcludeInvalidGroup(r))
      .map((r) => ('combinator' in r ? stripExcludeInvalidGroup(r) : r))
      .filter((r) => !('combinator' in r) || r.rules.length > 0),
  };
}
