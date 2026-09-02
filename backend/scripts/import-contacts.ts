// Cutover de produção — import idempotente do Contact a partir do JSONL gerado
// por export-contacts.ts (ver docs/superpowers/specs/2026-07-10-provider-capability-addendum.md §5.3).
//
// Uso (container do backend, Dokploy):
//   npx tsx scripts/import-contacts.ts contacts-YYYYMMDD.jsonl
//   npx tsx scripts/import-contacts.ts contacts-YYYYMMDD.jsonl --dry-run
//
// Casamento do titular pelas DUAS grafias do 9º dígito (não por igualdade de
// string) em lotes (default 500), uma transação por lote — reexecutável sem
// duplicar. Linhas inválidas (JSON quebrado ou sem phoneE164) NÃO abortam o
// import: contam como skipped e são logadas em stderr. --dry-run não escreve
// nada, só reporta o que faria.

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { brazilianPhoneVariants } from '../src/modules/contacts/phone.util';
import type { ContactExportLine } from './export-contacts';

/**
 * Linha esperada no JSONL. `phoneE164` é a única coluna obrigatória — as
 * demais são opcionais para tolerar arquivos parciais/editados manualmente.
 */
export interface ParsedContactLine extends Partial<Omit<ContactExportLine, 'phoneE164'>> {
  phoneE164: string;
}

export type ParseLineResult = { ok: true; data: ParsedContactLine } | { ok: false; reason: string };

/** Faz o parse + validação mínima de uma linha JSONL. Nunca lança. */
export function parseContactLine(rawLine: string): ParseLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (e) {
    return { ok: false, reason: `invalid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'line is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.phoneE164 !== 'string' || obj.phoneE164.trim() === '') {
    return { ok: false, reason: 'missing or empty phoneE164' };
  }
  return { ok: true, data: obj as unknown as ParsedContactLine };
}

function toUpsertData(c: ParsedContactLine) {
  return {
    name: c.name ?? null,
    city: c.city ?? null,
    group: c.group ?? null,
    tags: c.tags ?? [],
    customFields: (c.customFields ?? undefined) as Prisma.InputJsonValue | undefined,
    optedOut: c.optedOut ?? false,
    whatsappValid: c.whatsappValid ?? null,
    whatsappCheckedAt: c.whatsappCheckedAt ? new Date(c.whatsappCheckedAt) : null,
    profilePictureUrl: c.profilePictureUrl ?? null,
    waLabels: c.waLabels ?? [],
  };
}

/** Subconjunto de PrismaService usado dentro de um lote (também satisfeito por Prisma.TransactionClient). */
type ContactDb = Pick<PrismaService, 'contact'>;

/**
 * O QUARTO ESCRITOR DE CONTATO (auditoria C5/C6).
 *
 * Este laço casava o titular por igualdade EXATA de `phoneE164`. Só que as duas
 * grafias do 9º dígito (`+5592995550101` e `+559295550101`) são a MESMA conta de
 * WhatsApp: um JSONL trazendo uma delas para alguém que já está na base com a
 * outra criava um SEGUNDO Contact para a mesma pessoa. E o gêmeo não fica inerte
 * — `ConsentService.rehydrate` casa a trilha pelas duas grafias, ele nasce
 * GRANTED e passa o gate da campanha. Numa campanha eleitoral isso é a pessoa
 * recebendo propaganda duas vezes.
 *
 * Agora: procura pelas VARIANTES e atualiza por `id`. Por `id` porque a grafia
 * consultada pode não ser a gravada — `where: { phoneE164 }` acertaria a linha
 * errada, ou nenhuma.
 */
async function upsertBatch(
  db: ContactDb,
  batch: ParsedContactLine[],
  dryRun: boolean,
  log: (msg: string) => void,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const c of batch) {
    const existing = await db.contact.findFirst({
      where: { phoneE164: { in: brazilianPhoneVariants(c.phoneE164) } },
      select: { id: true, phoneE164: true },
    });
    if (existing) updated++;
    else created++;

    if (existing && existing.phoneE164 !== c.phoneE164) {
      // Não é erro, mas o operador precisa ver: a linha do arquivo foi aplicada
      // sobre uma linha da base com OUTRA grafia. Se o arquivo trouxer as duas
      // grafias da mesma pessoa, a segunda sobrescreve a primeira em vez de
      // virar contato novo — que é o comportamento que se quer, mas não é óbvio.
      log(`MESMO TITULAR, outra grafia: arquivo=${c.phoneE164} base=${existing.phoneE164} (atualizado, não duplicado)`);
    }

    if (dryRun) continue;

    const data = toUpsertData(c);
    if (existing) {
      // Never rewrite createdAt on an existing row.
      await db.contact.update({ where: { id: existing.id }, data });
      continue;
    }

    try {
      await db.contact.create({
        data: {
          id: c.id,
          phoneE164: c.phoneE164,
          ...data,
          // Preserve "contact since" across the cutover; without this every
          // restored contact would look like it was created on migration day.
          ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
        },
      });
    } catch (e) {
      // Corrida: outro escritor gravou a MESMA string entre a busca e o create.
      // O `upsert` que estava aqui antes tolerava isso; a substituição por
      // create não pode ser um passo atrás.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      await db.contact.update({ where: { phoneE164: c.phoneE164 }, data });
      created--;
      updated++;
    }
  }
  return { created, updated };
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  total: number;
}

export interface ImportContactsOptions {
  /** Tamanho do lote / linhas por transação (default 500). */
  batchSize?: number;
  /** Não escreve nada no banco; só reporta o que faria. */
  dryRun?: boolean;
  /** Sink de log (progresso/skips/sumário). Default: stderr. */
  log?: (msg: string) => void;
}

/**
 * Importa contatos a partir de um iterável de linhas JSONL (arquivo via
 * readline, array em memória, ou qualquer async iterable). Idempotente:
 * reexecutar sobre o mesmo arquivo não duplica contatos (upsert por
 * phoneE164). Linhas inválidas nunca abortam o processo — só incrementam
 * `skipped` e são logadas.
 */
export async function importContacts(
  prisma: PrismaService,
  lines: AsyncIterable<string> | Iterable<string>,
  opts: ImportContactsOptions = {},
): Promise<ImportSummary> {
  const batchSize = opts.batchSize ?? 500;
  const dryRun = opts.dryRun ?? false;
  const log =
    opts.log ??
    ((msg: string) => {
      process.stderr.write(msg + '\n');
    });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let total = 0;
  let batch: ParsedContactLine[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    const result = dryRun
      ? await upsertBatch(prisma, current, true, log) // read-only: no transaction needed, nothing is written
      : await prisma.$transaction((tx) => upsertBatch(tx, current, false, log));
    created += result.created;
    updated += result.updated;
  };

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    total++;
    const parsed = parseContactLine(line);
    if (!parsed.ok) {
      skipped++;
      log(`SKIP line ${total}: ${parsed.reason}`);
      continue;
    }
    batch.push(parsed.data);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  const summary: ImportSummary = { created, updated, skipped, total };
  log(
    `${dryRun ? '[dry-run] ' : ''}import summary: created=${created} updated=${updated} skipped=${skipped} total=${total}`,
  );
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));

  if (!file) {
    process.stderr.write('usage: import-contacts.ts <arquivo.jsonl> [--dry-run]\n');
    process.exitCode = 1;
  } else if (!fs.existsSync(file)) {
    process.stderr.write(`file not found: ${file}\n`);
    process.exitCode = 1;
  } else {
    const prisma = new PrismaService();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    importContacts(prisma, rl, { dryRun })
      .catch((e) => {
        process.stderr.write(`import failed: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`);
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}
