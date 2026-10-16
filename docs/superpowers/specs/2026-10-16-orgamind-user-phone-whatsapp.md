# OrgaMind — telefone no cadastro de usuário e WhatsApp para a equipe

Data: 2026-10-16. Base Git: `dce9ef9805097a1c66648a4813019b5b8bf5ffcb` (origin/main, mesma revisão implantada no GBR). Substitui `2026-10-15-orgamind-whatsapp-menu.md`, que entendeu errado o pedido (PR #3 fechado sem merge). Mapas de código em `.superpowers/sdd/2026-10-16-orgamind-user-phone-whatsapp/maps/`.

## Pedido

Cliente GBR, áudios de 2026-10-15 e 2026-10-16: falta o telefone da pessoa "pra poder enviar a mensagem"; "seria nesse convidar o usuário… cadastrar lá o usuário e o telefone… acho que até tem que trocar esse nome de convidar pra cadastrar". Decisões do usuário (2026-10-16):

- O usuário vira contato: "os usuários são contato que irão ter um setor e posso mandar mensagem para esse setor ou um usuário específico".
- Telefone obrigatório no cadastro de usuário novo.
- Envio em texto livre, sem template ("Enviar WhatsApp"), para um usuário ou para um setor.
- As respostas ficam no WhatsApp do número conectado. Não há tela nova de conversa.
- Enviam: ADMIN, para qualquer usuário ou setor, e o gestor do setor, para o próprio setor e seus membros.

## Situação atual (fatos que guiam o desenho)

- `User` não tem telefone nem ligação com `Contact`. `Contact.phoneE164` é único, e conflitos entre variantes do 9º dígito são tratados por `findByAnyBrForm`.
- O envio de texto livre existe só como resposta do Inbox (`ChatService.sendReply`), sobre uma conversa que já existe. `dispatchOutbound` é privado. `resolveConversationForOutbound` já cria a conversa quando ela não existe. Nesse caminho não há checagem de consentimento nem de supressão.
- GoZap e Evolution são provedores não oficiais e aceitam texto livre sem janela. Meta é oficial: fora da janela de 24 h exige template. Twilio e Zernio têm janela de sessão.
- O pacing de canal de sessão existe em `campaigns/pacing.helper.ts` (`acquirePacingLock`/`releasePacingLock`, com jitter de 10 a 45 s).
- "Gestor do setor" é `Sector.managerId`: um usuário ativo ADMIN, SUPERVISOR ou OPERATOR. Não existe helper de permissão para gestor.
- O `RolesGuard` global só abre rota para SUPERVISOR quando há `@Roles` explícito. `/whatsapp/instances` e `/users` não aceitam o gestor não-ADMIN.
- Todo deploy roda `prisma migrate deploy` e depois `prisma/merge-duplicate-phone-contacts.ts --apply` (`docker-compose.prod.yml:103`). Esse script funde contatos com telefone duplicado.

## Resultado

### 1. Cadastrar usuário com telefone

- "Convidar usuário" passa a ser **"Cadastrar usuário"**: botão da página, título do diálogo e botão "Cadastrar"/"Cadastrando...". O fluxo de senha temporária não muda.
- Campo **Telefone (WhatsApp)** obrigatório no cadastro. Aceita número brasileiro com DDD, com ou sem +55, e é normalizado para E.164 com `normalizeToE164` (BR). Número inválido devolve 400 `user.invalid_phone`. Número já usado por outro usuário, em qualquer variante do 9º dígito, devolve 409 `user.phone_taken`.
- Ao salvar, o usuário fica ligado a um contato. Se já existe contato com esse número (em qualquer variante BR), o usuário passa a apontar para ele; o nome do contato só é preenchido quando estiver vazio. Se não existe, o contato é criado pelo caminho normal de contatos (`ContactsService.create`: auditoria, reidratação de consentimento, ligação de conversas). Nome do contato = nome do usuário, ou o e-mail se não houver nome.
- Edição de usuário: o campo Telefone aparece preenchido.
  - Para quem já tem telefone ele é obrigatório: dá para trocar o número, não para apagar.
  - Usuário antigo sem telefone pode continuar sem ou ganhar um.
  - Trocar o número religa o usuário ao contato do novo número. O contato antigo continua existindo, com seu histórico.
- A lista de usuários ganha a coluna **Telefone**, com o número formatado ou "—".
- Persistência: `User.phoneE164 String? @unique` e `User.contactId String? @unique`, com FK para Contact `onDelete: SetNull`. A migração só adiciona colunas, índices e a FK. Usuários existentes ficam com `null`.
- O script de deploy `merge-duplicate-phone-contacts.ts` precisa reapontar `User.contactId` para o contato sobrevivente quando fundir contatos. Sem isso o usuário perde a ligação a cada deploy.

### 2. Enviar WhatsApp para a equipe

- **Quem pode** (decidido no backend; o frontend só esconde o que o backend recusaria):
  - ADMIN ativo: qualquer usuário ativo e qualquer setor ativo.
  - Gestor (usuário ativo que é `managerId` de um ou mais setores ativos): esses setores, e usuários ativos cujo `sectorId` é um desses setores.
  - Os demais recebem 403 `team_whatsapp.forbidden`. VIEWER não chega nem à rota (`@Roles('ADMIN','SUPERVISOR','OPERATOR')`).
- **Destinatários:**
  - Pessoa: o usuário-alvo.
  - Setor: os membros ativos do setor (`User.sectorId`) com telefone.
  - O remetente é incluído se for membro.
  - Usuário sem telefone ou ligado a um telefone em supressão (pediu SAIR) é **pulado** e aparece no resumo com o motivo: `NO_PHONE` ou `SUPPRESSED`.
  - Alvo sem nenhum destinatário válido devolve 422 `team_whatsapp.no_recipients`, e nada é criado. Isso vale para setor vazio e também para pessoa sem telefone ou em supressão; a tela já desabilita o botão nesses casos.
- **Canal:** o remetente escolhe entre os canais ativos de provedor não oficial (GOZAP ou EVOLUTION). Com um só canal, ele vem pré-selecionado. Se o último estado de conexão conhecido do canal for `close`, o envio devolve 409 `team_whatsapp.channel_disconnected`. Canal inexistente, inativo ou de outro provedor devolve 422 `team_whatsapp.channel_invalid`.
- **Texto:** livre, 1 a 2000 caracteres, sem formatação de template e sem variáveis.
- **Envio assíncrono:** o POST registra o envio (`TeamWhatsappDispatch`) e um destinatário por pessoa (`TeamWhatsappRecipient`, status `QUEUED`/`SENT`/`FAILED`/`SKIPPED`). Ele enfileira um job por destinatário numa fila BullMQ própria e responde 202 com `{ dispatchId, queued, skipped: [{ userId, name, reason }] }`. Para cada job, o processor:
  1. confere de novo a supressão; se o telefone estiver suprimido, marca `SKIPPED/SUPPRESSED`;
  2. em canal de sessão, aguarda o pacing do canal (mesmos helpers da campanha);
  3. envia por um método público novo do `ChatService`. Esse método resolve ou cria a conversa (contato, canal), grava a mensagem de saída com `authorUserId` do remetente, pausa o bot da conversa como na resposta humana, envia e publica os eventos de mensagem e conversa;
  4. marca `SENT` com o `messageId`, ou `FAILED` com o código do erro. Erro do provedor tem retentativa da fila; a falha final fica `FAILED`.
- **Histórico:** `GET` dos envios recentes, os 20 mais novos, com contagem por status. ADMIN vê todos; o gestor vê os próprios.
- **Auditoria:** `team_whatsapp.dispatch` com ator, alvo (tipo e id), canal e contagens. O texto da mensagem e os telefones não vão para logs nem para a auditoria.
- **Consentimento:** é recado interno de equipe, então não passa pelo filtro de consentimento de marketing, igual à resposta do Inbox. A lista de supressão é respeitada sempre.
- As respostas chegam como inbound normal na conversa do contato, visíveis no WhatsApp do número conectado. Nenhuma tela nova de conversa.

### 3. Telas

- **Página "WhatsApp da equipe"** (`/whatsapp-equipe`), no menu para ADMIN, SUPERVISOR e OPERATOR.
  - Mostra os setores que o usuário pode alcançar e os membros de cada um, com nome, telefone ou "sem telefone", e ativo.
  - Ações: "Enviar ao setor" e, por pessoa, "Enviar".
  - Abaixo, os envios recentes.
  - Quem não é ADMIN nem gestor vê o estado vazio: "Só o administrador e o gestor do setor enviam mensagens para a equipe."
  - Os dados vêm de um endpoint próprio (`GET /internal/team-whatsapp/targets`), que já traz os canais elegíveis, porque o gestor não-ADMIN não acessa `/whatsapp/instances` nem `/users`.
- **Diálogo "Enviar WhatsApp"** (reutilizado): mostra o destino (pessoa ou setor e quantos receberão), o seletor de canal, o texto com contador e o botão "Enviar". No sucesso, um toast "Mensagem enfileirada para N pessoa(s)", mais a lista de quem foi pulado e por quê. Erros 403/409/422 viram mensagens em PT-BR.
- **Usuários (ADMIN):** item **"Enviar WhatsApp"** no menu "Ações" da linha. Fica desabilitado, com dica, para usuário sem telefone ou inativo.
- **Novidades:** entrada nova no topo de `RELEASE_NOTES` (regra de `frontend/CLAUDE.md`) com `where: '/whatsapp-equipe'`.
- **Correção salva do PR #3:** o diálogo de Novidades só mostra "Ver" quando o papel logado acessa a rota de `where`. A decisão usa o manifesto `NAV`, pelo prefixo mais longo (`canAccessPath(path, role?)` em `lib/nav.ts`). Rota fora do `NAV`, ou usuário sem papel, fica sem "Ver". Origem: commits `13d18e4` e a parte `canAccessPath` de `a1c024e`, sem a seção WhatsApp do sidebar nem a novidade de 2026-10-15.

## Contratos

- `POST /users`: `phone` passa a ser obrigatório. `PATCH /users/:id`: `phone` opcional, sem `null`. `GET /users`: cada item ganha `phoneE164: string | null`. Contrato `backend/src/schemas/contracts/user.schema.ts` e schema do frontend atualizados juntos.
- Rotas novas, todas com `@Roles('ADMIN','SUPERVISOR','OPERATOR')` e a política do item 2:
  - `GET /internal/team-whatsapp/targets` → `{ channels: [{ id, name, phoneE164, provider }], sectors: [{ id, name, code, members: [{ id, name, email, phoneE164, isActive }] }] }`;
  - `POST /internal/team-whatsapp/dispatches` com `{ channelId, text, target: { type: 'user', userId } | { type: 'sector', sectorId } }` → 202;
  - `GET /internal/team-whatsapp/dispatches` → `{ items: [{ id, createdAt, author: { id, name, email }, target: { type, id, label }, channel: { id, name }, counts: { queued, sent, failed, skipped } }] }`.
- Fila nova em `QUEUE_NAMES`, com retentativa limitada e backoff exponencial, e job `{ recipientId }`. Não muda a fila de campanha nem o `SendMessageProcessor`.
- Fora o caminho de envio da equipe, nada muda em campanha, consentimento, Inbox, webhooks ou contatos. O `ChatService.sendReply` mantém o comportamento.

## Fora do escopo

Tela de conversa ou histórico dentro do usuário; voltar Inbox, Contatos ou Campanhas ao menu; envio por provedor oficial (Meta, Twilio, Zernio); agendamento; mídia ou anexo; aviso automático por WhatsApp em comunicados e demandas; telefone obrigatório retroativo para usuários existentes; login por telefone.

## Riscos a cobrir (Review Focus)

1. Variante do 9º dígito: `+55 92 9xxxx-xxxx` e `+55 92 xxxx-xxxx` são o mesmo número. Cadastro, conflito e ligação ao contato precisam tratá-los como iguais.
2. Contato preexistente (importado ou de campanha) com o mesmo número: o sistema liga a ele, não duplica, e não sobrescreve o nome nem o consentimento.
3. Fusão de contatos no deploy (`merge-duplicate-phone-contacts.ts`) com usuário ligado ao contato descartado: a ligação vai para o sobrevivente.
4. Gestor tentando enviar a setor que não gerencia, ou a usuário de outro setor, por chamada direta à API: recebe 403. Gestor desativado, ou setor desativado depois de carregar a tela: o envio é recusado.
5. Telefone em supressão (SAIR) depois de enfileirar: o processor pula. Canal desconectado ou erro do provedor: o destinatário fica `FAILED`, sem travar os outros e sem envio duplicado na retentativa (o job confere o status antes de enviar).

## Aceite

1. ADMIN cadastra usuário com telefone, que é obrigatório e validado; o diálogo e o botão dizem "Cadastrar". O usuário aparece na lista com o telefone e fica ligado ao contato, novo ou existente. Erros `user.invalid_phone` e `user.phone_taken` aparecem no campo.
2. A edição troca o telefone, não deixa apagar o de quem tem, e deixa usuário antigo sem telefone continuar sem.
3. ADMIN envia WhatsApp a um usuário e a um setor; o gestor, ao próprio setor e a seus membros. Chamadas fora da política recebem 403. O resumo informa enfileirados e pulados com motivo. O processor envia pelo canal escolhido, respeita supressão e pacing e marca `SENT`/`FAILED`. A mensagem fica na conversa do contato.
4. A página "WhatsApp da equipe" lista os alvos permitidos e os envios recentes, e o estado vazio aparece para quem não é ADMIN nem gestor. O item "Enviar WhatsApp" de Usuários fica desabilitado sem telefone. A novidade é publicada no topo.
5. "Ver" das Novidades respeita o papel: VIEWER não vê para `/contacts` e vê para `/dashboard`; ADMIN vê para `/contacts` e `/setores`; OPERATOR não vê para `/setores`.
6. `gate --changed` verde por task (frontend e backend); gate completo por pacote, sem regressão sobre a baseline de `dce9ef9`; CI do PR verde, incluindo e2e, migration-drift e backend-tests; revisão independente por task, em opus nas tasks críticas.
