import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261121100000_conversation_situation_history/migration.sql',
);

// Critério GK12: só comandos que escrevem ou apagam dado/estrutura, linha a linha.
const FORBIDDEN_COMMAND = /^(UPDATE|DELETE\s+FROM|DROP|INSERT)\b/i;

function hasForbiddenCommand(sql: string): boolean {
  return sql
    .split('\n')
    .some((line) => FORBIDDEN_COMMAND.test(line.trimStart()));
}

/** Conteúdo do arquivo sem as linhas de comentário `--`. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function migrationCommands(): string {
  return stripComments(readFileSync(MIGRATION_SQL, 'utf8'));
}

describe('regra de comandos proibidos (GK12)', () => {
  it('aceita ON DELETE CASCADE ON UPDATE CASCADE e comentário com a palavra DROP; recusa o comando de fato', () => {
    const fk =
      'ALTER TABLE "T" ADD CONSTRAINT "T_fkey" FOREIGN KEY ("a") REFERENCES "C"("id") ON DELETE CASCADE ON UPDATE CASCADE;';
    const commented = '-- sem o DROP da quarentena\nSELECT 1;';

    expect(hasForbiddenCommand(stripComments(fk))).toBe(false);
    expect(hasForbiddenCommand(stripComments(commented))).toBe(false);
    expect(hasForbiddenCommand('DROP TABLE "T";')).toBe(true);
    expect(hasForbiddenCommand('  DELETE FROM "T";')).toBe(true);
  });
});

describe('migração 20261121100000_conversation_situation_history (GK12)', () => {
  it('GK12: começa por SET LOCAL lock_timeout', () => {
    expect(migrationCommands().trimStart()).toMatch(
      /^SET LOCAL lock_timeout = '15s';/,
    );
  });

  it('GK12: sem comando UPDATE, DELETE FROM, DROP nem INSERT', () => {
    expect(hasForbiddenCommand(migrationCommands())).toBe(false);
  });

  it('GK12: toda linha ALTER TABLE adiciona (ADD), nunca DROP/ALTER COLUMN', () => {
    const alters = migrationCommands()
      .split('\n')
      .filter((line) => /^\s*ALTER\s+TABLE\b/i.test(line));

    expect(alters.length).toBeGreaterThan(0);
    for (const line of alters) {
      expect(line).toMatch(/^\s*ALTER\s+TABLE\s+"\w+"\s+ADD\s/i);
    }
  });

  it('GK12: sem CREATE INDEX em "Conversation" (só na tabela nova)', () => {
    const sql = migrationCommands();

    expect(sql).not.toMatch(
      /CREATE\s+(UNIQUE\s+)?INDEX\b[^;]*\bON\s+"Conversation"\s*\(/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX "ConversationHistoryEntry_conversationId_createdAt_idx" ON "ConversationHistoryEntry"\("conversationId", "createdAt"\);/,
    );
  });
});

describe('migração 20261121100000_conversation_situation_history (estrutura)', () => {
  it('cria o enum com as sete ações, inclusive SHIFT_HANDOVER', () => {
    const match =
      /CREATE TYPE "ConversationHistoryAction" AS ENUM \(([^)]*)\)/.exec(
        migrationCommands(),
      );
    const labels = (match?.[1] ?? '')
      .split(',')
      .map((label) => label.trim().replaceAll("'", ''));

    expect(labels).toEqual([
      'ASSUMED',
      'ASSUMED_ON_REPLY',
      'TRANSFERRED',
      'UNASSIGNED',
      'RESOLVED',
      'REOPENED',
      'SHIFT_HANDOVER',
    ]);
  });

  it('ADD COLUMN resolvedAt nulo, sem DEFAULT', () => {
    expect(migrationCommands()).toMatch(
      /^ALTER TABLE "Conversation" ADD COLUMN\s+"resolvedAt" TIMESTAMP\(3\);$/m,
    );
  });

  it('FK do histórico só para Conversation, ON DELETE CASCADE', () => {
    const fks = migrationCommands()
      .split('\n')
      .filter((line) => /FOREIGN\s+KEY/i.test(line));

    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatch(
      /^ALTER TABLE "ConversationHistoryEntry" ADD CONSTRAINT "\w+" FOREIGN KEY \("conversationId"\) REFERENCES "Conversation"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;$/,
    );
  });
});
