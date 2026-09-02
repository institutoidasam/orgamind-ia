/**
 * C4 — consentimento coletado no PAPEL/presencial, importado por planilha
 * (spec §3.3).
 *
 * A Meta lista "In person or on paper (customers can sign a physical document
 * to opt in)" como fonte oficial de opt-in, e é a fonte que o IDASAM mais usa em
 * campo. Também é a de **maior risco prático**: a pessoa assinou há meses, não
 * lembra, e clica em *Denunciar* — que é o mecanismo real de banimento.
 *
 * Daí as regras duras deste parser. Uma linha só vira GRANT quando declara as
 * QUATRO coisas que fazem dela um consentimento provável em juízo:
 *
 *  1. **consentimento = SIM** — ato afirmativo. Vazio não é sim; "talvez" não é
 *     sim; ausência de coluna não é sim.
 *  2. **referência ao termo assinado** (`termo_ref`/`versao_termo`) — sem apontar
 *     para o papel, o "consentimento" é auto-declarado pelo IDASAM sobre si
 *     mesmo. Um "autorizo contato" genérico numa folha de presença **não** é
 *     opt-in, nem para a Meta nem para a LGPD.
 *  3. **finalidade** — da coluna `finalidade` ou do parâmetro do import.
 *     Autorização genérica é NULA (art. 8º §4º).
 *  4. **data de coleta** — porque `occurredAt` é a data em que a PESSOA assinou,
 *     não a data em que o operador subiu a planilha. Gravar `hoje` num termo de
 *     8 meses faria um consentimento velho parecer fresco e furaria a regra de
 *     frescor de 90 dias do §3.3 — que é a única salvaguarda contra o risco
 *     acima.
 *
 * Faltando qualquer uma: o contato é importado **sem** consentimento. Não se
 * inventa o que a ficha não diz.
 */

/**
 * Cabeçalhos que este importador entende como consentimento. Precisam ser
 * CONHECIDOS pelo `excel.service` para não caírem em `Contact.customFields` —
 * `termo_ref` é evidência jurídica, não campo solto de planilha.
 */
export const CONSENT_COLUMN_KEYS = [
  'consentimento',
  'termo_ref',
  'versao_termo',
  'finalidade',
  'data_coleta',
  'evento_local',
  'link_scan',
  'hash_scan',
] as const;

/** O que a linha autoriza, já validado. Vira um `ConsentEvent(GRANT, PAPER_FORM)`. */
export type PaperConsentIntent = {
  purposeKey: string;
  /** A referência do termo assinado — `termo_ref` ou `versao_termo`. */
  termRef: string;
  /** `occurredAt`: quando a pessoa ASSINOU. */
  collectedAt: Date;
  eventName: string | null;
  scanUrl: string | null;
  scanSha256: string | null;
};

export type PaperConsentParse =
  /** A planilha não declarou consentimento nenhum nesta linha. */
  | { kind: 'absent' }
  /** A pessoa disse NÃO. */
  | { kind: 'refused' }
  /** Disse SIM, mas falta o que torna o SIM provável. Reportado ao operador. */
  | { kind: 'incomplete'; reason: string }
  | { kind: 'granted'; intent: PaperConsentIntent };

const TRUTHY = new Set(['sim', 's', 'x', 'true', '1', 'yes', 'y']);
const FALSY = new Set(['nao', 'não', 'n', 'false', '0', 'no']);

/**
 * `null` = ausente/ilegível. Deliberadamente NÃO é `false`: "não consta" e "a
 * pessoa recusou" são estados diferentes, e só o segundo é uma informação sobre
 * a vontade dela. Um valor que não é nem sim nem não também é `null` — adivinhar
 * a intenção de "talvez" é exatamente o tipo de fabricação que esta feature
 * existe para eliminar.
 */
export function parseConsentFlag(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/**
 * `YYYY-MM-DD` (o que `cellToString` produz para célula de data do Excel) e
 * `DD/MM/YYYY` (o que o operador digita). Meio-dia UTC para que a data não
 * "ande" um dia para trás em Manaus (UTC-4) ao ser exibida.
 */
export function parseCollectedAt(value: string | undefined): Date | null {
  const v = (value ?? '').trim();
  if (!v) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);

  const [y, m, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : br
      ? [Number(br[3]), Number(br[2]), Number(br[1])]
      : [NaN, NaN, NaN];

  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return null;

  const date = new Date(Date.UTC(y, m - 1, d, 12));
  // Rejeita 99/99/2026 & cia: o Date rola o excedente para o mês seguinte em
  // silêncio, então conferimos que os componentes voltaram iguais.
  const valid =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  return valid ? date : null;
}

const pick = (
  raw: Record<string, string>,
  ...keys: string[]
): string | null => {
  for (const k of keys) {
    const v = raw[k]?.trim();
    if (v) return v;
  }
  return null;
};

/**
 * @param defaultPurposeKey finalidade declarada no import (quando a planilha não
 * tem a coluna). A coluna da LINHA sempre vence: a ficha assinada é a fonte, e o
 * parâmetro do import é só o preenchimento de uma planilha homogênea.
 */
export function parsePaperConsent(
  raw: Record<string, string>,
  defaultPurposeKey: string | null,
): PaperConsentParse {
  const flag = parseConsentFlag(raw.consentimento);
  if (flag === null) return { kind: 'absent' };
  if (flag === false) return { kind: 'refused' };

  const termRef = pick(raw, 'termo_ref', 'versao_termo');
  if (!termRef) {
    return {
      kind: 'incomplete',
      reason:
        'consentimento SIM sem referência ao termo assinado (termo_ref/versao_termo) — um "autorizo contato" genérico não é opt-in',
    };
  }

  const purposeKey =
    pick(raw, 'finalidade') ?? defaultPurposeKey?.trim() ?? null;
  if (!purposeKey) {
    return {
      kind: 'incomplete',
      reason:
        'consentimento SIM sem finalidade (coluna `finalidade` ou parâmetro do import) — autorização genérica é nula',
    };
  }

  const collectedAt = parseCollectedAt(raw.data_coleta);
  if (!collectedAt) {
    return {
      kind: 'incomplete',
      reason:
        'consentimento SIM sem data de coleta válida (data_coleta) — sem ela, um termo antigo entraria como se fosse de hoje',
    };
  }

  return {
    kind: 'granted',
    intent: {
      purposeKey,
      termRef,
      collectedAt,
      eventName: pick(raw, 'evento_local'),
      scanUrl: pick(raw, 'link_scan'),
      scanSha256: pick(raw, 'hash_scan'),
    },
  };
}

/**
 * O `evidenceText` de um GRANT de papel.
 *
 * NÃO é o texto canônico do `ConsentText`: o orgamind não viu a ficha e não pode
 * afirmar o que estava escrito nela. O que ele pode afirmar — e é isto que a
 * prova precisa — é QUAL artefato físico foi assinado, QUANDO, ONDE, e onde o
 * scan está guardado. A ficha digitalizada é a evidência forte; este texto é o
 * ponteiro auditável para ela.
 */
export function buildPaperEvidenceText(args: {
  intent: PaperConsentIntent;
  purposeLabel: string;
  filename: string;
  batchId: string;
  rowNumber: number;
}): string {
  const { intent, purposeLabel, filename, batchId, rowNumber } = args;
  const assinadoEm = intent.collectedAt.toISOString().slice(0, 10);
  const local = intent.eventName ? ` em ${intent.eventName}` : '';
  const scan =
    intent.scanUrl ??
    (intent.scanSha256
      ? `sha256:${intent.scanSha256}`
      : 'NÃO ANEXADA (consentimento auto-declarado)');

  return [
    'Consentimento coletado presencialmente, em ficha de papel assinada pelo titular.',
    `Termo assinado: ${intent.termRef}.`,
    `Finalidade: ${purposeLabel} (${intent.purposeKey}).`,
    `Assinado em ${assinadoEm}${local}.`,
    `Ficha digitalizada: ${scan}.`,
    `Importado da planilha "${filename}" (lote ${batchId}, linha ${rowNumber}).`,
  ].join('\n');
}
