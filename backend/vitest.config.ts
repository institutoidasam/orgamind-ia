import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // O plugin SWC assume toda a transformação TypeScript. Desabilite os dois
  // transformadores nativos do Vite para evitar que o Vitest ative Oxc ao
  // mesmo tempo que `esbuild: false`.
  esbuild: false,
  oxc: false,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'prisma/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    // Specs de banco (campaigns.batches.e2e.spec.ts, contact-validity.db.spec.ts, prisma/seed.spec.ts)
    // truncam o mesmo banco _test; em paralelo eles se atropelam. Desabilitar parallelismo apenas
    // quando PICOA_DB_TESTS=1 para evitar conflitos de truncate concurrent.
    fileParallelism: process.env.PICOA_DB_TESTS !== '1',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: ['src/main.ts', 'src/worker.ts', 'src/**/*.module.ts', 'src/**/*.dto.ts'],
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
      },
    }),
  ],
});
