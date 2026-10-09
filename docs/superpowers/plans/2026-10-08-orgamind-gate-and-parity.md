# Plano — validação real, gate completo e paridade Picoa

Spec: `docs/superpowers/specs/2026-10-08-orgamind-gate-and-parity.md`.
Base Git: `f4abdb9` em `codex/orgamind-visual-rebrand`; `origin/main` aponta ao mesmo commit. `main` local conserva `5a37735` sem push. Ledger: `.superpowers/sdd/2026-10-08-orgamind-gate-and-parity/progress.md`.

## Task 1 — regressão de Hooks no dashboard

Ownership: `frontend/src/routes/_authenticated/dashboard.tsx`, novo componente sob `frontend/src/features/dashboard/components/` e testes diretamente relacionados. Extrair `DashboardPage` com nome válido e preservar a rota como adaptador. Aceite: nenhuma violação `rules-of-hooks` ou `only-export-components` nesses arquivos; métricas, campanhas, erros e navegação preservados; teste focado, typecheck, lint/Sonar/complexidade dos arquivos completos e gate do diff. Risco baixo.

## Task 2 — função longa no sidebar

Ownership: `frontend/src/components/layout/sidebar.tsx` e `.spec.tsx`. Extrair apresentação de itens/marca/identidade preservando `collapsed`, `user` e `onNavigate`. Aceite: funções até 50 linhas e complexidade até 10; ADMIN, badges, ativo e fechamento móvel cobertos; teste focado, typecheck e QA móvel. Risco médio.

## Task 3 — QA com API real local

Ownership: validação somente leitura e scripts descartáveis em `/tmp`; stack Docker isolada `orgamind-rebrand-qa`, sem worker nem Evolution. Testar health/ready, login, dashboard e rotas principais em navegador com banco local. Aceite: registrar endpoints/rotas, resultado e limitações; não enviar mensagens a provedores. Risco médio por dependências de ambiente.

## Task 4 — saneamento do gate completo

Fatiar por módulo em tarefas adicionais após inventário dos achados completos: consentimento, assistente de campanha, templates/schemas/APIs, rotas, UI/exportações e testes longos. Cada task limita ownership a 1–3 arquivos de produção e specs relacionados; TDD/BDD para comportamento, revisão independente para contratos/identidade/persistência. Preservar baseline `f4abdb9`; não mexer no gate para forçar PASS. Fechamento com typecheck/build e gate completo PASS, inclusive cobertura ≥80% de linhas e ≥70% de branches. Inventário inicial: lint 126 erros/11 avisos, Sonar 69, complexidade 311, cobertura 76,5% linhas; agregado pode ocultar regressões, por isso comparar `(arquivo, regra)`.

### Task 4A — declaração DOM do frontend

Ownership: `frontend/tsconfig.json`. O detector Sonar do gate lê `tsconfig.json` e só reconhece globais de navegador quando o projeto declara DOM nessa raiz; hoje DOM está em `tsconfig.app.json`, referenciado pela raiz. Verificar a hipótese com a ferramenta atual, então alinhar a declaração de libs sem alterar regras ou limiares do gate. Aceite: typecheck/build mantidos, achados `no-reference-error` de globais reais do browser desaparecem, achados legítimos de nomes inexistentes continuam, e análise dos arquivos inteiros documentada. Risco baixo a médio por impacto de tipos na raiz.

### Task 4B — demais fatias

Separar exportações Fast Refresh, efeitos de estado, regex/HTTP/senhas, complexidade e cobertura por módulo. Não apagar testes nem neutralizar checks para reduzir contagem; cada task registra mapa `(arquivo, regra)`, cenário preservado, evidência RED/GREEN quando há mudança de comportamento, e gate do diff. Prioridade para consentimento, campanhas, templates e autenticação; testes longos são refatorados junto ao módulo correspondente.

### Task 4B1 — paleta de comandos

Ownership: `frontend/src/components/command-palette.tsx`, sua spec e helpers novos sob `frontend/src/components/` se necessários. Corrigir `react-hooks/set-state-in-effect` e complexidade da função sem mudar atalhos, busca, foco, navegação ou fechamento. Aceite: testes comportamentais para abrir/buscar/fechar/foco, typecheck, ESLint e Sonar dos arquivos completos sem novos achados, função ≤50 linhas, gate do diff PASS. Risco médio por teclado/foco.

### Task 4B2a — exports de variantes não usados

Ownership: `frontend/src/components/ui/badge.tsx` e `tabs.tsx`. Verificar consumidores de `badgeVariants` e `tabsListVariants`; se forem internos, retirar apenas os exports incompatíveis com Fast Refresh, preservando componentes e estilos. Aceite: typecheck/build, ESLint dos arquivos completos e gate do diff PASS; sem testes que espelhem a implementação. Risco baixo.

### Task 4B2b — variante de botão compartilhada

Ownership: `frontend/src/components/ui/button.tsx`, `alert-dialog.tsx` e um módulo novo de variantes. Mover `buttonVariants` para módulo sem componente e ajustar o import do diálogo, preservando assinatura/estilos. Aceite: typecheck/build, ESLint dos arquivos completos e gate do diff PASS; revisão dos consumidores. Risco baixo a médio.

### Task 4B3 — explorador de eventos

Ownership: `frontend/src/components/events-explorer.tsx` e `.spec.tsx`, helpers novos do componente se necessários. Refatorar a função longa e a atualização síncrona de estado em efeito, preservar filtros, paginação, polling ao vivo e seleção. Aceite: cenários comportamentais focados, lint/complexidade/Sonar dos arquivos completos, typecheck e gate do diff; nenhum novo achado. Risco médio.

### Task 4B4 — lanes de eventos

Ownership: `frontend/src/components/swim-lanes.tsx` e `.spec.tsx`. Extrair cálculos/apresentação para eliminar funções longas e complexidade excessiva, preservando durações, estados de falha/cancelamento e marcas de progresso. Aceite: teste focado, lint/complexidade dos arquivos completos, typecheck e gate do diff. Risco baixo a médio.

### Task 4B5 — cobertura de contratos API

Fatiar por módulo com ownership disjunto de uma API e seus testes por task: `features/templates/api.ts` (46 linhas sem cobertura no baseline), `features/campaigns/api.ts` (71), `features/whatsapp/api.ts` (57), `features/chat/api.ts` (48). Cobrir serialização, status de erro e chamadas relevantes com mock do cliente de HTTP sem espelhar a implementação. Aceite por fatia: teste focado, typecheck, gate do diff e nenhuma alteração indevida de contrato. A cobertura global do baseline é 76,5%; sua meta de 80% exige pelo menos ~152 linhas adicionais cobertas se o denominador ficar constante. Risco médio por contratos externos.

## Task 5 — paridade Picoa

Auditoria read-only em andamento nos dois repositórios. Persistir achados verificáveis, revisar os de risco maior e converter cada lacuna confirmada em task pequena com ownership, contrato e testes. Não modificar o repositório Picoa nem copiar suas mudanças não commitadas.

### Task 5A — sal de consentimento em produção

Finding independente: `docker-compose.prod.yml` fixa `PICOA_CONSENT_SALT` só no serviço `migrate` com literal placeholder, enquanto `api` e `worker` caem no default `orgamind-consent-dev`. Isso viola o contrato de hashes de consentimento. O usuário confirmou banco novo, sem dados do Picoa, mas duplicatas futuras ainda podem ser reidratadas pelo `migrate`. Ownership: `docker-compose.prod.yml`, `.env.example` e `.env.prod.example`; documentação operacional pode ser ajustada pela principal. Exigir uma única variável externa e não vazia nos três serviços, sem valor literal ou fallback no compose; preservar qualquer sal histórico no ambiente real. Aceite: `docker compose config` falha sem a variável, passa com valor de teste e mostra igualdade dos três valores por consulta filtrada sem imprimir segredo; nenhum deploy/serviço reiniciado; revisão independente obrigatória. Risco alto (consentimento/persistência).

### Task 5B — proteção contra sal de exemplo em produção

Revisão da Task 5A observou que `.env.prod.example` usa sentinel não vazio, aceito pelo Compose se for colado sem substituição. Ownership: `backend/src/shared/config/env.schema.ts` e `.spec.ts`. Exigir em `NODE_ENV=production` que `PICOA_CONSENT_SALT` não seja o default dev nem o sentinel do template, mantendo o default para dev/teste; cenários RED/GREEN para produção, dev e vazio. Aceite: teste focado, typecheck/backend gate do diff e revisão independente por risco de consentimento. Não registrar valor real do ambiente.

### Task 5C — compatibilidade do runner Vitest backend com gate

Gate `--changed` do backend executou os testes (`vitest.json` indica 164 PASS de 169, 5 pendentes), mas classificou como erro o aviso em stderr: plugin SWC define `esbuild: false` e a versão instalada do Vitest exige também `oxc: false`. Ownership: `backend/vitest.config.ts`, teste/config relacionado somente se indispensável. Confirmar causa na instalação local e ajustar a opção mantendo transformação SWC e suíte nativa; reexecutar teste focado e gate do diff. Não trocar runner, regras ou limiares. Risco médio.

### Task 5D — imports de módulos nos testes backend relacionados

Após resolver o aviso Vitest, o runner ainda sai 1 com 170 testes aprovados, 5 ignorados e 3 rejeições não tratadas. `worker.health.spec.ts` importa `worker.ts` estaticamente; `chat-ingest.integration.spec.ts` e `webhooks.integration.spec.ts` importam `AppModule` no topo mesmo quando opt-in está desabilitado. Esses imports inicializam `ConfigModule` sem grupo de provedor no ambiente de teste e já existiam em `f4abdb9`. Ownership: somente esses três specs. Evitar import de AppModule em suíte ignorada; preparar fixture de env segura antes do import no worker ou extrair helper puro se o diff estrito justificar. Aceite: Vitest `related` exit 0, JSON success true e nenhum unhandled; gate backend changed PASS; suítes opt-in preservam configuração de provedor completa e não acessam credenciais reais. Risco médio por isolamento de teste.

### Task 5E — validação do sal antes de qualquer escrita da migração

Revisão final encontrou P1: `migrate` roda Prisma/scripts sem `validateEnv`; Compose aceita whitespace/sentinel e a reidratação pode escrever antes de API/worker recusarem o boot. Extrair regra compartilhada de sal para módulo puro em `backend/src/shared/config/`, usado pelo schema e por CLI compilada da mesma pasta. O compose deve executar a CLI com Node antes da primeira migração/seed/reparo, com erro constante sem segredo. Confirmar que o Dockerfile copia `dist` e que o caminho compilado existe; não adicionar runner/dependência. Ownership coerente: módulo puro, CLI e specs próprios, `env.schema.ts` e teste do comando em `env.schema.spec.ts`, `docker-compose.prod.yml`. Aceite: CLI rejeita ausente/vazio/whitespace/default/sentinel antes de escrita, aceita sal de teste, mesma regra de API/worker; build emitido em pasta temporária (não alterar `dist` root-owned), gate do diff e revisão independente de risco alto. Nenhum deploy.

## Task 6 — deploy

Cancelada pelo usuário: não há alvo OrgaMind nos Dokploys configurados e ele instruiu a não fazer deploy nessa situação. Não criar aplicação nem publicar por iniciativa própria.
