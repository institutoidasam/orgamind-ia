import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { signIn } from './helpers/auth';

/**
 * Caminho da planilha de fixture, a partir do arquivo de teste.
 *
 * `__dirname` NÃO existe aqui: `frontend/package.json` declara
 * `"type": "module"`, então o Playwright carrega este spec como ESM e o
 * `ReferenceError: __dirname is not defined` estoura em runtime (era o que
 * acontecia — escondido, porque uma asserção anterior falhava antes de chegar
 * nesta linha). `test.info().file` dá o caminho absoluto do próprio spec e
 * independe do sistema de módulos.
 */
function fixturePath(name: string): string {
  return path.join(path.dirname(test.info().file), 'fixtures', name);
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('import Excel and see contacts', async ({ page }) => {
  // Este teste não tem nada a dizer sobre autenticação: quer só uma sessão. A
  // troca de senha obrigatória do admin semeado já foi cumprida uma vez pelo
  // projeto `setup` (e2e/auth.setup.ts), então aqui o login cai direto no
  // dashboard.
  await signIn(page);

  // `/imports` é `hideInSidebar` (src/lib/nav.ts) e seu rótulo é "Imports" —
  // nunca houve link "Importações" na barra lateral para clicar. A tela se
  // alcança por URL; daí em diante o fluxo segue pelo clique, que é o que este
  // teste quer exercitar.
  await page.goto('/imports');
  await page.getByRole('link', { name: 'Nova importação' }).click();

  // Nome de arquivo ÚNICO por execução: o backend grava `file.originalname`
  // como `filename` do lote (`imports.controller.ts` → `createPendingBatch`) e
  // a tela de Histórico o exibe na coluna "Arquivo" (`imports/index.tsx`) — é o
  // único campo do lote que a tela de fato expõe e que este teste controla. Com
  // banco sujo, uma execução anterior já deixou um lote "contacts.xlsx"
  // Concluído na tabela; usar sempre o mesmo nome faria a asserção abaixo casar
  // DOIS lotes (o velho e o novo) e cair em strict mode, ou pior, passar
  // testando o lote errado. O conteúdo continua sendo a mesma fixture — só o
  // nome do arquivo enviado muda.
  const uniqueFilename = `contacts-${test.info().testId}-${Date.now()}.xlsx`;
  const fileBuffer = readFileSync(fixturePath('contacts.xlsx'));

  // Upload
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: uniqueFilename,
    mimeType: XLSX_MIME,
    buffer: fileBuffer,
  });
  await page.getByRole('button', { name: 'Importar' }).click();

  // Should redirect to imports list
  await expect(page).toHaveURL(/\/imports$/);

  // O parse+gravação roda no WORKER, assíncrono (o upload responde 202 na hora)
  // — o contato só existe depois que o lote termina. A tela de Histórico já faz
  // polling enquanto houver lote não-terminal (`importsRefetchInterval`), então
  // esperar por "Concluída" aqui é o que torna o passo seguinte determinístico:
  // a lista de contatos é buscada UMA vez ao navegar, sem refetch, e leria o
  // banco antes do worker escrever.
  //
  // Escopado à LINHA do lote que ESTE teste acabou de criar (via
  // `uniqueFilename`, que só aparece na célula "Arquivo" desta linha) — nunca a
  // `getByRole('cell', ...)` solto na tabela inteira nem a `.first()`: banco
  // sujo pode ter outros lotes "Concluída" de execuções anteriores, e
  // `.first()` casaria por acidente o lote ERRADO em vez de estourar em strict
  // mode.
  const batchRow = page.getByRole('row', { name: uniqueFilename });
  await expect(batchRow.getByRole('cell', { name: 'Concluída' })).toBeVisible({
    timeout: 60_000,
  });

  // Go to contacts and see one of the imported contacts
  await page.getByRole('link', { name: 'Contatos' }).click();
  await expect(page.getByText('+5592987654321')).toBeVisible({ timeout: 10_000 });
});
