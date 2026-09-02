import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // `retries` fica em 0 (default) DE PROPÓSITO: `POST /auth/login` é limitado a
  // 5/min por IP e cada teste faz um login, então repetição automática estoura
  // o teto e troca a falha real por um 429 confuso. Ver "ORÇAMENTO DE LOGINS"
  // em e2e/helpers/auth.ts.
  projects: [
    // Cumpre a troca de senha obrigatória do admin semeado e deixa a conta
    // normalizada para todo o resto. É um spec de verdade, com asserções —
    // aparece no relatório. Ver o cabeçalho de e2e/auth.setup.ts para o porquê
    // de ser um projeto e não apenas o primeiro arquivo.
    { name: 'setup', testMatch: /.*\.setup\.ts$/ },
    {
      name: 'chromium',
      // Garante a ordem que os specs dependem — a troca de senha é irreversível
      // dentro da execução, e ordem alfabética de arquivo não é garantia.
      dependencies: ['setup'],
      // O `testMatch` default (`**/*.@(spec|test).*`) já exclui `*.setup.ts`,
      // então o setup não roda duas vezes.
    },
  ],
  webServer: [
    {
      command: 'cd ../backend && npm run start:dev',
      port: 3000,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'bun run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
