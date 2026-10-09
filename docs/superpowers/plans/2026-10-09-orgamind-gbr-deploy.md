# Plano — OrgaMind GBR

Spec: `docs/superpowers/specs/2026-10-09-orgamind-gbr-deploy.md`.
Ledger: `.superpowers/sdd/2026-10-09-orgamind-gbr-deploy/progress.md`.

## Task 1 — credencial e servidor

Principal: mover arquivo para `~/.claude/secrets/dokploy-picoa.env`, verificar auth/DNS e inspecionar apenas metadados de configuração/capacidade. Credencial movida; API autenticada, DNS existente, nenhum target OrgaMind. Novo projeto explicitamente autorizado.

## Task 2 — contexto de build

Ownership subagente: `backend/.dockerignore`, novo `frontend/.dockerignore`. Excluir envs/segredos/node_modules/dist/coverage/logs/backups sem excluir fontes/lockfiles necessários. Aceite: diff-check e verificação de contexto; principal valida builds Docker. Risco médio por publicação involuntária de material local.

## Task 3 — ambiente novo

Ownership subagente: somente novo arquivo `~/.claude/secrets/orgamind-gbr.env` e relatório próprio. Gerar valores aleatórios estáveis uma vez, com modo600; URLs públicas gbr, PostgreSQL novo, provider Evolution interno completo, seed admin do domínio, Bull Board com senha nova. Optional providers vazios/ausentes. Aceite: Compose config e envSchema/preflight coerentes sem imprimir valores. Não reutilizar credenciais de outro app.

## Task 4 — publicação

Principal: revisar diff dos tasks, validar build/gates conforme risco, commit dos arquivos autorizados e publicar revisão na principal remota sem incluir `main` local independente. Confirmar source access do Dokploy ao repo. Não forçar push nem alterar refs de outras tarefas.

## Task 5 — novo projeto e deploy

Principal opera APIs: criar projeto OrgaMind GBR, ambiente production e compose próprio; configurar source repo/main, env privado, domínio web80/HTTPS/Let's Encrypt e deploy. IDs persistentes permitem retomar sem duplicar. Inspecionar status/logs filtrados, sem segredos. Não modificar Picoa ou Dify.

## Task 6 — aceite público

Principal: readiness via proxy, TLS, página de login, login API inicial com mustChangePassword, inspeção de serviços e erros. Preservar credenciais apenas no arquivo protegido. Reportar domínio/revisão/resultados e pendências reais. Sem enviar campanhas ou conectar contas WhatsApp.
