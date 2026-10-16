import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  describeLoginStatus,
  submitLoginWaitingOutRateLimit,
} from './helpers/auth';

/**
 * Cadastro de usuário com Telefone (WhatsApp): o ADMIN abre /users, cadastra um
 * usuário ADMIN (dispensa setor) e vê o número normalizado na coluna Telefone.
 *
 * Login: `/users` exige ADMIN e o orçamento de logins por minuto do CI já está
 * no teto (ver "ORÇAMENTO DE LOGINS" em e2e/helpers/auth.ts). Este spec é o 6º
 * login, então usa a variante que espera a janela do rate limit passar em vez
 * de falhar com 429.
 */
test('admin cadastra usuário com telefone e vê o número formatado na lista', async ({ page }) => {
  // O 429 do 6º login espera 65 s (submitLoginWaitingOutRateLimit); o padrão de 30 s não cobre.
  test.setTimeout(3 * 60_000);
  const status = await submitLoginWaitingOutRateLimit(page, E2E_PASSWORD);
  expect(status, describeLoginStatus(status)).toBe(200);
  await expect(page).toHaveURL(/\/dashboard$/);

  const stamp = Date.now();
  const email = `e2e-phone-${stamp}@example.com`;
  // 8 dígitos finais do timestamp: "92 9XXXX-XXXX" (celular de Manaus, 11 dígitos).
  const last8 = String(stamp).slice(-8);
  const typedPhone = `92 9${last8}`;
  const formatted = `(92) 9${last8.slice(0, 4)}-${last8.slice(4)}`;

  await page.goto('/users');
  await expect(page).toHaveURL(/\/users(\?|$)/);
  await page.getByRole('button', { name: 'Cadastrar usuário' }).click();

  const dialog = page.getByRole('dialog', { name: 'Cadastrar usuário' });
  // Email/Nome: os <Label> do diálogo não têm htmlFor; os campos se acham por `name=`.
  await dialog.locator('input[name="email"]').fill(email);
  await dialog.locator('input[name="name"]').fill('E2E Telefone');
  await dialog.getByLabel('Telefone (WhatsApp)').fill(typedPhone);
  await dialog.getByRole('combobox', { name: 'Perfil' }).click();
  await page.getByRole('option', { name: 'Administrador' }).click();

  const created = page.waitForResponse(
    (r) => r.url().endsWith('/users') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Cadastrar', exact: true }).click();
  expect((await created).status()).toBe(201);

  // Fluxo de senha temporária inalterado: fecha o modal e confere a lista.
  await page
    .getByRole('dialog', { name: 'Senha temporária criada' })
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  const row = page.getByRole('row', { name: new RegExp(email) });
  await expect(row.getByRole('cell', { name: formatted })).toBeVisible({ timeout: 10_000 });
});
