import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  ConsentAction,
  ConsentSource,
  ImportBatchStatus,
  ImportItemStatus,
  Prisma,
  type ImportBatch,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  brazilianPhoneVariants,
  canonicalBrPhoneForm,
  normalizeToE164,
} from '../contacts/phone.util';
import type { ContactCreateData } from '../contacts/contacts.repository';
import {
  DuplicateHeaderError,
  EmptyWorkbookError,
  TooManyRowsError,
  UnreadableWorkbookError,
} from './errors/excel.errors';
import { normalizeXlsxForExceljs } from './xlsx-normalizer';
import { AuditService } from '../../shared/audit/audit.service';
import {
  ConsentService,
  type ConsentPurposeView,
} from '../consent/consent.service';
import {
  CONSENT_COLUMN_KEYS,
  buildPaperEvidenceText,
  parsePaperConsent,
} from './import-consent';
import { QUEUE_NAMES, type ContactSyncJob } from '../queue/queue.constants';

// Every cell is coerced to a plain string at read time via cellToString (A7),
// so a parsed row maps header → string.
type Row = Record<string, string>;

/**
 * Maximum number of data rows accepted by the synchronous import path (A8).
 * A 10MB xlsx can decompress to hundreds of thousands of rows; beyond this we
 * reject with 422 rather than holding a pool connection in a long transaction.
 * Raising this materially should come with moving the import to a BullMQ job.
 */
export const MAX_IMPORT_ROWS = 50_000;

/** Number of rows per createMany batch for new contacts (A8). */
const CONTACT_CREATE_BATCH_SIZE = 1_000;

/**
 * Coerce an ExcelJS cell value to a plain string.
 *
 * `cell.value` is not always a primitive: ExcelJS surfaces rich objects for
 * hyperlinks, rich text, formulas, errors and dates. Blindly `String(...)`-ing
 * them yields `"[object Object]"`, which silently corrupts phone/name/city/etc.
 * (A7). This unwraps each documented shape to its human-readable text.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    // ISO date (no time) — stable, locale-independent representation.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // CellHyperlinkValue: { text, hyperlink }
    if (typeof v.text === 'string') return v.text;
    if (v.text !== undefined && v.text !== null) return cellToString(v.text);
    // CellRichTextValue: { richText: [{ text }, ...] }
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((r) => cellToString((r as { text?: unknown }).text))
        .join('');
    }
    // CellFormulaValue / CellSharedFormulaValue: { formula, result }
    // result can itself be an error object or a nested value → recurse.
    if ('result' in v) return cellToString(v.result);
    // CellErrorValue: { error: '#REF!' } — surface the Excel error code.
    if (typeof v.error === 'string') return v.error;
    return '';
  }
  // Remaining: symbol/function — never produced by ExcelJS cell values.
  return '';
}

type ClassifiedRow =
  | { kind: 'invalid'; raw: Row; rowNumber: number }
  | { kind: 'duplicate'; raw: Row; phone: string; rowNumber: number }
  | {
      kind: 'valid';
      raw: Row;
      phone: string;
      data: ContactCreateData;
      /** Linha na PLANILHA (1 = cabeçalho) — vai para a evidência do §3.3. */
      rowNumber: number;
    };

/**
 * Header keys mapped to dedicated Contact columns. Anything outside this set is
 * preserved verbatim in `customFields` (see extractCustomFields).
 *
 * As colunas de consentimento (C4, §3.3) também entram aqui — não porque virem
 * campo de Contact, mas porque NÃO podem virar `customFields`: `termo_ref` é
 * evidência jurídica, e o lugar dela é `ConsentEvent.evidence`, não um saco de
 * strings na linha do contato.
 */
const KNOWN_KEYS = new Set([
  'telefone',
  'phone',
  'nome',
  'name',
  'cidade',
  'city',
  'grupo',
  'group',
  'tags',
  ...CONSENT_COLUMN_KEYS,
]);

/**
 * Return the first non-empty value among the given header keys, or undefined.
 * Encodes the PT-BR-wins-over-EN precedence (e.g. `nome` before `name`): keys
 * are tried in order and an empty string is treated as absent.
 */
function pickField(raw: Row, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (v) return v;
  }
  return undefined;
}

/** Collect every column outside KNOWN_KEYS into a customFields object. */
function extractCustomFields(raw: Row): Record<string, unknown> {
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k)) customFields[k] = v;
  }
  return customFields;
}

type ValidRow = Extract<ClassifiedRow, { kind: 'valid' }>;

type ImportItemInput = {
  batchId: string;
  contactId: string | null;
  rawRow: Prisma.InputJsonValue;
  status: ImportItemStatus;
};

/**
 * Build the contact.createMany row for a new (valid) contact. New contacts
 * default `tags` to [] (vs undefined on update, which preserves existing tags),
 * and only carry `customFields` when present.
 *
 * `optedOut` vem da SuppressionList (C1): um contato cujo phoneHash está
 * suprimido NASCE suprimido, mesmo que a linha de Contact tenha sido apagada
 * entre o PARAR e a reimportação. Sem isso, reimportar a planilha ressuscita
 * quem pediu para sair.
 */
function buildCreateArgs(c: ValidRow, suppressed: boolean) {
  return {
    phoneE164: c.phone,
    name: c.data.name,
    city: c.data.city,
    group: c.data.group,
    tags: c.data.tags ?? [],
    optedOut: suppressed,
    customFields:
      c.data.customFields !== undefined
        ? (c.data.customFields as Prisma.InputJsonValue)
        : undefined,
  };
}

/**
 * Build the contact.update payload for an existing (valid) contact. `phoneE164`
 * is the lookup key and must not appear in the update data; `tags` stays
 * omitted when the sheet had no tags column (preserves existing tags).
 *
 * `optedOut` só aparece para REAFIRMAR uma supressão (repara um cache velho, ex.
 * linha recriada por um import anterior a esta correção). NUNCA é escrito como
 * `false`: um import não é ato de consentimento e não pode desfazer um opt-out —
 * nem por acidente, nem por uma coluna esquecida na planilha.
 */
function buildUpdateArgs(
  c: ValidRow,
  suppressed: boolean,
): Prisma.ContactUpdateInput {
  const update: Prisma.ContactUpdateInput = {
    ...c.data,
    ...(suppressed ? { optedOut: true } : {}),
    customFields:
      c.data.customFields !== undefined
        ? (c.data.customFields as Prisma.InputJsonValue)
        : undefined,
  };
  delete (update as { phoneE164?: unknown }).phoneE164;
  return update;
}

/**
 * Assemble the full ImportItem batch in the exact legacy order: CREATED rows
 * (new-contact order) → UPDATED rows (existing-contact order) → INVALID and
 * DUPLICATE rows (original sheet order, as they appear in `classified`).
 * `createdIds`/`updatedIds` are the resolved contact ids (parallel to the
 * respective row arrays); a missing created id yields contactId: null.
 */
function buildImportItems(
  batchId: string,
  newRows: ValidRow[],
  createdIds: Array<string | undefined>,
  updateRows: ValidRow[],
  updatedIds: string[],
  classified: ClassifiedRow[],
): ImportItemInput[] {
  const items: ImportItemInput[] = [];
  newRows.forEach((c, i) => {
    items.push({
      batchId,
      contactId: createdIds[i] ?? null,
      rawRow: c.raw,
      status: ImportItemStatus.CREATED,
    });
  });
  updateRows.forEach((c, i) => {
    items.push({
      batchId,
      contactId: updatedIds[i],
      rawRow: c.raw,
      status: ImportItemStatus.UPDATED,
    });
  });
  for (const c of classified) {
    if (c.kind === 'invalid') {
      items.push({
        batchId,
        contactId: null,
        rawRow: c.raw,
        status: ImportItemStatus.INVALID,
      });
    } else if (c.kind === 'duplicate') {
      items.push({
        batchId,
        contactId: null,
        rawRow: c.raw,
        status: ImportItemStatus.DUPLICATE,
      });
    }
  }
  return items;
}

/**
 * Indexa contatos do banco por TODAS as grafias do 9º dígito de cada um, para
 * que `map.get(telefoneDaPlanilha)` acerte mesmo quando a base guarda a outra.
 *
 * Enquanto a base ainda tiver gêmeos (o reparo roda a cada deploy, mas um import
 * pode criar um par entre dois deploys), as DUAS linhas voltam do SELECT e
 * disputam a mesma chave. O desempate é DETERMINÍSTICO — vence a forma de 13
 * dígitos —, e é o mesmo de `ContactsRepository.findByAnyBrForm` e do canônico
 * de `prisma/merge-duplicate-phone-contacts.ts`: regras diferentes fariam a
 * planilha atualizar uma linha e o disparo enxergar a outra.
 */
function indexContactsByVariant(
  rows: Array<{ id: string; phoneE164: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const isCanonical = row.phoneE164 === canonicalBrPhoneForm(row.phoneE164);
    for (const variant of brazilianPhoneVariants(row.phoneE164)) {
      if (!map.has(variant) || isCanonical) map.set(variant, row.id);
    }
  }
  return map;
}

/**
 * Classify a single parsed row into invalid / duplicate / valid.
 *
 * `seen` accumulates phones already encountered in this import so the second
 * occurrence of a number is flagged DUPLICATE (and mutated here). `hasTagsColumn`
 * controls whether `tags` is parsed at all — when the sheet has no tags column
 * we leave it undefined so updates never wipe existing tags (Baixo).
 *
 * C6 (caso B) — o `seen` guarda a CHAVE DE IDENTIDADE do assinante, não a string
 * da planilha. Uma base consolidada de duas origens traz a mesma pessoa nas duas
 * grafias do 9º dígito em linhas diferentes; com o Set de strings exatas, as
 * duas passavam como válidas e viravam dois contatos no mesmo `createMany` —
 * `skipDuplicates` não ajuda, porque as strings de fato diferem e o `@unique`
 * não é violado. A chave é idempotente (bijeção), então a ordem das linhas na
 * planilha não muda o resultado.
 */
function classifyRow(
  raw: Row,
  rowNumber: number,
  seen: Set<string>,
  hasTagsColumn: boolean,
): ClassifiedRow {
  const phoneRaw = raw.telefone ?? raw.phone ?? '';
  const phone = normalizeToE164(phoneRaw);
  if (!phone) return { kind: 'invalid', raw, rowNumber };
  const identityKey = canonicalBrPhoneForm(phone);
  if (seen.has(identityKey)) return { kind: 'duplicate', raw, phone, rowNumber };
  seen.add(identityKey);

  const tags = hasTagsColumn
    ? (raw.tags ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const customFields = extractCustomFields(raw);

  const data: ContactCreateData = {
    phoneE164: phone,
    name: pickField(raw, 'nome', 'name'),
    city: pickField(raw, 'cidade', 'city'),
    group: pickField(raw, 'grupo', 'group'),
    tags,
    customFields: Object.keys(customFields).length ? customFields : undefined,
  };
  return { kind: 'valid', raw, phone, data, rowNumber };
}

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.CONTACT_SYNC)
    private readonly syncQueue: Queue<ContactSyncJob>,
    private readonly consent: ConsentService,
  ) {}

  /**
   * Create the ImportBatch row up-front (status PENDING) so the upload endpoint
   * can return a trackable id immediately and hand the parse+import off to the
   * worker (A8 deeper fix). `totalRows` stays 0 until the worker parses the file.
   */
  createPendingBatch(filename: string): Promise<{ id: string }> {
    return this.prisma.importBatch.create({
      data: { filename, status: ImportBatchStatus.PENDING },
      select: { id: true },
    });
  }

  /** Flip a batch to PROCESSING (worker picked up the job). */
  async markProcessing(batchId: string): Promise<void> {
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { status: ImportBatchStatus.PROCESSING },
    });
  }

  /** Mark a batch COMPLETED and persist its outcome summary. */
  async markCompleted(
    batchId: string,
    summary: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { status: ImportBatchStatus.COMPLETED, summary },
    });
  }

  /** Mark a batch FAILED and record the error message. */
  async markFailed(batchId: string, error: string): Promise<void> {
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { status: ImportBatchStatus.FAILED, errors: { message: error } },
    });
  }

  /**
   * Parse + import a contact .xlsx buffer.
   *
   * When `opts.batchId` is supplied (async/worker path) the work is recorded
   * against that pre-created PENDING batch instead of inserting a new one; the
   * legacy/inline path (no batchId) creates its own batch as before. Either way
   * the parse/classify/insert pipeline below is identical.
   *
   * C4 (§3.3): quando a planilha traz as colunas de consentimento presencial, os
   * GRANTs são gravados **depois** do commit — ver `recordPaperConsents`.
   *
   * @param opts.purposeKey finalidade padrão do lote, quando a planilha não tem
   * a coluna `finalidade` (uma planilha por evento é o caso comum em campo).
   * @param opts.actorUserId o OPERADOR que importou — vai em `ConsentEvent.actorUserId`
   * e na evidência. Um consentimento de papel não é ato do titular dentro do
   * orgamind: alguém o transcreveu, e a trilha tem de dizer quem.
   */
  async importBuffer(
    filename: string,
    buffer: Buffer,
    opts?: {
      batchId?: string;
      purposeKey?: string | null;
      actorUserId?: string | null;
    },
  ) {
    let workbook = new ExcelJS.Workbook();
    try {
      // exceljs's typings expect a wider Buffer<ArrayBuffer> than Node 22
      // default; cast to satisfy both. Runtime-equivalent.
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch (originalErr) {
      // exceljs 4.4 chokes on valid OOXML with namespace-prefixed elements
      // and/or absolute .rels Targets (U1 — .NET/OpenXML generators). Retry
      // once on a normalized copy in a FRESH workbook (the failed load may
      // have left partial state behind).
      try {
        const fixed = await normalizeXlsxForExceljs(buffer);
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fixed as unknown as ExcelJS.Buffer);
      } catch {
        // Still unreadable — surface a friendly 422 instead of leaking the
        // parser's raw TypeError; keep the ORIGINAL parse error as detail.
        throw new UnreadableWorkbookError(originalErr);
      }
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new EmptyWorkbookError();

    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col - 1] = cellToString(cell.value).trim().toLowerCase();
    });

    // Reject duplicate normalized headers — two columns collapsing to the same
    // key would silently merge/overwrite each other (last cell wins). Empty
    // header cells are skipped at read time (no `key`), so they can't collide.
    const seenHeaders = new Set<string>();
    for (const h of headers) {
      if (!h) continue;
      if (seenHeaders.has(h)) throw new DuplicateHeaderError(h);
      seenHeaders.add(h);
    }
    const hasTagsColumn = seenHeaders.has('tags');

    // `rowNumber` é o índice NA PLANILHA (1 = cabeçalho): é o que o operador vê
    // no Excel e o que a evidência do §3.3 aponta ("linha 47 do lote X").
    const rows: Array<{ raw: Row; rowNumber: number }> = [];
    sheet.eachRow((row, rowIdx) => {
      if (rowIdx === 1) return;
      const obj: Row = {};
      row.eachCell((cell, col) => {
        const key = headers[col - 1];
        // Coerce every cell to a plain string up-front (A7): downstream
        // extraction (phone/name/city/group/tags/customFields) all reads from
        // `obj`, so unwrapping here routes the whole pipeline through the
        // helper and prevents "[object Object]" leaking into any field.
        if (key) obj[key] = cellToString(cell.value);
      });
      rows.push({ raw: obj, rowNumber: rowIdx });
    });

    // Row cap (A8): reject oversized imports BEFORE opening the transaction so
    // we never hold a pool connection for a decompression-bomb spreadsheet.
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new TooManyRowsError(rows.length, MAX_IMPORT_ROWS);
    }

    // Pre-process: classify rows in memory before opening the transaction.
    // `seen` is threaded through so the 2nd occurrence of a phone is DUPLICATE;
    // `hasTagsColumn` preserves existing tags on update when absent (Baixo).
    const seen = new Set<string>();
    const classified: ClassifiedRow[] = rows.map(({ raw, rowNumber }) =>
      classifyRow(raw, rowNumber, seen, hasTagsColumn),
    );

    const validRows = classified.filter(
      (c): c is ValidRow => c.kind === 'valid',
    );
    const validPhones = validRows.map((c) => c.phone);

    // C1 — a supressão sobrevive à planilha. Consultada em LOTE e FORA da
    // transação (é uma leitura de uma tabela que este import não escreve; abrir
    // a transação antes só seguraria uma conexão do pool à toa).
    const suppressed = await this.consent.suppressedPhones(validPhones);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Async path: reuse the PENDING batch the controller created (record
        // totalRows now that we've parsed). Inline path: create a fresh batch.
        const batch = opts?.batchId
          ? await tx.importBatch.update({
              where: { id: opts.batchId },
              data: { totalRows: rows.length },
              select: { id: true },
            })
          : await tx.importBatch.create({
              data: { filename, totalRows: rows.length },
            });

        // Bulk fetch existing contacts (1 query instead of N).
        //
        // C6/C15 (caso A) — a busca é pelas DUAS grafias do 9º dígito. Casando
        // por igualdade exata, a planilha que trazia a forma legada de alguém já
        // cadastrado na moderna caía em `newRows` e criava o gêmeo, sem nenhum
        // sinal no resumo do import — que dizia "N contatos novos".
        const existing = validPhones.length
          ? await tx.contact.findMany({
              where: {
                phoneE164: { in: [...new Set(validPhones.flatMap(brazilianPhoneVariants))] },
              },
              select: { id: true, phoneE164: true },
            })
          : [];
        const existingMap = indexContactsByVariant(existing);

        // Partition into new vs existing using the bulk pre-fetch (A8). New
        // contacts are inserted with batched createMany instead of N sequential
        // upserts, keeping the transaction short even for large imports.
        const newRows = validRows.filter((c) => !existingMap.has(c.phone));
        const updateRows = validRows.filter((c) => existingMap.has(c.phone));

        // Chunked insert for new contacts → resolve their ids (createMany
        // returns no rows, so we re-fetch by phone). Parallel to `newRows`.
        const createdIds = await this.insertNewContacts(
          tx,
          newRows,
          existingMap,
          suppressed,
        );
        // Per-row update for existing contacts → ids parallel to `updateRows`.
        const updatedIds = await this.updateExistingContacts(
          tx,
          updateRows,
          suppressed,
          existingMap,
        );

        const created = newRows.length;
        const updated = updateRows.length;
        const invalid = classified.filter((c) => c.kind === 'invalid').length;
        const duplicates = classified.filter(
          (c) => c.kind === 'duplicate',
        ).length;

        // Imported contact ids feed the sync queue: created (skipping any that
        // failed to resolve) followed by updated, matching the legacy order.
        const importedContactIds = [
          ...createdIds.filter((id): id is string => id !== undefined),
          ...updatedIds,
        ];

        const importItemsToCreate = buildImportItems(
          batch.id,
          newRows,
          createdIds,
          updateRows,
          updatedIds,
          classified,
        );
        if (importItemsToCreate.length) {
          await tx.importItem.createMany({ data: importItemsToCreate });
        }

        const importedRows = created + updated;
        await tx.importBatch.update({
          where: { id: batch.id },
          data: { importedRows },
        });

        this.logger.log(
          `Imported ${filename}: total=${rows.length} created=${created} updated=${updated} invalid=${invalid} duplicates=${duplicates}`,
        );

        // phone → contactId, para o passo de consentimento (que roda FORA desta
        // transação): `createdIds`/`updatedIds` são paralelos a newRows/updateRows.
        const contactIdByPhone = new Map<string, string>();
        newRows.forEach((c, i) => {
          const id = createdIds[i];
          if (id) contactIdByPhone.set(c.phone, id);
        });
        updateRows.forEach((c, i) =>
          contactIdByPhone.set(c.phone, updatedIds[i]),
        );

        // Os contatos CRIADOS por esta planilha (phone → id novo). É neles — e só
        // neles — que a reidratação do consentimento roda (C5.3, abaixo).
        const createdByPhone = new Map<string, string>();
        newRows.forEach((c, i) => {
          const id = createdIds[i];
          if (id) createdByPhone.set(c.phone, id);
        });

        return {
          batchId: batch.id,
          total: rows.length,
          created,
          updated,
          invalid,
          duplicates,
          importedContactIds,
          contactIdByPhone,
          createdByPhone,
        };
      },
      { timeout: 5 * 60_000, maxWait: 10_000 },
    );

    // C5.3 — REIDRATAÇÃO. Um contato NOVO pode não ser uma pessoa nova: a planilha
    // é reimportada o tempo todo, e um contato excluído volta com um `cuid` novo.
    // A `SuppressionList` sobrevive a isso (é chaveada por `phoneHash`, e o
    // `buildCreateArgs` já faz o contato nascer suprimido), mas o `ContactConsent`
    // não — ele cai por CASCATA com a linha antiga. Sem esta chamada, quem
    // consentiu, foi apagado e voltou pela planilha renasce SEM consentimento, e o
    // gate (corretamente) o pula: o consentimento existe na trilha e o orgamind não
    // consegue vê-lo.
    //
    // Roda DEPOIS do commit (o `rehydrate` abre a própria transação e escreve
    // ContactConsent, cuja FK exige o contato já gravado) e ANTES dos GRANTs de
    // papel — um GRANT novo tem de recomputar sobre a trilha inteira, não sobre um
    // estado derivado pela metade.
    await this.rehydrateCreatedContacts(result.createdByPhone);

    // C4 — os GRANTs de papel, DEPOIS do commit. `ConsentService.record()` abre a
    // própria transação (é o caminho único de escrita, e ele recomputa
    // ContactConsent + os caches de Contact atomicamente); chamá-lo de dentro da
    // transação do import aninharia transações e seguraria a conexão do pool por
    // toda a planilha. O contato já está gravado — se um GRANT falhar, o contato
    // permanece SEM consentimento, que é o lado seguro do erro.
    const consentSummary = await this.recordPaperConsents({
      filename,
      batchId: result.batchId,
      classified,
      contactIdByPhone: result.contactIdByPhone,
      suppressed,
      defaultPurposeKey: opts?.purposeKey ?? null,
      actorUserId: opts?.actorUserId ?? null,
    });

    await this.audit.log('import.complete', 'ImportBatch', result.batchId, {
      filename,
      total: result.total,
      created: result.created,
      updated: result.updated,
      invalid: result.invalid,
      duplicates: result.duplicates,
      ...consentSummary,
    });

    const { importedContactIds, contactIdByPhone: _ids, ...counts } = result;
    const publicResult = { ...counts, ...consentSummary };
    for (let i = 0; i < importedContactIds.length; i += 50) {
      this.syncQueue
        .add('sync', {
          contactIds: importedContactIds.slice(i, i + 50),
          triggeredBy: 'import',
        })
        .catch((err) =>
          this.logger.warn({ err }, 'Failed to enqueue import sync chunk'),
        );
    }

    return publicResult;
  }

  /**
   * C4 — os GRANTs de consentimento coletado no PAPEL (spec §3.3).
   *
   * Roda depois do commit dos contatos, uma chamada de `ConsentService.record()`
   * por linha que declara consentimento. Não é vetorizado de propósito: o
   * caminho único de escrita recomputa `ContactConsent` + os caches de `Contact`
   * dentro da própria transação, e uma planilha de fichas de campo tem dezenas
   * ou centenas de linhas — não 13 mil. Contornar o `record()` para ganhar
   * velocidade aqui seria recriar, na mão, exatamente o bug que o C1 fechou.
   *
   * Duas recusas duras:
   *  - **suprimido nunca ressuscita.** Um `record(GRANT)` levantaria a supressão
   *    (regra 4 do §2.7). Reimportar a ficha de março não pode desfazer o PARAR
   *    que a pessoa deu em junho — a revogação é durável (art. 8º §5º), e a
   *    planilha é justamente o vetor por onde ela evaporava antes;
   *  - **finalidade inexistente/inativa não vira GRANT.** Uma key errada na
   *    coluna `finalidade` produziria um consentimento que o gate nunca casa —
   *    consentimento morto, com aparência de vivo no painel.
   */
  private async recordPaperConsents(args: {
    filename: string;
    batchId: string;
    classified: ClassifiedRow[];
    contactIdByPhone: Map<string, string>;
    suppressed: Set<string>;
    defaultPurposeKey: string | null;
    actorUserId: string | null;
  }): Promise<{
    consentGranted: number;
    consentRefused: number;
    consentIncomplete: number;
    consentSuppressed: number;
  }> {
    const summary = {
      consentGranted: 0,
      consentRefused: 0,
      consentIncomplete: 0,
      consentSuppressed: 0,
    };

    // Resolvida uma vez por key distinta (uma planilha de evento tem 1, no máximo 2).
    const purposeCache = new Map<string, ConsentPurposeView | null>();
    const resolvePurpose = async (key: string) => {
      if (!purposeCache.has(key)) {
        purposeCache.set(key, await this.consent.findActivePurpose(key));
      }
      return purposeCache.get(key) ?? null;
    };

    for (const row of args.classified) {
      if (row.kind !== 'valid') continue;

      const parsed = parsePaperConsent(row.raw, args.defaultPurposeKey);
      if (parsed.kind === 'absent') continue;
      if (parsed.kind === 'refused') {
        // A pessoa disse NÃO. O contato entra (o IDASAM pode ter outra base legal
        // para tê-lo no cadastro); campanha para ele, não.
        summary.consentRefused++;
        continue;
      }
      if (parsed.kind === 'incomplete') {
        summary.consentIncomplete++;
        this.logger.warn(
          {
            batchId: args.batchId,
            rowNumber: row.rowNumber,
            reason: parsed.reason,
          },
          'linha com consentimento SIM mas incompleta — contato importado SEM consentimento',
        );
        continue;
      }

      if (args.suppressed.has(row.phone)) {
        summary.consentSuppressed++;
        this.logger.warn(
          { batchId: args.batchId, rowNumber: row.rowNumber },
          'linha com consentimento SIM para telefone SUPRIMIDO — ignorada (revogação é durável)',
        );
        continue;
      }

      const contactId = args.contactIdByPhone.get(row.phone);
      if (!contactId) {
        summary.consentIncomplete++;
        continue;
      }

      const purpose = await resolvePurpose(parsed.intent.purposeKey);
      if (!purpose) {
        summary.consentIncomplete++;
        this.logger.warn(
          {
            batchId: args.batchId,
            rowNumber: row.rowNumber,
            purposeKey: parsed.intent.purposeKey,
          },
          'linha com finalidade inexistente/inativa — nenhum consentimento gravado',
        );
        continue;
      }

      const { intent } = parsed;
      await this.consent.record({
        contactId,
        phoneE164: row.phone,
        purposeKey: intent.purposeKey,
        action: ConsentAction.GRANT,
        source: ConsentSource.PAPER_FORM,
        // A "versão do texto" de um consentimento de papel é a referência do
        // TERMO que a pessoa assinou — não a de um corpo que o orgamind exibiu.
        consentTextVersion: intent.termRef,
        evidenceText: buildPaperEvidenceText({
          intent,
          purposeLabel: purpose.label,
          filename: args.filename,
          batchId: args.batchId,
          rowNumber: row.rowNumber,
        }),
        // occurredAt = a data da ASSINATURA; recordedAt (agora) fica a cargo do
        // ConsentService. Um termo de 8 meses É um consentimento de 8 meses, e o
        // painel precisa poder dizer isso.
        occurredAt: intent.collectedAt,
        actorUserId: args.actorUserId,
        evidence: {
          termRef: intent.termRef,
          termVersion: intent.termRef,
          eventName: intent.eventName,
          collectedAt: intent.collectedAt.toISOString(),
          scanUrl: intent.scanUrl,
          scanSha256: intent.scanSha256,
          importBatchId: args.batchId,
          importFilename: args.filename,
          rowNumber: row.rowNumber,
          actorUserId: args.actorUserId,
          rawRow: row.raw,
        } as Prisma.InputJsonObject,
      });
      summary.consentGranted++;
    }

    if (
      summary.consentGranted ||
      summary.consentIncomplete ||
      summary.consentSuppressed
    ) {
      this.logger.log(
        { batchId: args.batchId, ...summary },
        'consentimento presencial importado',
      );
    }
    return summary;
  }

  /**
   * Insert new contacts in CONTACT_CREATE_BATCH_SIZE chunks (createMany), then
   * re-fetch their ids by phone (createMany returns no rows). Returns the
   * resolved id for each row in `newRows` order (undefined if a phone failed to
   * resolve, e.g. skipped as a duplicate). Also populates `existingMap`.
   */
  /**
   * C5.3 — reidrata o consentimento dos contatos que ESTA planilha criou, a partir
   * da trilha (append-only) do `phoneHash` de cada um.
   *
   * Só os criados: um contato que já existia tem o `ContactConsent` vivo, e
   * reprojetá-lo seria trabalho puro (13k round-trips numa reimportação de rotina).
   *
   * A falha de um contato não derruba a planilha inteira — mas é logada como erro,
   * não engolida: um consentimento que existe e o gate não enxerga é uma pessoa
   * que deixou de receber o que autorizou receber.
   */
  private async rehydrateCreatedContacts(
    createdByPhone: Map<string, string>,
  ): Promise<void> {
    let rehydrated = 0;
    for (const [phone, contactId] of createdByPhone) {
      try {
        const purposes = await this.consent.rehydrate(contactId, phone);
        if (purposes.length > 0) rehydrated += 1;
      } catch (err: unknown) {
        this.logger.error(
          { err, contactId },
          'falha ao reidratar o consentimento de um contato recriado pela planilha',
        );
      }
    }
    if (rehydrated > 0) {
      this.logger.log(
        { rehydrated },
        'consentimento reidratado a partir da trilha (contatos recriados pela planilha)',
      );
    }
  }

  private async insertNewContacts(
    tx: Prisma.TransactionClient,
    newRows: ValidRow[],
    existingMap: Map<string, string>,
    suppressed: Set<string>,
  ): Promise<Array<string | undefined>> {
    if (!newRows.length) return [];

    const createData = newRows.map((c) =>
      buildCreateArgs(c, suppressed.has(c.phone)),
    );
    for (let i = 0; i < createData.length; i += CONTACT_CREATE_BATCH_SIZE) {
      await tx.contact.createMany({
        data: createData.slice(i, i + CONTACT_CREATE_BATCH_SIZE),
        skipDuplicates: true,
      });
    }

    // O re-fetch também casa pelas duas grafias: uma corrida (outra planilha, o
    // ingest, a landing) pode ter gravado a OUTRA forma entre o createMany e
    // este SELECT, e `skipDuplicates` engoliria a colisão em silêncio.
    const insertedVariants = [
      ...new Set(newRows.flatMap((c) => brazilianPhoneVariants(c.phone))),
    ];
    const inserted = await tx.contact.findMany({
      where: { phoneE164: { in: insertedVariants } },
      select: { id: true, phoneE164: true },
    });
    for (const [variant, id] of indexContactsByVariant(inserted)) {
      existingMap.set(variant, id);
    }

    return newRows.map((c) => existingMap.get(c.phone));
  }

  /**
   * Issue one contact.update per existing contact (each row has a distinct
   * payload, so there's no single updateMany). Returns the updated ids in
   * `updateRows` order.
   *
   * C6 — o `where` é por `id`, NUNCA por `phoneE164`. Com o casamento por
   * variante, a grafia gravada pode não ser a da planilha (o contato está como
   * `+5592995550101` e a linha traz `+559295550101`): `where: { phoneE164 }`
   * estouraria P2025 e derrubaria a planilha inteira. `buildUpdateArgs` já não
   * escreve `phoneE164`, então a grafia canônica gravada é preservada.
   */
  private async updateExistingContacts(
    tx: Prisma.TransactionClient,
    updateRows: ValidRow[],
    suppressed: Set<string>,
    existingMap: Map<string, string>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const c of updateRows) {
      const id = existingMap.get(c.phone);
      // `updateRows` é justamente o filtro `existingMap.has(c.phone)`: se isto
      // acontecer, o particionamento e a atualização discordam — falhar alto é
      // melhor que atualizar a linha errada.
      if (!id) {
        throw new Error(
          `linha classificada como atualização sem contato resolvido (${c.phone})`,
        );
      }
      const contact = await tx.contact.update({
        where: { id },
        data: buildUpdateArgs(c, suppressed.has(c.phone)),
        select: { id: true },
      });
      ids.push(contact.id);
    }
    return ids;
  }

  listBatches(): Promise<ImportBatch[]> {
    return this.prisma.importBatch.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
