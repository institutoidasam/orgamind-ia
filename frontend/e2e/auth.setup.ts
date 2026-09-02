import { test as setup, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  SEEDED_PASSWORD,
  completePasswordChange,
  describeLoginStatus,
  submitLoginWaitingOutRateLimit,
} from './helpers/auth';

/**
 * A TROCA DE SENHA OBRIGATÓRIA NÃO É UM OBSTÁCULO DO TESTE — É O PRODUTO.
 *
 * O admin nasce do seed com `mustChangePassword: true` (`@default(true)` em
 * schema.prisma, e `backend/prisma/seed.ts` o cria explicitamente assim). Num
 * banco recém-semeado — o caso do CI, SEMPRE — logar com a senha padrão leva a
 * `/change-password`, e isso está certo: uma senha que está publicada no
 * repositório não pode virar credencial de operação. Então o e2e não desliga a
 * exigência (nem por env, nem mexendo no seed): ele a CUMPRE, aqui, uma vez, e
 * deixa a conta num estado normalizado (senha `E2E_PASSWORD`, flag limpa) para
 * os demais specs.
 *
 * ── POR QUE UM PROJETO `setup`, E NÃO A ORDEM DOS ARQUIVOS ──────────────────
 * A troca de senha é IRREVERSÍVEL dentro de uma execução: depois dela, ninguém
 * mais entra com a senha semeada. Isso cria dependência de ordem, e a ordem dos
 * arquivos de spec é alfabética por acidente, não por garantia — hoje
 * `import-and-contacts` roda ANTES de `login`. `dependencies: ['setup']`
 * (playwright.config.ts) é a única forma de dizer "isto primeiro" e ter isso
 * valendo.
 *
 * ── POR QUE NÃO GRAVAMOS `storageState` ─────────────────────────────────────
 * É o padrão do Playwright, e neste app ele QUEBRARIA a suíte:
 *
 *  1. o accessToken de propósito NÃO é persistido (auth.store.ts, `partialize`
 *     — defesa contra XSS), então um storageState não carrega a sessão;
 *  2. o que carregaria é o cookie `picoa_refresh`, mas ele ROTACIONA A CADA USO
 *     e tem DETECÇÃO DE REÚSO (refresh.service.ts). storageState é um retrato
 *     fixo: o 1º teste rotacionaria o cookie salvo, o 2º apresentaria o cookie
 *     VELHO, o backend leria isso como replay, queimaria a família inteira
 *     (`auth.refresh_reuse_detected`) e derrubaria todos os testes seguintes.
 *
 * Um login por teste custa uma requisição e dá isolamento de verdade — cada
 * teste com a sua própria família de refresh. O preço é o teto de 5 logins/min
 * do `/auth/login`; ver "ORÇAMENTO DE LOGINS" em e2e/helpers/auth.ts.
 */
setup('admin semeado cumpre a troca de senha obrigatória', async ({ page }) => {
  // Teto folgado: só o caminho de banco reaproveitado usa, e usa para esperar a
  // janela de 60s do rate limit de `/auth/login` expirar. O caminho normal (CI,
  // banco semeado do zero) leva poucos segundos e nunca chega perto disto.
  setup.setTimeout(3 * 60_000);

  const seeded = await submitLoginWaitingOutRateLimit(page, SEEDED_PASSWORD);

  if (seeded === 401) {
    // Banco reaproveitado de uma execução anterior: a senha semeada já foi
    // trocada por esta mesma rotina. O CI sempre semeia do zero e nunca passa
    // por aqui; quem passa é o dev rodando a suíte duas vezes contra o mesmo
    // banco. Basta confirmar que a conta está no estado que os specs esperam.
    const normalized = await submitLoginWaitingOutRateLimit(page, E2E_PASSWORD);
    expect(
      normalized,
      'A senha semeada não vale mais, e a senha do e2e também não: ' +
        'o admin está num estado que este setup não sabe recuperar. ' +
        `Ressemeie o banco (cd backend && bun run prisma db seed) — ${describeLoginStatus(normalized)}`,
    ).toBe(200);
    await expect(page).toHaveURL(/\/dashboard$/);
    return;
  }

  expect(seeded, describeLoginStatus(seeded)).toBe(200);

  // O comportamento que se está protegendo: a senha semeada NÃO dá acesso ao
  // produto. `?redirect=%2Fdashboard` é o destino guardado para depois da troca.
  await expect(page).toHaveURL(/\/change-password\?redirect=%2Fdashboard$/);

  await completePasswordChange(page, SEEDED_PASSWORD, E2E_PASSWORD);

  // ...e o caminho completo: cumprida a troca, o operador chega onde ia.
  await expect(page).toHaveURL(/\/dashboard$/);
});
