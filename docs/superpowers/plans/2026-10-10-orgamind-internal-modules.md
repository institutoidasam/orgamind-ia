# Plano SDD — módulos internos OrgaMind

Spec: `docs/superpowers/specs/2026-10-10-orgamind-internal-modules.md`. Ledger reutilizado: `.superpowers/sdd/2026-10-10-orgamind-prototype-alignment/progress.md`. Base f3ffcc5; dirty anterior de Brand/shell/LiveFlow preservado. Implementação pelo pedido explícito do usuário; documentos locais não são publicação.

## F1 — fundação de domínio, auth e setores

Implementador ownership **somente backend**: Prisma schema/migração aditiva TODOS os modelos/enums internos, módulos auth/users e seus contratos/tests necessários, novo modules/internal-sectors, schema sectors; app.module wiring interno (serializado, avisar F2). Schema comunicar cedo a F2: Sector, User.sectorId/isActive, Role SUPERVISOR/VIEWER; InternalCommunication/Recipient/Event/Read e SectorNumber. Auth atual por consulta User e cerca global dos novos papéis em RolesGuard. Setores CRUD/detail/members e convites existentes com setor/papéis; último admin/inativação. Não frontend/numbers/communications implementation. TDD focado, typecheck noEmit sem distroot, migration validate, gatechanged. Risco alto identidade; revisão independente.

## F2 — comunicação interna persistente

Implementador ownership modules/internal-communications e schemas correspondentes, dashboard/inbox/read/notificação/count/helpers/tests. Consome schema F1; não editar Prisma/auth/app.module (pedir wiring ao owner). Wizardcreate, idempotência, validação/matriz, comentário/status/assignee/eventos/version transacional, listas/dashboard autorizados. Testes de Postgres/HTTP em banco/container exclusivo; seguir orçamento. F1 permite módulos definidos compilar quando criados. Contrato HTTP exato spec; reportar divergência antes de alterar contrato.

## F3 — frontend administrativo e identidade

Implementador ownership features/internal-admin (schemas/api/sectors/numbers components), routes/_authenticated/setores e features/users + route users; frontend auth schemas/store role/setor; adaptações estritamente tipadas de mapas role em outros arquivos se necessário avisando shell owner. CRUDsetores, convite/edição/setor/papéis/acesso e numberregistryUI persistentes. Numbers backend novo modules/internal-numbers/schema (fase após F1 schema e authestáveis, sem app.modulealterar). Route connect pode ser composição com integração existente e novo registry, preserva providerforms. Nenhumnav/dashboard/operationalcommunicationsUI. Testes BDD focados; gatechanged sem suites paralelas na mesma stack; revisãoauthfrontend.

## F4 — frontend de comunicação e dashboard

Implementador ownership features/internal-communications (schema/api/hooks/sharedvisuals/wizard/demand/inbox/notices/dashboard), novos routes caixadeentrada/novacomunicacao/demandas/comunicados, dashboardroute. NÃO UIadmin/auth/shell. Reusar Brand/tokens/components; preservar módulo externo inbox e APIs legado. F1/F2 contracts estabilizados; testes TDD e estados erro/vazio/conflito/readonly; QA backendreal integrada. Criar arquivos granulares sem função>50linhas ou complexidade>10 novas.

## F5 — navegação, integração visual e release note

Retomar shellowner para nav8módulos/grupos, badge interno, perfil/sectorroles e controlesglobais compatíveis com papéis novos; commandpalette/desktops/drawer. Corrigir gates regressivos brand/Sonar diretiva faltante por owner. Release PTBR2026.10.10 no topo, grafia OrgaMind e rotas reais. Frontend routeTree geração central ou somente Vite/plugin, não editar simultaneamente.

## F6 — cobertura, revisão e fechamento

Task delimitada de diagnóstico cobertura V8 backend (config/provider já existentes; não adicionar runner) após schema. Revisor independente read-only auth/ACL/atomicidade/diffintegral. Principal integra, gatechanged e fullgate no estadofinal, typecheck/build frescos, migraçõesisoladas e QAreal navegador desktop/mobile. Cada processo foreground timeout600s e logs/exits coletados. Não absorver novas regressões no baseline. Registrar arquivos/testes/riscos/gaps e referência final; publicar somente com autorização vigente aplicável e aceite concreto. Não trocar secrets/env/salts/dados de GBR/Picoa.

## Ordem e paralelismo

F1 publica schema/contratos cedo, F2 em paralelo após schema, F3 frontendadmin apóscontratos. F4 no próximo slot, F5 com frontendcontratos prontos. F6 review/gates após owners estabilizados. 3subagentes+principal, ownership disjunto; app.module/Prisma/routeTree/machineDB/tests serializados. Suites da mesma stack agendadas pelo controlador; testes focados leves podem em slotsdisjuntos com Testslot. Tudo em checkout compartilhado preservado, sem commits dos agentes.
