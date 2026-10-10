import { expect, type Page } from '@playwright/test';

/**
 * Credenciais do admin SEMEADO — lidas do MESMO env que `backend/prisma/seed.ts`
 * lê, com os mesmos defaults. Um dev que semeou com `SEED_ADMIN_PASSWORD` próprio
 * não precisa editar teste nenhum; o CI, que não define nada, cai no default.
 */
export const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@picoa.local';
export const SEEDED_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';

/**
 * A senha PESSOAL que o e2e passa a usar depois de cumprir a troca obrigatória
 * (ver `e2e/auth.setup.ts`). Mínimo 8 caracteres: `changePasswordSchema`
 * (src/features/auth/schemas.ts) e o DTO do backend recusam menos que isso.
 */
export const E2E_PASSWORD = 'senha-e2e-do-picoa';

/**
 * ORÇAMENTO DE LOGINS — leia antes de acrescentar um `submitLogin`.
 *
 * `POST /auth/login` é limitado a 5 chamadas por minuto POR IP
 * (`@Throttle` em auth.controller.ts; anônimo ⇒ UserThrottlerGuard cai na
 * chave `ip:`). No CI a suíte inteira sai do mesmo 127.0.0.1 e cabe numa
 * janela de 60s, então os logins não se diluem no tempo — eles se somam.
 *
 * No banco recém-semeado são 5: setup (2: senha semeada + novo login após a
 * troca), login válido (1), login inválido (1) e import (1). Com banco sujo,
 * o setup faz 2 chamadas (senha semeada falha + login normal), portanto também
 * chega a 5 no total — o teto.
 * O 6º login vira 429 e a suíte fica vermelha por motivo nenhum.
 */

/** Traduz o status de `/auth/login` para uma mensagem que explica a falha. */
export function describeLoginStatus(status: number): string {
  if (status === 429) {
    return (
      'POST /auth/login respondeu 429: o limite de 5 logins/min por IP estourou. ' +
      'Veja o "ORÇAMENTO DE LOGINS" em e2e/helpers/auth.ts — algum teste novo ' +
      'passou do teto, ou a suíte foi reexecutada dentro da mesma janela de 60s.'
    );
  }
  if (status === 401) {
    return (
      'POST /auth/login respondeu 401: a conta não está no estado que ' +
      'e2e/auth.setup.ts deixa (senha E2E_PASSWORD, mustChangePassword limpo). ' +
      'O projeto `setup` rodou? (playwright.config.ts → dependencies: ["setup"])'
    );
  }
  return `POST /auth/login respondeu ${status}.`;
}

/**
 * Preenche e envia o formulário de `/login` e devolve o STATUS HTTP da chamada.
 *
 * Espera pela resposta da API, não por URL nem por toast: o desfecho do submit
 * é ambíguo na tela (pode ir para `/dashboard`, para `/change-password`, ou não
 * sair do lugar), e correr atrás de três resultados possíveis é receita de
 * flake. O status distingue os três sem ambiguidade — e distingue 401 (senha
 * errada) de 429 (rate limit), que na tela dão toasts diferentes mas num
 * `waitFor` genérico dariam o mesmo "falhou".
 */
export async function submitLogin(page: Page, password: string): Promise<number> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Senha').fill(password);

  const loginCall = page.waitForResponse(
    (r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Entrar' }).click();
  return (await loginCall).status();
}

/** Fecha o diálogo automático de novidades que bloqueia o conteúdo da página. */
export async function dismissReleaseNotes(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Novidades' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar' }).click();
  await expect(dialog).toBeHidden();
}

/** Janela do `@Throttle` de `/auth/login` (60s no controller), com folga. */
const LOGIN_RATE_LIMIT_WINDOW_MS = 65_000;

/**
 * Igual a {@link submitLogin}, mas espera a janela do rate limit expirar e
 * tenta UMA vez mais se levar 429.
 *
 * Só o `setup` usa isto, e só por causa da reexecução rápida contra o mesmo
 * banco: nesse caminho ele gasta um login a mais (fallback) e pode encostar no
 * teto de 5/min deixado pela execução anterior — um 429 que não é defeito de
 * ninguém, só a suíte rodando duas vezes em menos de um minuto. No CI, com
 * banco semeado do zero, este ramo nunca é alcançado.
 *
 * Os specs propriamente ditos continuam com o `submitLogin` estrito: lá, um 429
 * significa que o orçamento de logins estourou de verdade, e isso tem de falhar
 * alto em vez de virar um minuto de espera silenciosa.
 */
export async function submitLoginWaitingOutRateLimit(
  page: Page,
  password: string,
): Promise<number> {
  const first = await submitLogin(page, password);
  if (first !== 429) return first;

  await page.waitForTimeout(LOGIN_RATE_LIMIT_WINDOW_MS);
  return submitLogin(page, password);
}

/**
 * Cumpre a tela de troca de senha (assume que a página já está em
 * `/change-password`).
 *
 * Seletores por `name=` e NÃO por rótulo: os `<Label>` de
 * `src/routes/change-password.tsx` não têm `htmlFor` e os `<Input>` não têm
 * `id`, então nada associa rótulo a campo ali e `getByLabel('Senha atual')` não
 * encontra elemento algum. Quem nomeia os campos é o `register()` do
 * react-hook-form. (Associar rótulo e campo seria uma correção de a11y de
 * verdade — mas é mudança de produto, fora do escopo deste conserto de teste.)
 */
export async function completePasswordChange(
  page: Page,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await page.locator('input[name="currentPassword"]').fill(currentPassword);
  await page.locator('input[name="newPassword"]').fill(newPassword);
  await page.locator('input[name="confirmPassword"]').fill(newPassword);
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
}

/**
 * Sessão autenticada pronta para uso, para os testes que só querem estar
 * logados e não têm nada a dizer sobre autenticação.
 *
 * Cai direto no `/dashboard` porque o projeto `setup` já cumpriu a troca
 * obrigatória: `mustChangePassword` está limpo, então o guard de
 * `_authenticated` não desvia mais para `/change-password`.
 */
export async function signIn(page: Page): Promise<void> {
  const status = await submitLogin(page, E2E_PASSWORD);
  expect(status, describeLoginStatus(status)).toBe(200);
  await expect(page).toHaveURL(/\/dashboard$/);
  await dismissReleaseNotes(page);
}
