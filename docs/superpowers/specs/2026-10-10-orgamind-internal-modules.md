# OrgaMind — módulos de comunicação entre setores

Data: 2026-10-10. Base Git: `f3ffcc5dd97d3415d2af69f40f0301854083d822`.
Pedido: mesmos módulos do protótipo; marca OrgaMind e empresa GBR Componentes.
Esta spec substitui a limitação visual da spec `2026-10-10-orgamind-prototype-alignment.md`. Reutiliza seu shell/tokens/Brand e ledger. Fonte: `/home/andre-lima/Downloads/OrgaMind-Prototipo.html`; mapa auditado em `.superpowers/sdd/2026-10-10-orgamind-prototype-alignment/prototype-functional-audit.md`.

## Resultado

Sidebar com Trabalho (Visão geral, Caixa de entrada, Nova comunicação), Acompanhar (Demandas, Comunicados) e Administração (Setores, Usuários, Números e canais). Dados persistidos, identidade real do usuário/setor, estados de carregamento/erro/vazio e permissões no servidor. As rotas externas existentes continuam acessíveis por links de integração; histórico, consentimento, provedores e campanhas existentes são preservados.

| Módulo | Rota | Entrega |
| --- | --- | --- |
| Visão geral | `/dashboard` | KPIs de demandas, prioridades e eventos recentes autorizados |
| Caixa de entrada | `/caixa-de-entrada` | Busca, filtros, leitura, detalhe inline e resposta à demanda correta |
| Nova comunicação | `/nova-comunicacao` | Wizard 3 etapas, demanda/comunicado, destinatários, revisão e sucesso real |
| Demandas | `/demandas`, `/demandas/$communicationId` | Lista/filtro, atribuição, situação e histórico/comentários |
| Comunicados | `/comunicados`, `/comunicados/$communicationId` | Lista, corpo publicado e leitura; multissetor |
| Setores | `/setores` | Lista, detalhe, cadastro/edição/inativação, gestor e vínculos reais |
| Usuários | `/users` | Reuso convite/senha temporária existente, setor, quatro papéis, acesso e permissões reais |
| Números e canais | `/connect` | Cadastro estrutural de número/setor, detalhes e acesso às integrações reais |

## Decisões de domínio

- Papéis canônicos: ADMIN (estrutura e todos os setores), SUPERVISOR e OPERATOR (comunicação do próprio setor), VIEWER (consulta autorizada e marcação de leitura). Os novos papéis não recebem implicitamente permissões de escrita dos endpoints legados. Uma consulta atual do usuário no bearer evita usar setor/papel antigos após alteração. Usuário removido/inativo não autentica/renova nem usa bearer antigo. `sessionVersion` default0 e claim compatível0 invalidam access após papel/setor/acesso/senha mudar; incrementar versão e revogar refresh, inclusive para não ressuscitar bearer após reativação.
- Usuário tem `sectorId` opcional para preservar bootstrap/dados existentes. Novo usuário interno não administrador exige setor ativo. ADMIN sem setor acompanha todos os setores e seleciona origem explicitamente; outros sem setor recebem orientação de configuração, sem acesso org-wide. Setor inativo mantém histórico, mas não é origem/destino de novos registros. Mudar setor não altera o público de registros históricos.
- Setor: nome 1–120, sigla uppercase 1–8, descrição opcional até 500, gestor opcional por ID, `isActive`, datas. Nome/sigla únicas normalizadas; gestor existente ativo. Não excluir setor com histórico. Reuso de administração de usuários conserva proteção do último administrador e impede auto desativação/demissão de papel.
- Comunicação unificada tem `kind` DEMAND ou ANNOUNCEMENT, assunto 1–160, mensagem 1–10000, autor, origem, destino principal e setores em ciência, timestamps e referência sequencial estável. Destinos sem duplicação, ativos, máximo 50. Demanda pode ter responsável ativo OPERATOR/SUPERVISOR/ADMIN do destino principal. Comunicado não admite responsável, prioridade nem prazo.
- Demanda: prioridade NORMAL/HIGH/URGENT; situação OPEN/IN_PROGRESS/WAITING/COMPLETED. Sem responsável é filtro de atribuição, separado da situação e do alerta de prazo. Atribuir uma OPEN inicia IN_PROGRESS. Remover responsável de uma em andamento retorna OPEN. Concluir/reabrir exige permissão do destino principal ou ADMIN e gera evento. Origem e ciência podem comentar/consultar, mas não alterar situação/atribuição.
- Prazo é data civil `YYYY-MM-DD`, opcional, como o formulário de referência; sem horário inventado. Fuso de apresentação/agregação America/Manaus. Próximo prazo = hoje/amanhã, vencido = anterior a hoje. Semana começa segunda-feira. Concluídas usa `completedAt` da situação atual. Prioridades ordenam prazo ascendente (sem prazo por último), prioridade desc e atualização desc.
- Históricos de criação/comentário/situação/atribuição têm autor real e data; mutations atualizam o registro e evento atomicamente. `version` inteiro em mutation de atribuição/situação garante conflito 409 em edição concorrente, sem sobrescrever silenciosamente. `clientRequestId` UUID único evita criação duplicada no retry do wizard; reuso só devolve registro ao mesmo autor e payload coerente. FKs de autor/assignee permitem remoção sem apagar histórico (SetNull + nome/setor do autor preservados no evento); nunca cascade comunicações por exclusão de usuário.
- Visibilidade: ADMIN ou autor/setor de origem/setor destinatário/ciência atuais do usuário. Origem enviada por usuário não ADMIN deve ser seu setor. Identificador adivinhado não atravessa a fronteira. Leitura é por usuário e comunicação; atualizado depois de `readAt` volta a não lido. Opções `notifyTeam`/`notifyAssignee` controlam badge de notificações internas; comunicação permanece na caixa dos destinatários independentemente dessas opções. Não enviar WhatsApp/e-mail automaticamente.
- Comunicados são publicados ao confirmar. Rascunho da imagem é fixture sem fluxo de salvar no protótipo e não vira dado de produção. Corpo legível e multissetor funcionam; seleção “todos” resolve IDs ativos na revisão. Nenhum dado demonstrativo será seed em produção.
- Número cadastrado é estrutura proposta, conforme copy do protótipo: nome, E.164 normalizado, provedor de cadastro META/EVOLUTION/OTHER, setor, intenção de roteamento e `channelId` opcional. Sem canal configurado, estado **A configurar**, roteamento **Pendente de configuração** e nenhum recebimento/envio real. Cadastro/vínculo não muda ACL, default, credenciais nem conexão dos Channels legados. Estado/configuração efetivos vêm das integrações existentes, com link para atendimento externo existente. Autorização declarada para número não amplia acesso a canal real; mostrar separadamente cadastro e acesso efetivo. A configuração de provedor continua usando os formulários existentes e sua verificação própria.

## Contratos HTTP

Novos recursos prefixo `/internal` (sem prefixo `/api` adicional do bootstrap):

- `GET/POST /internal/sectors`, `GET/PATCH /internal/sectors/:id`, `GET /internal/sectors/:id/members`. Escrita ADMIN; lista/eligible members para composição por papéis autenticados. Detalhe de vínculos administrativos ADMIN.
- `GET/POST /internal/numbers`, `GET/PATCH /internal/numbers/:id`: ADMIN, registro estrutural e metadados de conexão sanitizados, sem credenciais.
- `GET/POST /internal/communications`, `GET /internal/communications/:id`, `POST /internal/communications/:id/comments`, `PATCH /internal/communications/:id/demand`, `POST /internal/communications/:id/read`.
- `GET /internal/inbox`, `GET /internal/unread-count`, `GET /internal/dashboard`.
- Reusar `/users` CRUD/convites e `/auth` login/refresh com roles/setor/acesso ampliados de forma aditiva.

Lista interna: `{items,total,page,pageSize}`, page>=1, pageSize1–100 (default25), q opcional até160, filtros kind/status/unassigned/sectorId quando pertinentes. Servidor sempre adiciona escopo autorizado; ADMIN pode escolher setor, outros não expandem escopo por query. Criação `{kind,subject,message,originSectorId,destinationSectorId,ccSectorIds,assigneeId?,priority?,dueDate?,notifyTeam,notifyAssignee,clientRequestId}`. Retorno detalhe `{id,reference,kind,subject,message,originSector,destinationSector,ccSectors,author,assignee,priority,dueDate,status,version,notifyTeam,notifyAssignee,createdAt,updatedAt,completedAt,isUnread,events}`. Datas de instantes ISO; dueDate data civil. Eventos `{id,kind,message,author,createdAt}`. Leitura retorna detalhe atualizado; mutation retorna detalhe; sem password/tokens.

Setor resumo `{id,name,code,description,isActive,managerId,manager,memberCount,numberCount,createdAt,updatedAt}`; manager nullable `{id,name,email}`. Detalhe acrescenta `members` e `numbers` sanitizados. `GET sectors` permite `activeOnly=true`, lista paginada padrão. Members elegíveis retorna `{items}` com `{id,name,email,role,sectorId,isActive}`, exclui leitura/inativo quando `eligible=true`. POST/PATCH setor payload `{name,code,description?,managerId?,isActive}` (PATCH parcial). Auth/userSummary acrescentam `sectorId`, `sector:{id,name,code,isActive}|null`, `isActive`, sem alterar shape principal legado data/page. Frontend aceita defaultnull/true para payloads antigos.

Número resumo `{id,name,phone,provider,sectorId,sector:{id,name,code,isActive},routeToSector,channelId,configurationStatus,createdAt,updatedAt}`; configurationStatus `UNCONFIGURED` ou `CONFIGURED`, não equivale a conectado. Detalhe tem canal real sanitizado `{id,name,provider,isActive,ownerUserId}|null` e `routingStatus:PENDING` enquanto só cadastro. POST/PATCH `{name,phone,provider,sectorId,routeToSector,channelId?}`; não receber tokens do provedor neste endpoint. Lista paginada padrão. O acesso efetivo a atendimento continua nas permissões do canal real; cadastro de usuário aponta para essa configuração sem prometer um grant automático.

Dashboard `{needsAction,nearDeadline,waitingOthers,unassigned,completedThisWeek,priorities,recentUpdates,sector}`. `needsAction` = demandas abertas dirigidas ao setor (ADMIN sem setor todas), `waitingOthers` = demandas originadas no setor destinadas a outro e ainda abertas; sem responsável no escopo de ação; completedThisWeek no escopo autorizado. Feed contém somente eventos de comunicações visíveis, limitado 8. Prioridades limitado 5. Badge unread conta demandas/comunicados notificáveis destinatários ainda atualizados depois da última leitura; ADMIN sem setor badge global de visíveis notificáveis.

## BDDs de aceite

1. ADMIN cria dois setores e usuário do destino; refresh preserva vínculos e siglas normalizadas. Inativar destino retira-o do wizard sem apagar histórico.
2. Operador do setor A registra demanda para B em 3 etapas; B vê a mesma referência/ID, C não vê nem abre por ID; refresh mantém corpo/estado.
3. Responsável de outro setor/VIEWER/inativo é rejeitado. OPERATOR origem não pode falsificar origem nem concluir demanda do destino.
4. B assume/atribui, comenta e conclui; caixa/lista/KPIs/histórico convergem. Versão antiga rejeita alteração 409. Repetir create UUID devolve o mesmo registro sem evento duplicado.
5. Comunicado para B+C aparece apenas aos setores envolvidos, corpo persiste sem campos de tarefa. VIEWER pode ler, não publicar/comentar/atribuir/concluir.
6. Marcar leitura reduz badge; atualização posterior retorna não lido. Flags de notificação não removem a comunicação da caixa autorizada.
7. Alterar papel/setor/inativar usuário afeta bearer existente; proteger último ADMIN contra concorrência. Convite/senha temporária/forced password change existentes permanecem.
8. Número cadastrado sem integração permanece A configurar/Pendente, telefone/setor persistem e nenhum acesso externo é concedido por vínculo. Estado conectado nunca é fabricado.
9. Navegação exibe os 8 módulos e grupos do protótipo, permissão administrativa aplicada; branding GBR/OrgaMind, desktop/mobile/dark utilizáveis, erro remoto não mostra sucesso falso.

## Validação e riscos

Migração aditiva aplicada em banco isolado; unit/HTTP/Postgres reais para escopo, atomicidade, concorrência e persistência. Revisão independente de auth/contratos. QA browser local com backend real e dados fictícios isolados. Gatechanged das tasks e integrado; gate completo final por stack com baseline anterior classificado. Baseline frontend /tmp/gate-5iw94wrl (1452/1452, passivo lint/complexidade), backend /tmp/gate-tf_xhib3 (4206/4241,35 opt-in, passivo lint/complexidade/Sonar e cobertura indisponível por remap V8). Cobertura obrigatória do delta precisa ser recuperada, não aceitar SKIP como PASS. Nada de reset/migração destrutiva em produção; secrets/salts/volumes preservados. Sem publicar fixtures de QA.
