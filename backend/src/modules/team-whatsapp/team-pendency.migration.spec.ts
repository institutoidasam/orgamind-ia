import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261121120000_team_pendency/migration.sql',
);
const PENDENCY_COLUMNS = [
  'pendencyAssignedAt',
  'pendencyCloseReason',
  'pendencyClosedAt',
  'pendencyClosedById',
  'pendencyDueAt',
  'pendencyHandlerId',
];

// GK12: comandos que escrevem ou apagam dado/estrutura, olhando o início de cada linha.
const forbidden = (sql: string): boolean =>
  sql
    .split('\n')
    .some((l) => /^(UPDATE|DELETE\s+FROM|DROP|INSERT)\b/i.test(l.trim()));

const withoutComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const commands = (): string =>
  withoutComments(readFileSync(MIGRATION_SQL, 'utf8'));

const ALTER_TABLE = /^ALTER TABLE "(\w+)" /;

/** Cláusulas de cada ALTER TABLE (uma por `ADD ...`), sem o prefixo da tabela. */
function alterClauses(sql: string): { table: string; clauses: string[] }[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => ALTER_TABLE.test(statement))
    .map((statement) => ({
      table: ALTER_TABLE.exec(statement)?.[1] ?? '',
      clauses: statement
        .replace(ALTER_TABLE, '')
        .split(',\n')
        .map((clause) => clause.trim()),
    }));
}

describe('regra de comandos proibidos (GK12)', () => {
  it('aceita ON DELETE CASCADE ON UPDATE CASCADE e comentário com DROP; recusa o comando de fato', () => {
    const fk =
      'ALTER TABLE "T" ADD CONSTRAINT "T_fkey" FOREIGN KEY ("a") REFERENCES "C"("id") ON DELETE CASCADE ON UPDATE CASCADE;';

    expect(forbidden(withoutComments(fk))).toBe(false);
    expect(forbidden(withoutComments('-- sem o DROP\nSELECT 1;'))).toBe(false);
    expect(forbidden('DROP TABLE "T";')).toBe(true);
    expect(forbidden('  DELETE FROM "T";')).toBe(true);
  });
});

describe('migração 20261121120000_team_pendency (GK12)', () => {
  it('GK12: começa por SET LOCAL lock_timeout', () => {
    expect(commands().trimStart()).toMatch(/^SET LOCAL lock_timeout = '15s';/);
  });

  it('GK12: sem comando UPDATE, DELETE FROM, DROP nem INSERT', () => {
    expect(forbidden(commands())).toBe(false);
  });

  it('GK12: toda linha ALTER TABLE adiciona (ADD), nunca DROP/ALTER COLUMN', () => {
    const alters = alterClauses(commands());

    expect(alters.length).toBeGreaterThan(0);
    for (const { clauses } of alters) {
      for (const clause of clauses) expect(clause).toMatch(/^ADD\s/i);
    }
  });

  it('GK12: nenhum CREATE INDEX em TeamWhatsappRecipient nem TeamWhatsappDispatch', () => {
    const sql = commands();

    expect(sql).not.toMatch(
      /CREATE\s+(UNIQUE\s+)?INDEX\b[^;]*\bON\s+"TeamWhatsapp(Recipient|Dispatch)"/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX "TeamPendencyNote_recipientId_createdAt_idx" ON "TeamPendencyNote"\("recipientId", "createdAt"\);/,
    );
  });
});

describe('migração 20261121120000_team_pendency (estrutura)', () => {
  it('cria o enum com CONTACT, ASSUME, CLOSE e HANDOVER', () => {
    const match = /CREATE TYPE "TeamPendencyNoteKind" AS ENUM \(([^)]*)\)/.exec(
      commands(),
    );
    const labels = (match?.[1] ?? '')
      .split(',')
      .map((label) => label.trim().replaceAll("'", ''));

    expect(labels).toEqual(['CONTACT', 'ASSUME', 'CLOSE', 'HANDOVER']);
  });

  it('seis ADD COLUMN pendency* nulas, sem DEFAULT, closeReason VARCHAR(200)', () => {
    const recipient = alterClauses(commands()).filter(
      ({ table }) => table === 'TeamWhatsappRecipient',
    );
    const clauses = recipient.flatMap((alter) => alter.clauses);

    expect(recipient).toHaveLength(1);
    expect(clauses.map((c) => /^ADD COLUMN\s+"(\w+)"/.exec(c)?.[1])).toEqual(
      PENDENCY_COLUMNS,
    );
    for (const clause of clauses) {
      expect(clause).toMatch(
        /^ADD COLUMN\s+"\w+" (TIMESTAMP\(3\)|TEXT|VARCHAR\(200\))$/,
      );
    }
    expect(clauses).toContainEqual(
      expect.stringMatching(
        /^ADD COLUMN\s+"pendencyCloseReason" VARCHAR\(200\)$/,
      ),
    );
  });

  it('FK da anotação só para TeamWhatsappRecipient, ON DELETE CASCADE; sem FK de usuário', () => {
    const fks = commands()
      .split('\n')
      .filter((line) => /FOREIGN\s+KEY/i.test(line));

    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatch(
      /^ALTER TABLE "TeamPendencyNote" ADD CONSTRAINT "\w+" FOREIGN KEY \("recipientId"\) REFERENCES "TeamWhatsappRecipient"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;$/,
    );
    expect(commands()).not.toMatch(/REFERENCES\s+"User"/i);
  });
});
