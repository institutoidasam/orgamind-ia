# OrgaMind — número por área e envio rastreável (lote sem decisão do plano GBR)

## Intenção

Em 03/11/2026 entregamos à GBR o plano de implementação (`reports/plano-gbr/`, gerado a partir de `dados.py`), com 24 itens. Metade dos itens P0 depende da oficina de decisões (ALN-01), e essa oficina aconteceu **só em parte**. Em 10/11/2026 o usuário escolheu começar pelo lote que **não depende de decisão da GBR**:

- **D-01**: telas que não carregam (falhas anotadas pela GBR em 26/10);
- **PUB-01**: vários turnos no mesmo envio;
- **PUB-03**: mostrar quem ficou fora por não ter sido marcado;
- **INT-01**: conferir o número antes de enviar e parar de dizer "Enviado" antes da hora;
- **INT-02**: tentativas e repetição segura;
- **INT-03**: situação de cada pessoa (aceito, entregue, lido, respondeu).

Da parte da oficina que aconteceu veio uma decisão nova sobre o canal, que **não estava no plano**: **cada área tem o próprio número de WhatsApp**, conectado pelo QR code. Nas palavras do usuário: "quando eu cadastrar um novo número no sistema eu posso associar a uma área de atuação, também posso ter várias áreas no mesmo número". Ela entra neste lote porque mexe no mesmo ponto do envio que o INT-01.

**Por que agora:** a GBR viu telas vazias e um "Enviado" que só quer dizer "a API aceitou". Este lote resolve o que ela já reclamou, deixa o envio confiável e prepara o terreno para as etapas que dependem das decisões (cadastro, permissões, alerta urgente).

O usuário aprovou cada parte do desenho na conversa de 10/11/2026. Os pontos marcados *(decisão minha)* foram completados por mim para fechar o desenho. Depois ele conferiu o fluxo desenhado em `reports/fluxo-numero-por-area/fluxo.html` e respondeu "ok", aprovando também as decisões marcadas ali para conferência. Entre elas: área sem número trava o envio inteiro, não só aquela área.

**Vocabulário:** "área" na fala da GBR é o **setor** do sistema (`Sector`). "Número" é o **canal** conectado por QR code (`Channel`).

## Objetivos

1. **Número por área.** Ao conectar um número, escolher a área ou as áreas que ele atende. Um número pode servir várias áreas.
2. **O envio escolhe o número sozinho.** Cada pessoa recebe pelo número da área em que trabalha naquela data. O operador deixa de escolher o canal no envio da equipe.
3. **Área sem número fica bloqueada, e isso fica bem à vista.**
4. **Telas que abrem** (D-01): escala, destinatários, agendados e histórico, com paginação e erro recuperável.
5. **Público:** vários turnos no mesmo envio (PUB-01) e "fora: não selecionado" na prévia (PUB-03).
6. **Envio rastreável:**
   - conferir o número no GoZap antes de enviar (INT-01);
   - registrar tentativas e permitir repetição segura (INT-02);
   - mostrar a situação de cada pessoa numa tela de resultado (INT-03).

## Não objetivos

- **Itens que dependem da oficina:**
  - CAD-01, CAD-02, CAD-03, CAD-05 e MSG-01;
  - PUB-02 (base do público, folga × férias);
  - MSG-02 (alerta urgente e "ciente").
- **"Ciente":** fica para o alerta urgente (MSG-02), porque não foi decidido o que conta como ciência *(decisão minha)*.
- **Caixa de respostas por área, atendimento e passagem de turno** (INT-04 e MSG-03). A resposta da pessoa cai na conversa daquele número, como já acontece (`Conversation.instanceId`).
- **Congelar o telefone no agendamento** (parte do DAT-01).
- **Mudar outros fluxos de envio:** campanhas, chat da caixa de entrada e comunicados internos continuam escolhendo o canal como hoje.
- **Subir o plano GoZap:** é decisão de custo da GBR e acontece fora do código.

## Anti-objetivos (falha mesmo que funcione)

- Alguém receber mensagem por um número que não é o da sua área naquela data.
- Uma área sem número receber mensagem por outro número qualquer.
- Mostrar "Enviado", "entregue" ou "lido" sem o provedor ter confirmado.
- O botão "repetir" mandar a mesma mensagem duas vezes para alguém que já a recebeu, incluindo após timeout.
- Perder ou reescrever o histórico de envios já feitos, inclusive o canal que eles usaram.
- No dia da implantação, o envio da equipe na GBR parar sem ninguém ter mexido na configuração (ver "Transição").

## Restrições

- **Stack e padrões atuais:**
  - backend: NestJS, Prisma, Zod (`createZodDto`) e BullMQ;
  - frontend: React, TanStack Query/Router e Radix;
  - testes: Vitest e testcontainers.
- **Pipeline do envio da equipe reaproveitado:**
  - `TeamWhatsappDispatch` com um `TeamWhatsappRecipient` por pessoa;
  - fila `TEAM_WHATSAPP_SEND` com `jobId = recipientId`;
  - pulados guardam o motivo;
  - o agendamento usa o tick que já existe;
  - a lista é refeita no servidor e comparada com a conferida (422 `invalid_selection`).
- **Quem envia não muda:** ADMIN, SUPERVISOR e OPERATOR, com o ADMIN alcançando todos os setores e o gestor os setores que gerencia. Quem conecta e configura números continua sendo o ADMIN (`whatsapp-providers.controller.ts`).
- **Plano GoZap atual:** a conta usada pela GBR permite **uma** conexão (`GOZAP_MAX_INSTANCES`, padrão 1). Até a GBR subir o plano, a produção roda com um número atendendo todas as áreas. O caso com vários números precisa ser coberto por testes automatizados.
- **Banco e servidor:** migrações sem perda de dados. O VPS de produção tem pouca memória, então nada de serviço novo no compose.
- **Textos:** em pt-BR, no tom das telas atuais.
- **Base do trabalho:** partir de `origin/main`, porque o `main` local está desatualizado.

## O que fica decidido

### 1. Número por área

- **Associação:** um número conectado atende **uma ou mais áreas**.
  - Ela é escolhida no diálogo de nova conexão (QR code) e pode ser editada depois na lista de conexões.
  - Só o ADMIN associa, como já acontece com conectar número.
- **Uma área tem no máximo um número** *(decisão minha)*. Sem essa regra, não haveria como saber por qual número enviar.
  - Se a área escolhida já está em outro número, o sistema pede confirmação: "Logística sai do número (92) 9xxxx-1111 e passa para este".
- **Uma só fonte da verdade.** A tela atual "Números e canais" (`SectorNumber`, um setor por número, roteamento "Pendente de configuração") não pode contradizer a associação.
  - O construtor decide se migra esse cadastro para a nova associação ou se o mostra em modo leitura.
  - Em qualquer caso, não pode haver dois lugares que definam a área de um número.
  - Hoje `routeToSector` não roteia nada: só aparece na tela do setor (`internal-sectors.repository.ts:58`). Por isso, migrar ou deixar o cadastro em modo leitura não muda o comportamento de entrada.
- **Número removido ou desativado:** as áreas dele ficam sem número, e valem as regras da seção 2.

### 2. Área sem número, bem à vista

Decisão do usuário: fica **bloqueado**, e a falta do número tem que ficar **visível**.

- **No envio:** cada área selecionada sem número aparece num aviso destacado com o nome da área. O botão de enviar ou agendar fica travado.
  - O aviso diz como resolver: "Associe um número a esta área em Conexões". O link só aparece para o ADMIN.
- **Nas telas de setor** *(decisão minha)*: na lista de setores e na página do setor, um selo "Sem número".
- **Na lista de conexões** *(decisão minha)*: cada número mostra as áreas que atende. No topo, o aviso "Áreas sem número: …" quando houver alguma.
- **O servidor também bloqueia.** A regra não fica só na tela.

### 3. O envio escolhe o número

- **Envio para áreas:**
  - Cada pessoa recebe pelo número da área em que trabalha naquela data.
  - O remanejado (exceção "Outro setor" na escala) recebe pelo número da área onde está atuando.
  - O seletor de canal sai desse fluxo.
- **Envio para uma pessoa:** sai pelo número da área dela naquela data. Pessoa sem área é bloqueada com o motivo "sem área" *(decisão minha)*.
- **Áreas com números diferentes no mesmo envio:** o sistema divide sozinho, um grupo por número.
  - A prévia mostra a divisão: "Logística, 12 pessoas, pelo (92) 9xxxx-1111; Expedição, 8 pessoas, pelo (92) 9xxxx-2222".
  - Para o operador continua sendo **um envio** no histórico, com os destinatários agrupados por número *(decisão minha)*. Como isso é gravado fica com o construtor.
  - Cada destinatário guarda por qual número saiu, e isso não muda depois. Hoje o canal fica só no envio (`TeamWhatsappDispatch.channelId`), então isso pede coluna nova no destinatário.
  - Envios antigos: o canal do destinatário é o canal do envio.
- **Agendado** *(decisão minha)*:
  - O número de cada pessoa fica congelado na criação, junto com o público, como já acontece hoje.
  - No disparo, o número é conferido (seção 5). Desconectado vira falha com motivo.
  - Mudar a associação depois não altera o que já foi agendado.
- **Envios antigos:** continuam mostrando o canal que usaram.

### 4. Público (PUB-01, PUB-03)

- **Vários turnos:** é possível escolher vários turnos no mesmo envio (Dia + Noite, ou outra combinação), junto com vários setores.
  - Cada pessoa continua contada uma vez só.
  - "Todos os turnos" continua existindo.
  - A opção "incluir quem está de folga" continua valendo só com todos os turnos, como hoje *(decisão minha)*. Mudar isso é o PUB-02, que depende do calendário da GBR.
- **Na tela:** fica claro que o filtro do quadro da escala não limita o envio.
- **"Fora: não selecionado":** na seleção "somente os marcados", a prévia lista os não marcados com esse motivo, junto com os motivos de hoje (sem telefone e demais).

### 5. Conferir o número antes de enviar (INT-01)

- **Hoje:** só o estado `close` do último evento (`connectionEvents[0]`, `team-whatsapp.service.ts:478`) bloqueia o envio. O adaptador de envio GoZap não consulta estado ao vivo. O `GET /instance/status` existe só em `gozap-instances.service.ts` e no reconciliador. A consulta no disparo é construção nova sobre esse endpoint, e sobre o equivalente para canais Evolution, que o envio da equipe também aceita.
- **No disparo:** o sistema consulta no provedor o estado de **cada número envolvido**, em vez de usar só o último evento recebido.
  - Desconectado trava o envio, e a prévia diz qual número é e quais áreas ele atende.
  - Se o provedor não responder, o envio também fica travado, com a mensagem "Não foi possível conferir o número. Tente de novo" *(decisão minha)*.
- **Na fila:** o número é conferido de novo antes de cada mensagem, e nunca se envia por um número que se sabe desconectado.
  - A mensagem que não sai por esse motivo vira falha "número desconectado", e essa falha pode ser repetida.
  - A frequência real da consulta (cache curto por número, por exemplo) fica com o construtor, desde que a garantia acima valha.
- **Na prévia:** mostrar o número de origem de cada grupo e a hora da última verificação.
- **Rótulo:** "Enviado" passa a ser **"Aceito pelo WhatsApp"** até chegar a confirmação de entrega.

### 6. Tentativas e repetição segura (INT-02)

- **Por pessoa:** guardar o número de tentativas e o motivo da última falha, e mostrar os dois.
  - "Tentativa" é cada chamada de envio ao provedor, somando as automáticas do BullMQ (hoje até 3, `team-whatsapp-send.processor.ts:92`) com as manuais *(decisão minha)*.
- **"Repetir":**
  - Só aparece em **falha certa**, isto é, quando a mensagem com certeza não saiu: número desconectado, provedor recusou ou erro de validação.
  - **Não aparece** em timeout nem em situação desconhecida, porque a mensagem pode ter saído. Nesses casos a pessoa aparece como "Situação incerta", com uma explicação.
  - Não aparece para "telefone sem WhatsApp", porque repetir não adianta *(decisão minha)*.
  - Repetir não cria um destinatário novo: é nova tentativa do mesmo. O texto e o número da tentativa original são mantidos.
  - **A garantia contra duplicata fica no banco**, não só no `jobId`. Repetir só sai de "falha certa" por uma troca de estado atômica (falha certa → na fila). Dois cliques ou duas abas geram uma tentativa só.
  - O BullMQ ignora `add` com `jobId` de job já concluído ou falho. Por isso o esquema de `jobId` da repetição fica com o construtor, desde que a garantia acima valha.
  - Quem pode repetir é quem vê o envio no histórico (seção 7) e pode enviar para aquela área.
  - Repetir em lote ("repetir todas as falhas certas") fica com o construtor, se sair barato.

### 7. Situação de cada pessoa e tela de resultado (INT-03)

- **Situações:**

  | Situação | Quando |
  |---|---|
  | Na fila | Mensagem aguardando envio |
  | Aceito pelo WhatsApp | Hoje chamado de `SENT` |
  | Entregue | Recibo do GoZap |
  | Lido | Recibo do GoZap |
  | Respondeu | A pessoa mandou mensagem depois do envio |
  | Falhou | Com motivo |
  | Situação incerta | Timeout ou estado desconhecido |

  Continuam existindo: pulado (com motivo), agendado e cancelado.

  O banco hoje tem QUEUED, SENT, FAILED, SKIPPED, SCHEDULED e CANCELLED (`schema.prisma:1626`), e o timeout vira FAILED com `errorCode: 'team_whatsapp.indeterminate'` (`team-whatsapp-send.processor.ts:59-61`). Na migração, essas linhas antigas passam a aparecer como "Situação incerta", e o `SENT` antigo como "Aceito pelo WhatsApp".
- **Origem dos estados:**
  - "Entregue" e "Lido" vêm dos recibos do GoZap que já chegam para `Message` (`webhooks.service.ts`), levados ao destinatário pelo ID externo da mensagem.
  - Valem as proteções de hoje: eventos repetidos ou fora de ordem não fazem a situação voltar (lido não volta a entregue).
- **"Respondeu"** *(decisão minha)*:
  - É a primeira mensagem que a pessoa manda **para aquele número** depois do envio.
  - Se ela recebeu vários envios daquele número, a resposta marca o mais recente anterior a ela.
  - Respondeu fica acima de lido na ordem.
- **Tela de resultado:**
  - Quem vê é quem já tem acesso ao histórico do WhatsApp da equipe (resposta do usuário: "quem vai abrir é quem tem acesso").
  - A visibilidade de hoje não muda *(decisão minha)*: o ADMIN vê todos os envios, e os demais só os próprios (`listDispatches(authorId)`, `team-whatsapp.repository.ts:473-475`).
  - No topo, contagens por situação *(decisão minha)*. Abaixo, a lista por nome, com filtro por situação, número de origem, tentativas e motivo.
  - A tela serve para auditoria: dá para conferir, nome a nome, quem recebeu, quem leu e quem ficou de fora.

### 8. Telas que abrem (D-01)

- **Limitar** as consultas que hoje trazem todos os registros:
  - `findMembersForDay` (linha 252) e `listScheduled` (linha 447) em `team-whatsapp.repository.ts`, que não têm limite nenhum;
  - as consultas de apoio do quadro da escala (`board` em `staff-schedule.service.ts:66`, que usa `listSectorPeople` e `listVisitorIds` em `staff-schedule.repository.ts:196` e `:213`).
- **Reduzir** o recálculo por setor.
- **Paginar** o histórico de envios, que hoje mostra só os 20 últimos (`RECENT_DISPATCHES`).
- **Erro recuperável:** nas telas do envio da equipe, da escala e do histórico, quando der erro, mostrar o erro com botão de tentar de novo no lugar de tela vazia.
  - As seções principais já usam o componente `QueryErrorFallback`, com o botão "Tentar novamente". O trabalho é cobrir as consultas que ainda caem em tela vazia, como a escala dentro do diálogo de envio, e reaproveitar o mesmo componente e o mesmo texto *(decisão minha)*.
- **Reproduzir as falhas de 26/10:** precisa de conta de teste na versão publicada, e a senha do seed não vale mais. Sem a conta, o D-01 entra só pelo lado do código, e a reprodução fica registrada como pendência.

### 9. Transição no dia da implantação

Hoje nenhuma área tem número. Pela regra da seção 2, tudo ficaria bloqueado no dia da implantação. Decisão do usuário em 10/11/2026: "pode associar automaticamente ao número atual". A migração associa as áreas ativas a um número nesta ordem:

1. **Cadastro existente:** se a área já tem um `SectorNumber` ligado a um canal elegível, vale esse canal.
2. **Padrão elegível:** as demais áreas vão para o canal padrão (`Channel.isDefault`), se ele for elegível.
3. **Único elegível:** sem padrão elegível, as demais vão para o único canal elegível.
4. **Nenhum:** se houver mais de um canal elegível e nenhum padrão elegível, as demais ficam sem número, e os avisos da seção 2 aparecem.

**Elegível** = ativo e de provedor aceito pelo envio da equipe, GOZAP ou EVOLUTION (`team-whatsapp.policy.ts:4`). Canais de campanha (TWILIO, ZERNIO) nunca contam, mesmo que sejam o padrão do sistema.

Áreas criadas depois começam sem número.

## Aceite

- **Número por área:** conectar ou editar um número com duas áreas faz as duas passarem a enviar por ele.
- **Mover área:** associar a outro número uma área que já tem número pede confirmação e a move.
- **Envio dividido:** um envio para duas áreas com números diferentes sai dividido. Cada pessoa recebe pelo número da sua área na data, o remanejado pelo número da área onde atua, e a prévia mostra a divisão.
- **Área sem número:**
  - o envio fica travado, com aviso destacado na prévia;
  - o selo aparece nas telas de setor e o aviso na lista de conexões;
  - o servidor recusa a chamada direta.
- **Número desconectado:**
  - no disparo, o envio fica travado e diz qual número e quais áreas;
  - na fila, a mensagem vira falha "número desconectado", que pode ser repetida.
- **Rótulo:** "Aceito pelo WhatsApp" aparece até o recibo, depois "Entregue", "Lido" e "Respondeu". Recibo repetido ou fora de ordem não faz a situação voltar.
- **Repetir:**
  - aparece em falha certa e não em timeout nem em situação incerta;
  - repetir não gera duas mensagens para a mesma pessoa.
- **Público:**
  - envio com Dia + Noite em dois setores conta cada pessoa uma vez;
  - na seleção parcial, a prévia lista "fora: não selecionado".
- **D-01:**
  - o histórico pagina além dos 20;
  - as consultas de escala, destinatários e agendados têm limite;
  - erro de carregamento mostra o erro com o botão "Tentar novamente", em vez de tela vazia.
- **Transição:** depois da migração, o envio da equipe na GBR continua funcionando pelo número atual sem nenhuma configuração manual.
- **Regressão:**
  - envios antigos continuam mostrando canal, destinatários e situação;
  - campanhas e chat não mudam.

## Fica com o construtor

- Modelagem da associação número ↔ áreas e do grupo por número dentro de um envio.
- Destino do cadastro `SectorNumber` (migrar ou mostrar em modo leitura), respeitando a fonte única.
- Frequência e cache da consulta de estado no GoZap, respeitando a garantia da seção 5.
- Nome dos novos valores de situação no banco e mapeamento do `SENT` atual para "aceito".
- Tamanho de página e limites das consultas do D-01.
- Repetição em lote.
- Fatiamento em tasks e ordem de implementação. Sugestão: D-01, depois o número por área, depois INT-01, INT-02 e INT-03, deixando PUB-01 e PUB-03 em paralelo onde não colidirem.
