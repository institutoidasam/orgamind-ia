import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  describeLoginStatus,
  dismissReleaseNotes,
  submitLogin,
} from './helpers/auth';

test.describe('login', () => {
  test('redirects to dashboard with valid credentials', async ({ page }) => {
    // Estado deixado pelo projeto `setup`: senha pessoal, `mustChangePassword`
    // já limpo — por isso o login cai direto no dashboard, sem desvio.
    //
    // A jornada da senha SEMEADA (login → troca obrigatória → dashboard) é
    // asserida em `e2e/auth.setup.ts`, o único momento da execução em que esse
    // estado ainda existe. Repeti-la aqui seria impossível: quando este teste
    // roda, a senha padrão já não vale mais.
    const status = await submitLogin(page, E2E_PASSWORD);
    expect(status, describeLoginStatus(status)).toBe(200);

    await expect(page).toHaveURL(/\/dashboard$/);
    await dismissReleaseNotes(page);
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  });

  test('shows error toast on invalid credentials', async ({ page }) => {
    const status = await submitLogin(page, 'senha-errada-de-proposito');
    // Afirma 401, e não "≠ 200": um 429 (rate limit) também derrubaria o login e
    // ainda mostraria um toast — passando este teste por um motivo que não é o
    // dele.
    expect(status, describeLoginStatus(status)).toBe(401);

    await expect(page.getByText('Credenciais inválidas')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
