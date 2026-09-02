// Cutover de produção — verificação pós-import (gate do runbook; ver
// docs/superpowers/specs/2026-07-10-provider-capability-addendum.md §5.4/§5.5).
//
// Uso (container do backend, Dokploy):
//   npx tsx scripts/verify-contacts.ts contacts-YYYYMMDD.jsonl
//
// Compara count(*) do banco com o total do arquivo, confere as invariantes
// count(optedOut) e count(whatsappValid), e amostra N=20 contatos aleatórios
// do arquivo conferindo tags/customFields/optedOut/whatsappValid/waLabels
// campo a campo contra o banco. Sai com código != 0 se qualquer verificação
// falhar — usar como gate antes de declarar o cutover concluído.

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { parseContactLine, type ParsedContactLine } from './import-contacts';

const SAMPLE_FIELDS = ['tags', 'customFields', 'optedOut', 'whatsappValid', 'waLabels'] as const;

export interface FieldMismatch {
  phoneE164: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface VerifyReport {
  ok: boolean;
  fileTotal: number;
  dbTotal: number;
  fileOptedOut: number;
  dbOptedOut: number;
  fileWhatsappValid: number;
  dbWhatsappValid: number;
  sampleSize: number;
  sampleMismatches: FieldMismatch[];
  errors: string[];
}

/** undefined and null compare as equal — the JSONL and the DB use different "absent" sentinels. */
function normalize(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Random sample without replacement (default picker; overridable for deterministic tests). */
function defaultPickSample<T>(rows: readonly T[], n: number): T[] {
  const copy = rows.slice();
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

export interface VerifyContactsOptions {
  /** Tamanho da amostra (default 20; automaticamente limitado ao total do arquivo). */
  sampleSize?: number;
  /** Seletor de amostra injetável (para testes determinísticos). */
  pickSample?: (rows: readonly ParsedContactLine[], n: number) => ParsedContactLine[];
}

/**
 * Verifica o pós-import: contagem total, invariantes (optedOut/whatsappValid)
 * e uma amostra campo a campo. `rows` é o conteúdo já parseado do JSONL
 * (linhas inválidas não entram — elas nunca teriam sido importadas).
 */
export async function verifyContacts(
  prisma: PrismaService,
  rows: readonly ParsedContactLine[],
  opts: VerifyContactsOptions = {},
): Promise<VerifyReport> {
  const errors: string[] = [];

  const fileTotal = rows.length;
  const dbTotal = await prisma.contact.count();
  if (dbTotal !== fileTotal) {
    errors.push(`count(*) mismatch: db=${dbTotal} file=${fileTotal}`);
  }

  const fileOptedOut = rows.filter((r) => r.optedOut === true).length;
  const dbOptedOut = await prisma.contact.count({ where: { optedOut: true } });
  if (dbOptedOut !== fileOptedOut) {
    errors.push(`optedOut invariant mismatch: db=${dbOptedOut} file=${fileOptedOut}`);
  }

  const fileWhatsappValid = rows.filter((r) => r.whatsappValid === true).length;
  const dbWhatsappValid = await prisma.contact.count({ where: { whatsappValid: true } });
  if (dbWhatsappValid !== fileWhatsappValid) {
    errors.push(`whatsappValid invariant mismatch: db=${dbWhatsappValid} file=${fileWhatsappValid}`);
  }

  const sampleSize = Math.min(opts.sampleSize ?? 20, rows.length);
  const pickSample = opts.pickSample ?? defaultPickSample;
  const sample = pickSample(rows, sampleSize);
  const sampleMismatches: FieldMismatch[] = [];

  for (const expected of sample) {
    const actual = await prisma.contact.findUnique({ where: { phoneE164: expected.phoneE164 } });
    if (!actual) {
      sampleMismatches.push({
        phoneE164: expected.phoneE164,
        field: '(row)',
        expected: 'exists in db',
        actual: 'missing',
      });
      continue;
    }
    for (const field of SAMPLE_FIELDS) {
      const exp = normalize(expected[field]);
      const act = normalize((actual as unknown as Record<string, unknown>)[field]);
      if (JSON.stringify(exp) !== JSON.stringify(act)) {
        sampleMismatches.push({ phoneE164: expected.phoneE164, field, expected: exp, actual: act });
      }
    }
  }
  if (sampleMismatches.length > 0) {
    errors.push(`${sampleMismatches.length} sample field mismatch(es) across ${sample.length} contacts`);
  }

  return {
    ok: errors.length === 0,
    fileTotal,
    dbTotal,
    fileOptedOut,
    dbOptedOut,
    fileWhatsappValid,
    dbWhatsappValid,
    sampleSize: sample.length,
    sampleMismatches,
    errors,
  };
}

/** Lê e parseia o JSONL inteiro (arquivo já materializado pelo export — não precisa de streaming aqui). */
export async function readJsonlContacts(
  filePath: string,
): Promise<{ rows: ParsedContactLine[]; invalidLines: number }> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const rows: ParsedContactLine[] = [];
  let invalidLines = 0;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseContactLine(line);
    if (parsed.ok) rows.push(parsed.data);
    else invalidLines++;
  }
  return { rows, invalidLines };
}

function printReport(report: VerifyReport, invalidLines: number): void {
  process.stderr.write(
    `verify: file=${report.fileTotal} db=${report.dbTotal} ` +
      `optedOut(file=${report.fileOptedOut},db=${report.dbOptedOut}) ` +
      `whatsappValid(file=${report.fileWhatsappValid},db=${report.dbWhatsappValid}) ` +
      `sample=${report.sampleSize} mismatches=${report.sampleMismatches.length} invalidLines=${invalidLines}\n`,
  );
  for (const m of report.sampleMismatches) {
    process.stderr.write(
      `  MISMATCH ${m.phoneE164} field=${m.field} expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}\n`,
    );
  }
  process.stderr.write(
    report.ok ? 'verify OK\n' : `verify FAILED:\n${report.errors.map((e) => `  - ${e}`).join('\n')}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: verify-contacts.ts <arquivo.jsonl>\n');
    process.exitCode = 1;
  } else if (!fs.existsSync(file)) {
    process.stderr.write(`file not found: ${file}\n`);
    process.exitCode = 1;
  } else {
    const prisma = new PrismaService();
    (async () => {
      const { rows, invalidLines } = await readJsonlContacts(file);
      const report = await verifyContacts(prisma, rows);
      printReport(report, invalidLines);
      process.exitCode = report.ok ? 0 : 1;
    })()
      .catch((e) => {
        process.stderr.write(`verify crashed: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`);
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}
