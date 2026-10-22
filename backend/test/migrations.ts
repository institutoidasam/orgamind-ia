import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Helpers de migração para specs com testcontainers. Só rodam contra o banco
 * do container recebido por parâmetro (GC3: nunca `migrate reset`).
 */
const PRISMA_DIR = path.resolve(__dirname, '..', 'prisma');
const PRISMA_CLI = require.resolve('prisma/build/index.js');

function runPrisma(args: string[], databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI, ...args], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

/** Copia schema, lock e as migrações com nome <= `until` para um diretório temporário. */
function copyMigrationsUntil(until: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orgamind-migrations-'));
  cpSync(
    path.join(PRISMA_DIR, 'schema.prisma'),
    path.join(dir, 'schema.prisma'),
  );
  const source = path.join(PRISMA_DIR, 'migrations');
  const target = path.join(dir, 'migrations');
  cpSync(
    path.join(source, 'migration_lock.toml'),
    path.join(target, 'migration_lock.toml'),
  );
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name <= until) {
      cpSync(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
      });
    }
  }
  return dir;
}

/**
 * `prisma migrate deploy` no banco informado. Com `until`, aplica só as
 * migrações cujo nome (timestamp) é <= `until`; sem ele, todas.
 */
export function deployMigrations(opts: {
  databaseUrl: string;
  until?: string;
}): void {
  const dir = opts.until ? copyMigrationsUntil(opts.until) : null;
  try {
    const schema = path.join(dir ?? PRISMA_DIR, 'schema.prisma');
    runPrisma(['migrate', 'deploy', '--schema', schema], opts.databaseUrl);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Mesmo check do job `migration-drift` do CI: diff entre as migrações (aplicadas
 * no shadow) e o schema.prisma. `script` sai sem linhas de comentário `--`.
 */
export function schemaDrift(opts: { shadowUrl: string }): {
  status: number;
  script: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      PRISMA_CLI,
      'migrate',
      'diff',
      '--from-migrations',
      path.join(PRISMA_DIR, 'migrations'),
      '--to-schema-datamodel',
      path.join(PRISMA_DIR, 'schema.prisma'),
      '--shadow-database-url',
      opts.shadowUrl,
      '--script',
      '--exit-code',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: opts.shadowUrl },
    },
  );
  // 0 = sem diff, 2 = há diff; outro código é erro do CLI (vai para o log).
  if (result.status !== 0 && result.status !== 2) {
    process.stderr.write(result.stderr ?? String(result.error));
  }
  const script = (result.stdout ?? '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();
  return { status: result.status ?? -1, script };
}
