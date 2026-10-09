# Plano — rebrand visual do Orgamind

Spec: `docs/superpowers/specs/2026-10-08-orgamind-visual-rebrand.md`.
Protótipo: `/home/andre-lima/Downloads/OrgaMind-Prototipo.html`.
Base Git inicial: `5a37735` (`main`, sem alterações no início). Baseline: `gate --path frontend --test src/routes/_authenticated/dashboard.spec.tsx` → 12/12 PASS; `gate` na raiz não detecta stack (exit 2).

## Task 1 — tokens e componentes compartilhados

Ownership: `frontend/src/styles/tokens.css`, `frontend/src/index.css`, `frontend/src/assets/logo.svg`, `frontend/src/components/ui/*`. Traduzir a paleta, tipografia, raios, foco, cores semânticas e estados dos componentes base. Preservar as APIs dos componentes e o tema escuro. Aceite: botões, inputs, cards, badges, tabs e tabelas usam os tokens; sem paleta roxa/ciano como marca; build/typecheck e testes relacionados. Risco médio por impacto transversal. Não editar shell nem páginas.

## Task 2 — shell e navegação

Ownership: `frontend/src/components/layout/app-shell.tsx`, `sidebar.tsx`, `topbar.tsx`, `footer.tsx`, testes desses arquivos quando necessário. Aplicar sidebar escura, marca/ativo laranja, topbar branca e espaçamento do conteúdo; preservar colapso desktop, drawer móvel, status WhatsApp, busca, perfil, tema e navegação. Aceite: estados ativo/colapsado/móvel verificáveis; testes relacionados e build/typecheck. Risco médio. Não editar tokens nem páginas.

## Task 3 — dashboard

Ownership: `frontend/src/routes/_authenticated/dashboard.tsx`, `frontend/src/components/kpi-hero.tsx`, `frontend/src/components/live-flow.tsx` e respectivos testes. Adaptar hierarquia e indicadores ao protótipo mantendo métricas/campanhas reais e suas ações. Aceite: KPIs compactos, cabeçalho e lista consistentes, estados vazios/error intactos, teste do dashboard e typecheck. Risco baixo a médio. Não editar tokens, shell ou outras páginas.

## Task 4 — inbox

Ownership: telas em `frontend/src/routes/_authenticated/inbox/*`, `frontend/src/features/chat/components/*` e testes diretamente relacionados. Aplicar superfícies, separadores, seleção e mensagens conforme a linguagem visual, sem alterar comportamento. Aceite: leitura e ações atuais preservadas em desktop/móvel; testes funcionais e typecheck. Risco médio pela densidade do chat.

## Task 5 — assistente de campanha

Ownership: `frontend/src/routes/_authenticated/campaigns/new.tsx` e seu teste. Aplicar cabeçalho, progresso de quatro passos e estrutura dos formulários ao padrão do protótipo; preservar toda a lógica de audiência, consentimento, agendamento e envio. Aceite: controles e dados intactos, sem campo/fluxo de demandas da GBR, testes do assistente e typecheck. Risco médio pela criticidade operacional, apesar de mudança apenas visual.

## Task 6 — superfícies restantes e novidade

Dividir em ownership disjunto para preservar foco e acelerar a validação:

- **Task 6A — acesso e campanhas**: `frontend/src/routes/login.tsx`, `frontend/src/routes/opt-in.tsx`, `frontend/src/routes/_authenticated/campaigns/index.tsx`, `frontend/src/release-notes.ts` e testes diretamente relacionados. Aplicar marca e superfícies; remover o filtro do logo que apaga o novo SVG; manter login, consentimento e ações da lista intactos. Registrar o rebrand nas novidades em PT-BR.
- **Task 6B — contatos, eventos e canal**: `frontend/src/routes/_authenticated/contacts.tsx`, `frontend/src/components/events-explorer.tsx`, `events-list.tsx`, `event-detail.tsx`, `frontend/src/features/whatsapp/components/instance-row.tsx` e testes diretamente relacionados. Trocar usos visuais dos antigos aliases roxo/ciano por papéis semânticos da nova paleta, incluindo o badge de canal em tema escuro; manter dados e ações.

Aceite de ambas: padrão visual coerente em claro/escuro e móvel, fluxos intactos, testes pertinentes, typecheck/build e report por subtask. Os dois grupos não editam tokens, shell, dashboard, inbox nem o assistente de campanha.

## Task 7 — integração e validação

A principal revisa os diffs, verifica aparência e responsividade em browser, executa `gate --changed --path frontend` por task quando aplicável e `gate --path frontend` no estado integrado, além de typecheck/build. Confirmar cobertura efetiva do gate e registrar gaps. Sem commit/push/deploy.

## Task 8 — suporte de cobertura ao gate existente

Ownership: `frontend/package.json` e `frontend/bun.lock`. O primeiro `gate --changed` revelou que o Vitest já configurado não tem o provedor `@vitest/coverage-v8`, portanto executou fallback sem cobertura. Adicionar apenas o provedor de cobertura na versão compatível com o Vitest 4.1.7 instalado, sem trocar runner, scripts ou outras dependências por iniciativa própria. Aceite: gate produz cobertura real, package/lock coerentes, teste focado e build/typecheck continuam passando. Registrar qualquer limite de cobertura do diff para correção pelos owners das páginas.

## Task 9 — contraste dos badges de provedor

Ownership: `frontend/src/features/whatsapp/provider-scope.tsx` e seu teste. Review independente encontrou rótulos de provedor Evolution/Zernio e estado de conexão verde/âmbar com baixo contraste sobre superfície clara; os pontos e bordas já distinguem os estados. Manter a cor semântica na marca visual, usar cor de texto legível em claro/escuro para os rótulos, preservar nomes, estados e ações. Aceite: teste focado de estilo/semântica, typecheck e QA de contraste; sem mudança de API ou de cores determinísticas dos números do inbox.

## Resultado local

Tasks 1–9 implementadas sem commit, push ou publicação. Gate do diff `PASS` (913/913 testes; 100% das linhas novas medidas); typecheck e build `PASS`; QA do build final cobriu desktop/móvel e claro/escuro. O gate completo `FAIL` corresponde ao passivo global já presente na base `5a37735` e foi comparado em checkout isolado: lint 127→126 erros, Sonar 74→69 achados, complexidade 317→311, cobertura total 76,0→76,5% e testes 1.402→1.417, todos passando. Evidências e decisão de aceite por baseline estão no ledger `.superpowers/sdd/2026-10-08-orgamind-visual-rebrand/progress.md`.
