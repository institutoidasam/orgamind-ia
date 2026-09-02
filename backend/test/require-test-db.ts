/**
 * Trava de segurança para specs que tocam um Postgres real (ex.: prisma/seed.spec.ts).
 *
 * Sem isolamento de banco (banco efêmero via testcontainers ainda não existe — ver
 * Camada 2 do doc do bug em
 * docs/superpowers/plans/2026-08-04-bug-vitest-trunca-banco-dev.md), o único jeito
 * de garantir que um `TRUNCATE ... CASCADE` nunca acerte o banco de dev é:
 *
 *   1. nunca rodar contra um banco que não seja reconhecidamente de teste
 *      (nome do database termina em "_test"); e
 *   2. nunca rodar sem alguém pedir explicitamente (env PICOA_DB_TESTS=1) — assim
 *      `bun run test` continua verde numa máquina sem banco nenhum de pé.
 *
 * Lógica pura de parsing/decisão — sem I/O, sem banco. Testado em
 * `require-test-db.spec.ts`.
 */

/** Extrai o nome do database de uma DATABASE_URL do Postgres (sem a barra inicial). */
export function extractDatabaseName(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }

  const name = parsed.pathname.replace(/^\//, '');
  return name === '' ? undefined : name;
}

/** Um banco é "de teste" se o nome do database termina em "_test". */
export function isTestDatabaseUrl(databaseUrl: string | undefined): boolean {
  const name = extractDatabaseName(databaseUrl);
  return name !== undefined && name.endsWith('_test');
}

/**
 * `true` só quando alguém pediu explicitamente para rodar os testes que tocam um
 * banco real (env PICOA_DB_TESTS=1). Qualquer outra coisa — ausente, "0", "true" —
 * significa "não rodar".
 */
export function shouldRunDbTests(env: { PICOA_DB_TESTS?: string } = process.env): boolean {
  return env.PICOA_DB_TESTS === '1';
}

/**
 * Lança um erro claro (nome do banco + o que fazer) se o DATABASE_URL não apontar
 * para um banco de teste. Chamar isto ANTES de qualquer TRUNCATE/reset — é a última
 * linha de defesa caso o guard de skip do describe não esteja em vigor.
 */
export function assertTestDatabase(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): void {
  if (isTestDatabaseUrl(databaseUrl)) return;

  const name = extractDatabaseName(databaseUrl) ?? '(DATABASE_URL ausente ou inválida)';
  throw new Error(
    `Recusando rodar testes destrutivos de banco: o alvo é "${name}", que não parece ` +
      `ser um banco de teste (o nome do database precisa terminar em "_test"). ` +
      `PICOA_DB_TESTS=1 está setada, então isto rodaria TRUNCATE ... CASCADE contra um ` +
      `banco real — provavelmente o banco de dev. Aponte DATABASE_URL para um banco cujo ` +
      `nome termine em "_test" (ex.: postgresql://.../picoa_test) antes de rodar de novo.`,
  );
}
