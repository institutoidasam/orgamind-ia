// Cutover de produção — export do Contact completo (o único dado preservado num
// reset de banco; ver docs/superpowers/specs/2026-07-10-provider-capability-addendum.md §5.1).
//
// Uso (container do backend, Dokploy):
//   npx tsx scripts/export-contacts.ts > contacts-$(date +%Y%m%d).jsonl
//
// Streaming, paginado por cursor `id` (não materializa os ~13k+ contatos em
// memória). Uma linha JSON por contato em stdout; progresso e total em stderr.
// Datas serializadas em ISO 8601.

import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';

/** Seleção completa das colunas escalares de Contact (nenhuma relação). */
export const CONTACT_EXPORT_SELECT = {
  id: true,
  phoneE164: true,
  name: true,
  city: true,
  group: true,
  tags: true,
  customFields: true,
  optedOut: true,
  whatsappValid: true,
  whatsappCheckedAt: true,
  profilePictureUrl: true,
  waLabels: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ContactExportDbRow = {
  id: string;
  phoneE164: string;
  name: string | null;
  city: string | null;
  group: string | null;
  tags: string[];
  customFields: Prisma.JsonValue | null;
  optedOut: boolean;
  whatsappValid: boolean | null;
  whatsappCheckedAt: Date | null;
  profilePictureUrl: string | null;
  waLabels: string[];
  createdAt: Date;
  updatedAt: Date;
};

/** Shape gravado em cada linha do JSONL — datas já em ISO 8601 (string). */
export interface ContactExportLine {
  id: string;
  phoneE164: string;
  name: string | null;
  city: string | null;
  group: string | null;
  tags: string[];
  customFields: Prisma.JsonValue | null;
  optedOut: boolean;
  whatsappValid: boolean | null;
  whatsappCheckedAt: string | null;
  profilePictureUrl: string | null;
  waLabels: string[];
  createdAt: string;
  updatedAt: string;
}

export function toExportLine(row: ContactExportDbRow): ContactExportLine {
  return {
    ...row,
    whatsappCheckedAt: row.whatsappCheckedAt ? row.whatsappCheckedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Uma linha JSONL (com \n final) para o contato dado. */
export function serializeContactLine(row: ContactExportDbRow): string {
  return JSON.stringify(toExportLine(row)) + '\n';
}

export interface ExportContactsOptions {
  /** Tamanho da página lida do banco por vez (default 1000). */
  batchSize?: number;
  /** Sink de cada linha JSONL já serializada. Default: process.stdout. */
  write?: (line: string) => void;
  /** Chamado após cada página com o total acumulado (para progresso em stderr). */
  onBatch?: (totalSoFar: number) => void;
}

/**
 * Exporta todos os Contact em JSONL, paginando por cursor `id` (orderBy id
 * asc) para não estourar memória com dezenas de milhares de linhas. Retorna o
 * total de contatos exportados.
 */
export async function exportContacts(
  prisma: Pick<PrismaService, 'contact'>,
  opts: ExportContactsOptions = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 1000;
  const write =
    opts.write ??
    ((line: string) => {
      process.stdout.write(line);
    });

  let cursor: string | undefined;
  let total = 0;

  for (;;) {
    const rows = await prisma.contact.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: CONTACT_EXPORT_SELECT,
    });
    if (rows.length === 0) break;

    for (const row of rows) write(serializeContactLine(row));

    total += rows.length;
    cursor = rows[rows.length - 1].id;
    opts.onBatch?.(total);
  }

  return total;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaService();
  exportContacts(prisma, {
    onBatch: (total) => {
      process.stderr.write(`... ${total} contacts exported so far\n`);
    },
  })
    .then((total) => {
      process.stderr.write(`exported ${total} contacts\n`);
    })
    .catch((e) => {
      process.stderr.write(`export failed: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
