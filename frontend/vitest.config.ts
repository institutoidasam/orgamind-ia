import path from 'path';
import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Don't collect the Playwright e2e specs (they pull a second @playwright/test
    // and fail under vitest). e2e runs via `playwright test` (test:e2e).
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // zod v4's package entry resolves to an undefined `z` under vitest's default
    // externalization (the app's vite build is unaffected). Inlining zod makes
    // vitest process it through its own pipeline so `z.object` is defined.
    server: { deps: { inline: ['zod'] } },
  },
});
