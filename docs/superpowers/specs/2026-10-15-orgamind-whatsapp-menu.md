# OrgaMind — seção WhatsApp no menu

Data: 2026-10-15. Base Git: `dce9ef9805097a1c66648a4813019b5b8bf5ffcb` (origin/main, mesma revisão implantada no GBR). Complementa `2026-10-10-orgamind-internal-modules.md`, que tirou do menu as telas de campanha.

## Pedido

Áudio do cliente GBR (2026-10-15, transcrito com Whisper turbo): "O Julinho tá tentando fazer os testes aqui agora, mas o que ficou faltando é o número de telefone da pessoa, igual como tá na versão antiga, pra poder enviar a mensagem. Hoje no cadastro não dá pra colocar o número." O usuário confirmou a leitura "que nem era o antigo": cadastrar a pessoa como contato com telefone e mandar WhatsApp, como no deploy GBR de 2026-10-09 (`f3ffcc5`).

## Causa

As telas de contato, inbox e campanha continuam idênticas a `f3ffcc5` (`git diff f3ffcc5 HEAD` vazio nelas), mas desde 2026-10-10 têm `hideInSidebar: true` em `frontend/src/lib/nav.ts`. O único cadastro de pessoa visível no menu é Usuários (e-mail, nome, acesso), que não tem telefone por desenho do protótipo. O GoZap foi ligado no GBR em 2026-10-15, então o canal de envio existe.

## Resultado

Nova seção **WhatsApp** no menu, entre "Acompanhar" e "Administração", na ordem do menu antigo:

| Item | Rota | Por que volta |
| --- | --- | --- |
| Inbox externo | `/inbox` | Recebe a resposta da pessoa e continua a conversa |
| Contatos | `/contacts` | Cadastro da pessoa com telefone (o pedido) |
| Templates | `/templates` | Campanha exige `templateId`; o assistente não tem atalho para criar template |
| Segmentos | `/segments` | Mesmo fluxo da versão antiga; reaproveita público (opcional, filtros do assistente bastam) |
| Campanhas | `/campaigns` | Único jeito de originar a primeira mensagem; o Inbox não inicia conversa |

Continuam fora do menu, alcançáveis por URL e paleta: `/imports` (Contatos já tem os botões de importar), `/consentimento` e `/opt-in-links` (já escondidos na versão antiga, `HIDDEN_FROM_SIDEBAR`), `/configuracoes` (identidade do texto de consentimento, fora do fluxo de envio).

## Contratos

- Só frontend: manifesto `NAV`, tipo `NavSection` e renderização do sidebar. Rotas, breadcrumbs (`navLabelFor`) e paleta de comandos continuam derivando de `NAV` sem mudança de rótulo.
- Papéis inalterados: a seção usa `LEGACY_ROLES` (ADMIN, OPERATOR), igual ao `RolesGuard` legado (`backend/src/modules/auth/roles.guard.ts:9`). SUPERVISOR e VIEWER não veem a seção nem recebem atalho para 403; a seção não renderiza quando vazia, como "Administração".
- Sem mudança de backend, permissão, consentimento ou envio. As oito entradas internas e suas seções ficam como estão.
- Entrada nova no topo de `RELEASE_NOTES` (regra de `frontend/CLAUDE.md`), em PT-BR para o operador, com `where: '/contacts'`.

## Novidades: link "Ver" só para quem acessa a rota

Achado na verificação pré-deploy (2026-10-15): `release-notes-dialog.tsx` mostra "Ver" para todo papel, e o frontend não bloqueia rota por papel (`_authenticated/route.tsx` só checa sessão). SUPERVISOR/VIEWER abrem `/contacts`, `/campaigns`, `/setores` etc. e caem em telas cujo backend responde 403 — ~25 links desde 2026-10-10, mais o da entrada nova. Contrato: o diálogo mostra "Ver" apenas quando o papel do usuário logado acessa a rota de `where`, decidido pelo manifesto `NAV` (casamento pelo prefixo mais longo, como `navLabelFor`; `/campaigns/new` herda de `/campaigns`). Rota fora do `NAV` ou usuário sem papel: sem "Ver". O texto do item continua visível a todos.

## Comportamento existente que o cliente precisa saber (não muda)

1. Só ADMIN cria template e campanha (`@Roles('ADMIN')` em `templates.controller.ts` e `campaigns.controller.ts`). OPERATOR cadastra contato e responde no Inbox.
2. Contato criado à mão nasce sem consentimento. No primeiro envio, a campanha precisa de override com justificativa (≥ 10 caracteres), permitido porque GoZap não é provedor oficial (`campaign-consent-gate.ts`); sem isso a mensagem fica `SKIPPED_NO_CONSENT`.

## Fora do escopo

Acesso legado para SUPERVISOR/VIEWER; "iniciar conversa" no Inbox; telefone no cadastro de Usuários; registrar consentimento no cadastro manual; religar Imports/opt-in/Configurações no menu.

## Aceite

1. ADMIN e OPERATOR veem "WhatsApp" com exatamente Inbox externo, Contatos, Templates, Segmentos, Campanhas, nessa ordem; os três grupos internos mantêm exatamente os mesmos itens.
2. SUPERVISOR e VIEWER não veem a seção nem qualquer rota legada no sidebar.
3. `/imports`, `/consentimento`, `/opt-in-links` e `/configuracoes` não aparecem em nenhuma seção do sidebar e continuam no manifesto com breadcrumb resolvido.
4. Novidade publicada no topo, ordem decrescente preservada. No diálogo, VIEWER não vê "Ver" para `/contacts` e vê para `/dashboard`; ADMIN vê para `/contacts` e `/setores`; OPERATOR não vê para `/setores`.
5. `gate --changed` do frontend verde; e2e afetado (`e2e/import-and-contacts.spec.ts`) chega a Contatos pelo menu e é executado — ambiente e2e indisponível é lacuna registrada, não aceite; revisão independente do diff.
