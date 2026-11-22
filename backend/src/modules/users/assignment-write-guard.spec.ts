import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guarda estática do aceite 20 (DV15c, GV1): só `assignment-writer.ts` grava
// setor, turno e nível da pessoa e `UserAssignment`. Limite aceito: `data`
// montado em variável fora da chamada escapa daqui; a recusa em tempo de
// execução do `UsersRepository` (DV15b) cobre esse caminho.

type Violation = { line: number; reason: string };

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const WRITER = join('src', 'modules', 'users', 'assignment-writer.ts');
const USER_WRITE =
  /\.user\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;
const ASSIGNMENT_WRITE =
  /\.userAssignment\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
// Chave que carrega os dados da gravação (`upsert` usa create e update).
const DATA_KEY = /[{,]\s*\b(?:data|create|update)\b\s*:/g;
// Chave de vínculo no corpo de `data`: com valor (`sectorId: x`) ou abreviada.
const LINK_KEY =
  /[{,]\s*\b(sectorId|shiftId|levelId|sector|workShift|level|assignments)\b(?=\s*[:,}])/g;

/** Fim (exclusivo) do texto que começa em `start` e fecha no `)`, `}` ou `]` sem par. */
function balancedEnd(code: string, start: number, stopAtComma: boolean) {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const char = code[i];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    if (depth < 0 || (stopAtComma && depth === 0 && char === ',')) return i;
  }
  return code.length;
}

function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (quote !== '`' && source[i] === '\n') return i;
    if (source[i] === '\\') i += 1;
    i += 1;
  }
  return Math.min(i + 1, source.length);
}

/** Fim do comentário ou da string que começa em `start`; `start` se não houver. */
function skippedEnd(source: string, start: number): number {
  const pair = source.slice(start, start + 2);
  if (pair === '//') {
    const lineEnd = source.indexOf('\n', start);
    return lineEnd === -1 ? source.length : lineEnd;
  }
  if (pair === '/*') {
    const close = source.indexOf('*/', start + 2);
    return close === -1 ? source.length : close + 2;
  }
  return '\'"`'.includes(source[start]) ? stringEnd(source, start) : start;
}

/** Troca comentários e textos por espaços (quebras de linha ficam): índices e linhas se mantêm. */
function blankNonCode(source: string): string {
  let code = '';
  let i = 0;
  while (i < source.length) {
    const end = skippedEnd(source, i);
    code += end === i ? source[i] : source.slice(i, end).replace(/[^\n]/g, ' ');
    i = end === i ? i + 1 : end;
  }
  return code;
}

function lineOf(code: string, offset: number): number {
  return code.slice(0, offset).split('\n').length;
}

/** Chamadas `.user.<escrita>(`: cada chave de vínculo dentro de data/create/update. */
function userViolations(code: string): Violation[] {
  const found: Violation[] = [];
  for (const call of code.matchAll(USER_WRITE)) {
    const open = call.index + call[0].length;
    const text = code.slice(open, balancedEnd(code, open, false));
    for (const data of text.matchAll(DATA_KEY)) {
      const from = data.index + data[0].length;
      const value = text.slice(from, balancedEnd(text, from, true));
      for (const key of value.matchAll(LINK_KEY)) {
        found.push({
          line: lineOf(
            code,
            open + from + key.index + key[0].length - key[1].length,
          ),
          reason: `grava "${key[1]}" em user.${call[1]}`,
        });
      }
    }
  }
  return found;
}

function assignmentViolations(code: string): Violation[] {
  return [...code.matchAll(ASSIGNMENT_WRITE)].map((call) => ({
    line: lineOf(code, call.index),
    reason: `grava em userAssignment.${call[1]}`,
  }));
}

/** Escritas de vínculo no texto de um arquivo (cada uma com a linha). */
function findAssignmentWrites(source: string): Violation[] {
  const code = blankNonCode(source);
  return [...userViolations(code), ...assignmentViolations(code)];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

/** `backend/src/**\/*.ts` e `backend/prisma/*.ts`, fora specs, fixtures de teste e o escritor. */
function productionFiles(): string[] {
  const prismaDir = join(BACKEND_ROOT, 'prisma');
  const seeds = readdirSync(prismaDir).map((name) => join(prismaDir, name));
  return [...sourceFiles(join(BACKEND_ROOT, 'src')), ...seeds].filter(
    (file) =>
      file.endsWith('.ts') &&
      !/\.(spec|test-fixtures)\.ts$/.test(file) &&
      relative(BACKEND_ROOT, file) !== WRITER,
  );
}

describe('guarda estática do vínculo (aceite 20)', () => {
  it('nenhum arquivo fora do escritor grava setor, turno ou nível da pessoa nem UserAssignment', () => {
    const files = productionFiles();
    const found = files.flatMap((file) =>
      findAssignmentWrites(readFileSync(file, 'utf8')).map(
        (v) => `${relative(BACKEND_ROOT, file)}:${v.line} ${v.reason}`,
      ),
    );

    expect(files.map((file) => relative(BACKEND_ROOT, file))).toContain(
      join('src', 'modules', 'users', 'users.repository.ts'),
    );
    expect(found).toEqual([]);
  });
});

const VIOLATIONS: Array<[string, string, Violation]> = [
  [
    'chave abreviada em update',
    'await tx.user.update({\n  where: { id },\n  data: { sectorId },\n});',
    { line: 3, reason: 'grava "sectorId" em user.update' },
  ],
  [
    'relação em create',
    'await db.user.create({\n  data: { name, level: { connect: { id } } },\n});',
    { line: 2, reason: 'grava "level" em user.create' },
  ],
  [
    'create de upsert',
    'await prisma.user.upsert({\n  where,\n  update: {},\n  create: {\n    shiftId: s,\n  },\n});',
    { line: 5, reason: 'grava "shiftId" em user.upsert' },
  ],
  [
    'UserAssignment direto',
    'await tx.userAssignment.deleteMany({ where: { userId } });',
    { line: 1, reason: 'grava em userAssignment.deleteMany' },
  ],
];

describe('findAssignmentWrites acusa o exemplo de violação', () => {
  it.each(VIOLATIONS)('%s', (_name, source, expected) => {
    expect(findAssignmentWrites(source)).toEqual([expected]);
  });
});

describe('findAssignmentWrites deixa passar o que não grava vínculo', () => {
  it('filtro em where, leitura, comentário, texto e data sem vínculo', () => {
    const source = [
      '// tx.user.update({ data: { sectorId } })',
      'await tx.user.update({ where: { sectorId }, data: { name: "sector" } });',
      'await tx.user.findMany({ where: { sector: { id } } });',
      'await tx.userAssignment.findFirst({ where: { userId } });',
      'await tx.user.updateMany({ where: { id }, data: { isActive: false } });',
    ].join('\n');

    expect(findAssignmentWrites(source)).toEqual([]);
  });
});
