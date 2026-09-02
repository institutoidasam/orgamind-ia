import { ContactSourceOrigin } from '@prisma/client';
import { parseConsentFlag } from '../excel-import/import-consent';

/**
 * C5 — a REGRA de classificação em coortes de procedência (spec §6.2), separada
 * do acesso ao banco de propósito: ela é o que a organização vai ter de defender
 * numa fiscalização, e uma regra que só existe dentro de um `UPDATE ... FROM` não é
 * auditável nem testável linha a linha.
 *
 * A pergunta que ela responde não é "quem consentiu" — é **de onde veio cada um
 * dos 13.000**. Sob a política da Meta, número sem declaração de recebimento é
 * "só um telefone"; sob a LGPD, a legítima expectativa depende da ORIGEM e da
 * IDADE do contato (Guia da ANPD, p. 23). Contato de procedência desconhecida é
 * literalmente o caso Telekall — a primeira multa da ANPD, disparada por UMA
 * denúncia. Com 13.000 destinatários, basta um reclamar.
 */

/** Os sinais que o banco já tem sobre um contato (spec §6.1). */
export type ContactSignals = {
  contactId: string;
  /** null = nunca checado. Ver a decisão sobre C5 abaixo. */
  whatsappValid: boolean | null;
  /** max(Conversation.lastInboundAt, última Message INBOUND). */
  lastInteractionAt: Date | null;
  /** Uma entrada por ImportItem: a linha original da planilha + o arquivo. */
  importRows: ImportRowSignal[];
};

export type ImportRowSignal = {
  /** ImportBatch.filename — frequentemente carrega a origem ("inscritos_curso_X_2023.xlsx"). */
  filename: string;
  /** ImportItem.rawRow: a linha original da planilha, PRESERVADA. */
  raw: Record<string, unknown>;
};

export type Classification = {
  origin: ContactSourceOrigin;
  /** Por que o classificador decidiu assim — a prova, em português, para o painel. */
  note: string;
};

/**
 * Cabeçalhos (já normalizados) que uma planilha legada usa para dizer que a
 * pessoa aceitou receber comunicações. Não é a lista do importador de papel
 * (`CONSENT_COLUMN_KEYS`, que é um contrato NOVO): aqui estamos lendo o que o
 * organização já tem, escrito por quem não sabia que isso viraria prova.
 *
 * É deliberadamente uma busca por RADICAL, não por igualdade: as planilhas reais
 * trazem "autorização", "autoriza contato", "aceite whatsapp", "opt-in", cada uma
 * com o seu acento e o seu espaço.
 */
const DECLARATION_RADICALS = [
  'consent', // consentimento, consente
  'autoriz', // autorização, autoriza contato
  'aceit', //  aceite, aceita receber
  'optin', //  opt-in, opt in (o hífen/espaço somem na normalização)
  'permiss', // permissão
];

/** lowercase, sem acento, sem separador — "Autorização" e "autoriza_cao" colidem. */
function normalizeKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A linha da planilha DECLARA que a pessoa aceitou receber comunicações?
 *
 * Devolve a coluna que provou (para a nota de auditoria) ou `null`. Reusa o
 * `parseConsentFlag` do importador de papel — e portanto herda a regra que
 * importa: "não consta" e "a pessoa recusou" são estados diferentes, "talvez"
 * não é sim, e ausência de coluna nunca é sim. Adivinhar a intenção é exatamente
 * a fabricação de consentimento que esta feature existe para eliminar.
 */
export function hasImportDeclaration(
  raw: Record<string, unknown>,
): { column: string; value: string } | null {
  for (const [key, value] of Object.entries(raw)) {
    const norm = normalizeKey(key);
    if (!DECLARATION_RADICALS.some((r) => norm.includes(r))) continue;
    const text = cellToText(value);
    if (parseConsentFlag(text) === true)
      return { column: key, value: text.trim() };
  }
  return null;
}

/**
 * A célula da planilha como texto. `rawRow` é Json cru: um objeto/array aninhado
 * ali dentro não é um "sim" — e stringificá-lo produziria `[object Object]`, que
 * o `parseConsentFlag` recusaria por acidente, não por regra. Melhor recusar de
 * propósito.
 */
function cellToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * A coorte de um contato. ORDEM ESTRITA da spec §6.2: **C5 exclui; depois C1 >
 * C2 > C3 > C4**. Um contato pode estar em C1 E C2 — vence C1, porque é a coorte
 * cuja AÇÃO é diferente (pedir permissão na janela aberta, de graça).
 *
 * Uma decisão que a spec deixa ambígua e que resolvemos aqui: C5 é descrita como
 * "`whatsappValid = false`, **ou nunca checado**". Tomar "nunca checado" ao pé da
 * letra jogaria a base inteira (13k, nenhuma checada) em C5 — e como C5 EXCLUI,
 * a auditoria toda diria "não sabemos nada sobre ninguém", que é o oposto do que
 * o §6 pede. Aqui, C5 é só o `false` (o número comprovadamente não existe no
 * WhatsApp); o "nunca checado" é reportado à PARTE no painel (§7), e a ação que a
 * spec prescreve — rodar o reachability check em toda a base antes de qualquer
 * disparo — continua valendo do mesmo jeito.
 */
export function classifyContact(signals: ContactSignals): Classification {
  if (signals.whatsappValid === false) {
    return {
      origin: ContactSourceOrigin.INVALIDO_NAO_WHATSAPP,
      note: 'C5 — a checagem de WhatsApp devolveu que este número NÃO existe no WhatsApp. Disparar para número morto queima cota do tier e marca o tráfego como de baixa qualidade.',
    };
  }

  if (signals.lastInteractionAt) {
    const quando = signals.lastInteractionAt.toISOString().slice(0, 10);
    return {
      origin: ContactSourceOrigin.INTERAGIU,
      note: `C1 — houve inbound deste contato (último em ${quando}): relação demonstrável. NÃO é consentimento — inbound abre janela de atendimento, nunca consentimento de marketing.`,
    };
  }

  // Um lote sem `filename` não documenta origem nenhuma: é uma planilha herdada
  // de terceiro, exatamente o caso que a spec manda tratar como C4.
  const documented = signals.importRows.filter(
    (r) => r.filename.trim().length > 0,
  );

  for (const row of documented) {
    const declaration = hasImportDeclaration(row.raw);
    if (declaration) {
      return {
        origin: ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO,
        note: `C2 — a planilha "${row.filename}" declara o aceite na coluna "${declaration.column}" = "${declaration.value}". Candidato a backfill de consentimento (IMPORT_LEGACY) COM a evidência anexa — resolve sem enviar nada.`,
      };
    }
  }

  if (documented.length > 0) {
    const files = [...new Set(documented.map((r) => r.filename))].join(', ');
    return {
      origin: ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO,
      note: `C3 — origem documentada (${files}), mas NENHUMA coluna declara que a pessoa aceitou receber comunicações. Coletar telefone não é opt-in, nem para a Meta nem para a LGPD. Recoleta por canal iniciado pela pessoa (link/QR).`,
    };
  }

  return {
    origin: ContactSourceOrigin.DESCONHECIDA,
    note: 'C4 — nenhum lote de importação rastreável e nenhuma interação. Não enviar NADA por WhatsApp: procedência desconhecida é o caso Telekall.',
  };
}
