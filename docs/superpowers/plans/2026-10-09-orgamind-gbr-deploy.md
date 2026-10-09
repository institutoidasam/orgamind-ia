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

## Follow-up de aceite — probe e logs de erro

Boot real encontrou worker unhealthy por herança do probe da API e credencial Evolution em erro Axios serializado. Worker novo parado durante a correção.

- Task7 ownership docker-compose.prod.yml: override healthcheck worker em porta3001/ready, confirmação de Compose sem segredos; não alterar outros serviços.
- Task8 ownership logging compartilhado/app.module/worker.module e specs: erro HTTP seguro nas duas configurações, Pino real com fixtures fictícias provando ausência de headers/rawrequest/payload/query/cause com credenciais. Preservar diagnóstico útil e redaction HTTP existente. Gate do delta e revisão independente obrigatórios.
- Task9 ownership somente env privado GBR: renovar EVOLUTION_API_KEY comprometida em logs internos, preservar salt/banco/admin e demais valores; salvar novo env, publicar fixes, redeploy sem apagar volumes. Chave global é usada pelo adapter; a instância Evolution ainda não foi provisionada.
- Aceite final: migrate exit0, API/web/postgres/redis/worker saudáveis, Evolution rodando; TLS/readiness/login200; logs posteriores não contêm chave nova ou anterior. Dívida global do gate legado permanece backlog identificado.
