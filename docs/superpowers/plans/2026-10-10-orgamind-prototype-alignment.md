# Plano — OrgaMind refinamento do protótipo

Spec: docs/superpowers/specs/2026-10-10-orgamind-prototype-alignment.md.
Base: f3ffcc5; ledger .superpowers/sdd/2026-10-10-orgamind-prototype-alignment/progress.md.

## Task 1 — marca, tokens e acesso

Implementador ownership frontend/index.html, public/favicon.svg, src/assets/logo.svg, src/lib/brand.ts (novo), src/components/brand.tsx (novo), src/styles/tokens.css, src/index.css, src/components/ui/button-variants.ts e teste se necessário, src/routes/login.tsx/change-password.tsx e specs diretamente ligados. Brand export nomeado `Brand` props compact?:boolean, subtitle?:string, inverse?:boolean, className?:string; libbrand PRODUCT_NAME=OrgaMind, WORKSPACE_NAME=GBR Componentes, WORKSPACE_SHORT_NAME=GBR. Criar componente/constantes cedo e avisar Task2. Sem editar shell/dashboard/nav/outroscomponentes/copy. Aceite: identidade em desktop/móvel, favicon/locale, tokens/controles consistentes, auth/redirect íntegros, tests/gate do delta. Risco médio de UI transversal e auth (só apresentação).

## Task 2 — shell e navegação

Implementador ownership src/components/layout/app-shell/sidebar/topbar/footer/release-notes-dialog(.spec).tsx, src/lib/nav.ts/.spec.ts, src/routes/_authenticated/route.tsx e tests correspondentes, command-palette.tsx/.spec se nomes/groupos explícitos demandarem. Consumir Brand/libbrand da Task1; organização visual fixa GBR preferida pelo usuário. Grupos Trabalho/Acompanhar/Administração conforme função real, preservar permissões de cada rota (render por role, não criar bloqueio por mover seção). Visão geral/Caixa de entrada/Nova campanha e Números e canais; breadcrumb/nome do perfil/tamanhos/drawer/colapso. Preservar5controles status/provider/search/tema/novidades. Aceite tests ADMIN/OPERATOR/novolink/active (prefixo campanha nova maisespecífico), desktop/móvel/dark, gate. Risco médio com revisão independente necessária.

## Task 3 — dashboard

Implementador ownership src/components/dashboard-sections.tsx, kpi-hero.tsx, live-flow.tsx e specs; src/features/dashboard/components/dashboard-page.tsx e src/routes/_authenticated/dashboard.spec.tsx. Headline Visão geral, grade/lista compacta real; preservar API/dados/status/percs e loading/error/retry. Fluxo legível com contadores reais sem partículas decorativas. Sem fonte falsa de atualizações/demandas ou backend. Aceite BDDs de dados/vazio/erro, typecheck/gate e QA real do build. Executar quando houver slot (Task1/2 ownership paralelo disjunto).

## Task 4 — grafia e novidade

Mecânico ownership src/release-notes.ts e specs, apenas literal user-visible em configuracoes.tsx, create-channel-form.tsx, remove-gozap-channel-dialog.tsx, bulk-grant-dialog.tsx, purposes-admin.tsx, consent-buttons-dialog.tsx, template-form-dialog.tsx. Novo release2026.10.10 no topo, PT-BR para operador. Correções OrgaMind em textos, sem modificar IDs/API/storage/copy legal persistida. Aceite buscas dirigidas/diff-check/tests existentes pertinentes; gate. Sem reformatar arquivos grandes.

## Task 5 — integração e publicação autorizada

Principal: acompanhar testes até exit, conferir diffs/review por snapshot/risco, gatechanged integrado e gate completo final comparado ao baseline, typecheck/build; QA desktop/móvel/dark com fixture isolada. Resolver novos achados/gaps. Reusar autorização anterior de mostrar/subir/merge e deploy GBR para esta correção do rebrand. Publicar somente resultado aceito, fast-forward mainremota sem tocar mainlocal independente e redeploy sem trocar salts/env/dados. Validar HTTPS/readiness/frontend e reportar dívida global remanescente; nenhuma conexão/envio real em QA.
