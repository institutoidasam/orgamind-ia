import type { Prisma, MessageStatus } from '@prisma/client';

import {
  isPermanentRecipientFailure,
  PERMANENT_RECIPIENT_FAILURE_CODES,
  INDETERMINATE_DELIVERY_CODES,
} from './marketing-reachability';

// A lista, materializada para a query: o helper `isPermanentRecipientFailure` é
// ponto-a-ponto; aqui o Postgres precisa do conjunto inteiro.
const PERMANENT_CODES_FOR_QUERY = [...PERMANENT_RECIPIENT_FAILURE_CODES];

/**
 * ZE — QUEM AINDA FALTA NESTA CAMPANHA.
 *
 * O pedido do cliente, literal: *"Quero enviar 50 agora... Aí depois eu quero,
 * naquela mesma campanha, enviar para mais 100. Só que eu não vou ter a dor de
 * cabeça de saber pra quem eu não enviei — o sistema só vai me listar, só vou
 * poder enviar para as pessoas que eu ainda não enviei naquela campanha."*
 *
 * Este módulo é a resposta a "pra quem eu ainda não enviei". A audiência de um
 * lote é a audiência ORIGINAL da campanha menos duas coisas:
 *
 *   1. quem já foi TRATADO nesta campanha (tem uma `Message` que não é uma falha
 *      transitória) — é o "não repete";
 *   2. quem é PERMANENTEMENTE INALCANÇÁVEL para MARKETING (30% da base, medido
 *      ao vivo) — e só quando a campanha é de MARKETING.
 *
 * ── O BROADCAST DO ZERNIO: O QUE ESTA NOTA DIZIA, E O QUE ESTAVA ERRADO ───────
 * Esta nota afirmava que o broadcast nativo "devolve apenas CONTADORES AGREGADOS"
 * e "não diz QUEM". **Isso estava errado**: o `GET /v1/broadcasts/{id}/recipients`
 * é documentado e devolve status POR DESTINATÁRIO (`status`, `messageId` (o wamid),
 * `errorCode`, `errorExplanation`, `sentAt`, `deliveredAt`, `readAt`). A premissa
 * que sustentava o "não migrar" não existia.
 *
 * O broadcast agora EXISTE como caminho (ver `zernio-broadcast-send.service.ts`) —
 * porque o cliente precisa VER a campanha no painel do Zernio, e o 1-a-1
 * (`POST /inbox/conversations`) não cria disparo nenhum lá.
 *
 * **Mas NADA neste arquivo muda por causa disso**, e é esse o ponto:
 *   • o gate de consentimento continua rodando POR CONTATO, e ANTES de montar o
 *     broadcast — as linhas SKIPPED_* continuam sendo gravadas uma por pessoa;
 *   • o "quem já foi tratado" continua sendo `Message.status` — a Message existe
 *     igual, só o TRANSPORTE dela mudou;
 *   • o opt-out individual continua valendo, e o lote continua não repetindo.
 * O broadcast é uma OPÇÃO POR CANAL (`Channel.zernioBroadcastEnabled`, default
 * FALSE). O 1-a-1 continua sendo o PADRÃO e o FALLBACK — inclusive porque um
 * template com variável POR CONTATO **não pode** ir por broadcast (o Zernio
 * resolve variáveis contra o CRM dele; ver `zernio-broadcast-variables.ts`).
 * Os lotes continuam sendo construídos POR CIMA das Messages, não do transporte.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Status de `Message` que significam "este contato já foi tratado nesta
 * campanha" — ele NÃO volta para um próximo lote.
 *
 * `FAILED` está deliberadamente FORA: uma falha só bloqueia o contato quando é
 * DEFINITIVA (ver `isPermanentRecipientFailure`). Uma falha transitória — o
 * Zernio caiu, deu 500, deu timeout — devolve o contato para a fila de
 * pendentes, e o próximo lote o pega de novo sem o operador ter que caçar quem
 * faltou. Essa distinção é o coração da retomada.
 */
export const BATCH_HANDLED_STATUSES: MessageStatus[] = [
  // Em voo: enfileirar de novo criaria mensagem duplicada para a mesma pessoa.
  'QUEUED',
  'WAITING_INSTANCE',
  'SENDING',
  // Entregues (em algum grau) — o "grupo de enviadas" do cliente.
  'SENT',
  'DELIVERED',
  'READ',
  'RECEIVED',
  // Cancelada junto com a campanha (ou pelo kill-switch): não reenviar sozinho.
  'CANCELLED',
  // Avaliados e recusados pelo gate NESTA campanha. Contam como tratados: a
  // decisão foi tomada e registrada; reavaliá-los a cada lote reabriria a
  // supressão a cada clique.
  'SKIPPED_NO_OPTIN',
  'SKIPPED_NO_CONSENT',
  'SKIPPED_SUPPRESSED',
];

/**
 * Esta mensagem tira o contato da lista de pendentes da campanha?
 *
 * Espelha, em memória, a mesma regra que `pendingAudienceWhere` empurra para o
 * Postgres — as duas precisam concordar, ou a tela contaria uma coisa e o lote
 * enviaria outra.
 */
export function isHandledInCampaign(message: {
  status: MessageStatus;
  errorCode: string | null;
}): boolean {
  if (message.status === 'FAILED') {
    return isPermanentRecipientFailure(message.errorCode);
  }
  return BATCH_HANDLED_STATUSES.includes(message.status);
}

/**
 * O predicado de "já tratado nesta campanha", em Prisma.
 *
 * Escrito como um OR EXPLÍCITO de propósito, em vez de um `NOT ... in`: um
 * `errorCode NOT IN (...)` tem semântica de SQL três-valorada e simplesmente
 * NÃO casa linhas com `errorCode IS NULL` — uma falha sem código sumiria da
 * conta em silêncio. Enumerar o que bloqueia é chato e é correto.
 */
export function handledInCampaignFilter(
  campaignId: string,
): Prisma.MessageWhereInput {
  return {
    campaignId,
    OR: [
      { status: { in: BATCH_HANDLED_STATUSES } },
      // FAILED só bloqueia quando a falha é definitiva para o destinatário.
      { status: 'FAILED', errorCode: { in: PERMANENT_CODES_FOR_QUERY } },
    ],
  };
}

/**
 * "Este contato RECEBEU esta campanha?" — SENT|DELIVERED|READ, e nada além (D2).
 *
 * DIFERE de `handledInCampaignFilter` de propósito: aquele é "já foi TRATADO"
 * (inclui QUEUED, CANCELLED e os SKIPPED_* — 11 status), e serve ao lote, que não
 * pode repetir nem quem está em voo. Este é "de fato RECEBEU", e é o que permite
 * reavaliar o consentimento de quem o gate barrou: um SKIPPED_NO_CONSENT NÃO
 * recebeu, então continua elegível quando dá opt-in depois.
 *
 * É o MESMO predicado que a Fase 1 aplica a OUTRAS campanhas (event:'received').
 */
export const REACHED_STATUSES: MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];

export function reachedInCampaignFilter(
  campaignId: string,
): Prisma.MessageWhereInput {
  return {
    campaignId,
    direction: 'OUTBOUND',
    status: { in: REACHED_STATUSES },
  };
}

/**
 * "Este contato já foi RECEBIDO ou está EM VOO nesta campanha?" —
 * `REACHED_STATUSES` (SENT|DELIVERED|READ) mais QUEUED|SENDING|WAITING_INSTANCE.
 *
 * É o predicado do RETRY (Task 6, §0.4): uma linha FAILED cujo contato tem uma
 * irmã já entregue OU ainda a caminho não deve ser reenviada — reenviar por
 * cima duplicaria a entrega (`REACHED_STATUSES` sozinho ignoraria quem está
 * em voo, que `countInFlight` já trata como tratado).
 */
export const REACHED_OR_IN_FLIGHT_STATUSES: MessageStatus[] = [
  ...REACHED_STATUSES,
  'QUEUED',
  'SENDING',
  'WAITING_INSTANCE',
];

export function reachedOrInFlightInCampaign(
  campaignId: string,
): Prisma.MessageWhereInput {
  return {
    campaignId,
    direction: 'OUTBOUND',
    status: { in: REACHED_OR_IN_FLIGHT_STATUSES },
  };
}

/**
 * A audiência PENDENTE de um lote: a audiência da campanha, menos quem já foi
 * tratado nela, menos os inalcançáveis (quando é MARKETING).
 *
 * `excludeMarketingUndeliverable` vem da CATEGORIA do template da campanha, e
 * não é um detalhe: a Meta diz explicitamente, no 130472, que "UTILITY TEMPLATES
 * ARE NOT AFFECTED". Aplicar a exclusão a uma campanha UTILITY seria deixar de
 * falar com quem a Meta permite que a gente fale.
 */
export function pendingAudienceWhere(args: {
  campaignId: string;
  audience: Prisma.ContactWhereInput;
  excludeMarketingUndeliverable: boolean;
}): Prisma.ContactWhereInput {
  const clauses: Prisma.ContactWhereInput[] = [
    args.audience,
    { messages: { none: handledInCampaignFilter(args.campaignId) } },
  ];
  if (args.excludeMarketingUndeliverable) {
    clauses.push({ marketingUndeliverableAt: null });
  }
  return { AND: clauses };
}

/**
 * A audiência AINDA-NÃO-ALCANÇADA: a audiência da campanha, menos quem RECEBEU
 * (não menos quem foi só tratado — os pulados pelo gate VOLTAM), menos os
 * inalcançáveis quando é MARKETING.
 *
 * É o recorte do "Disparar novamente" e do tick recorrente: reenvia a quem não
 * recebeu, reavalia o gate para quem foi pulado, e NÃO repete quem já recebeu.
 */
export function unreachedAudienceWhere(args: {
  campaignId: string;
  audience: Prisma.ContactWhereInput;
  excludeMarketingUndeliverable: boolean;
}): Prisma.ContactWhereInput {
  const clauses: Prisma.ContactWhereInput[] = [
    args.audience,
    { messages: { none: reachedInCampaignFilter(args.campaignId) } },
    { messages: { none: indeterminateDeliveryInCampaign(args.campaignId) } },
  ];
  if (args.excludeMarketingUndeliverable) {
    clauses.push({ marketingUndeliverableAt: null });
  }
  return { AND: clauses };
}

/**
 * ★ C11 — "POSSIVELMENTE RECEBEU" CONTA COMO RECEBEU.
 *
 * Uma falha de entrega INDETERMINADA (o worker morreu depois do POST, o
 * provedor deu timeout sem responder) pode ter sido entregue e cobrada. O
 * sistema inteiro já trata isso como intocável — o `sending-reconciler` NÃO
 * re-enfileira, os botões de retry recusam, `findFailedMessageIds` a ignora —
 * mas o resolvedor de audiência não sabia disso: para ele a linha era só uma
 * FAILED, e FAILED não bloqueia ninguém no recorte `unreached`. Resultado: o
 * redisparo e o tick criavam uma linha NOVA e mandavam de novo, pelo caminho
 * automático, para alguém que pode já ter recebido.
 *
 * No recorte do LOTE (`pending`) isto já é coberto por outro caminho: os mesmos
 * códigos estão em `PERMANENT_RECIPIENT_FAILURE_CODES`, então
 * `handledInCampaignFilter` os bloqueia.
 */
export function indeterminateDeliveryInCampaign(
  campaignId: string,
): Prisma.MessageWhereInput {
  return {
    campaignId,
    direction: 'OUTBOUND',
    status: 'FAILED',
    errorCode: { in: INDETERMINATE_DELIVERY_CODES },
  };
}

/**
 * A audiência do TICK RECORRENTE: como `unreachedAudienceWhere`, mas excluindo
 * TAMBÉM quem ainda está EM VOO nesta campanha.
 *
 * ★ Por que o tick precisa de um recorte próprio (auditoria 2026-08-19, C1/C4):
 * o "Disparar novamente" só roda depois de `countInFlight === 0` (I10 recusa o
 * botão enquanto o lote anterior drena), então para ele "não recebeu" e "não
 * está em voo" são a mesma coisa. O TICK não tem essa guarda: ele volta a cada
 * 5/60 minutos por construção, e o lote anterior leva HORAS ou DIAS para drenar
 * (pacing de 15–45 s por mensagem, mais o teto de usuários únicos em 24h do
 * tier). Numa campanha recorrente de 13.000 eleitores, o tick seguinte
 * encontrava ~12.500 linhas ainda `QUEUED` e criava uma SEGUNDA linha para cada
 * uma — a mesma pessoa recebendo a mesma propaganda eleitoral 2x, 3x, N vezes.
 *
 * O que continua ELEGÍVEL é o ponto: `FAILED` e os `SKIPPED_*` NÃO estão em
 * `REACHED_OR_IN_FLIGHT_STATUSES`, então quem o gate pulou por falta de
 * consentimento continua voltando a cada tick (Fase 0 §0.3) — que é
 * exatamente o motivo de o tick não usar o recorte `pending`.
 */
export function unreachedIdleAudienceWhere(args: {
  campaignId: string;
  audience: Prisma.ContactWhereInput;
  excludeMarketingUndeliverable: boolean;
}): Prisma.ContactWhereInput {
  const clauses: Prisma.ContactWhereInput[] = [
    args.audience,
    { messages: { none: reachedOrInFlightInCampaign(args.campaignId) } },
    // C11 — entrega indeterminada é "possivelmente recebeu": o tick não reabre.
    { messages: { none: indeterminateDeliveryInCampaign(args.campaignId) } },
  ];
  if (args.excludeMarketingUndeliverable) {
    clauses.push({ marketingUndeliverableAt: null });
  }
  return { AND: clauses };
}

/**
 * Os únicos estados que provam RECEBIMENTO CONSUMADO.
 *
 * `SENT` fica de fora de propósito: significa apenas "aceito pelo provedor". O
 * incidente do 9º dígito (2026-08-07) provou que uma mensagem pode ficar em
 * `SENT` PARA SEMPRE sem nunca chegar — o WhatsApp aceita a stanza, devolve um
 * id e descarta calado. Onde a pergunta é "essa pessoa recebeu de fato?", só
 * `DELIVERED`/`READ` respondem.
 */
export const RECEIVED_STATUSES: MessageStatus[] = ['DELIVERED', 'READ'];

/**
 * ★ O QUE UMA CAMPANHA CANCELADA AINDA BLOQUEIA — decisão do dono, 2026-08-19.
 *
 * `RECEIVED_STATUSES` mais `SENT`. A régua antiga (só DELIVERED/READ) partia
 * do incidente do 9º dígito: um `SENT` pode nunca chegar, então não deveria
 * queimar o contato. O que ela não considerou é que o CANCELAMENTO não cancela
 * o `SENT`: `cancelQueuedMessages` só vira QUEUED/WAITING_INSTANCE em
 * CANCELLED — uma linha `SENT` já está NO PROVEDOR e vai ser entregue, o que
 * ainda não voltou é o recibo. O operador que cancelava a campanha errada e
 * recriava a mesma com o mesmo template mandava o texto duas vezes para as
 * mesmas pessoas (C14 da auditoria 2026-08-19).
 *
 * A régua nova é exatamente o que o cancelamento faz: uma campanha cancelada
 * libera a FILA que ela de fato cancelou, e nada além disso.
 *
 * ── ONDE ESTA RÉGUA VALE, E ONDE ESTÁ A SAÍDA (revisão, 2ª rodada) ──────────
 *
 * `sameTemplateBlockFilter` é consumido em quatro lugares, e a régua vale nos
 * quatro DE PROPÓSITO:
 *
 *   1. o RECORTE DA AUDIÊNCIA (`resolveAudience` + a rede recalculada por
 *      página no `dispatchAudience`) — inclusive no modo `full`;
 *   2. `findFailedMessageIds` — o "Reenviar falhas" em massa;
 *   3. `countUnreachedFailedContacts` — o N do botão. Ele NÃO pode divergir do
 *      item 2: se contasse sem a rede, prometeria N e enviaria menos, que é
 *      exatamente a prévia mentindo — o defeito que este mesmo pacote
 *      consertou;
 *   4. `retryMessage` — o retry unitário de uma FALHA.
 *
 * O RISCO CONHECIDO: com o incidente do 9º dígito (2026-08-07), uma linha pode
 * ficar `SENT` PARA SEMPRE sem nunca chegar — e nos canais que não suportam
 * polling de status (Zernio/GoZap/Evolution) nem o `sending-reconciler` a
 * resolve. Cancelar uma campanha nesse estado queima aquele template para
 * aquelas pessoas nos quatro caminhos acima.
 *
 * ── AS DUAS VÁLVULAS, E QUANDO USAR CADA UMA ────────────────────────────────
 *
 * 1. UMA LINHA: `redispatchMessage` — o "Disparar novamente" NESTA mensagem —
 *    NÃO consulta esta rede, de propósito. É um ato individual, explícito,
 *    sobre uma linha que o operador está olhando, e fica no log de auditoria
 *    (`message.redispatch`). É por ali que se destrava um `SENT` preso caso a
 *    caso: o operador corrige o número e redispara a PRÓPRIA linha travada (ela
 *    é a única viva daquele contato, então a trava de banco a aceita). O teste
 *    "NÃO consulta a rede do mesmo template — é a saída manual do operador
 *    (9º dígito)" existe para que ninguém feche essa porta por engano.
 *
 * 2. O LOTE INTEIRO (I15 da revisão de integração, 2026-08-19):
 *    `CampaignsService.releaseUnconfirmedSent`. A válvula de cima é uma linha
 *    por clique, e destravar 13.000 assim não é uma saída — era o risco
 *    residual registrado aqui, e ele deixou de ser residual quando se percebeu
 *    que o cenário mais provável não é o 9º dígito, e sim o NÚMERO BANIDO no
 *    meio do disparo (o histórico desta operação): o operador cancela e recria
 *    em outro canal, e a régua acima esvazia a campanha nova.
 *
 *    O mecanismo não adivinha qual dos dois motivos de cancelamento ocorreu —
 *    ele PERGUNTA. O dono declara "o canal morreu, estas nunca chegaram", com
 *    confirmação explícita depois de ver o número, e as `SENT` daquela campanha
 *    cancelada viram `FAILED` (motivo `CANAL_FORA`). E `FAILED` não bloqueia em
 *    camada NENHUMA — nem aqui, nem nas duas guardas do instante do envio — que
 *    é justamente por que esse é o estado de destino: a pessoa volta a ser
 *    alcançável por todos os caminhos de uma vez, sem exceção especial em lugar
 *    nenhum. `DELIVERED`/`READ` nunca são tocados.
 */
export const CANCELLED_CAMPAIGN_BLOCKING_STATUSES: MessageStatus[] = [
  ...RECEIVED_STATUSES,
  'SENT',
];

/**
 * ★ "Este contato já está numa OUTRA campanha do MESMO template?"
 *
 * A regra pedida pelo dono em 2026-08-12 (spec
 * `docs/superpowers/specs/2026-08-12-exclusao-por-template-design.md`): quem já
 * está numa campanha do template T não pode aparecer na audiência de uma nova
 * campanha do template T.
 *
 * Duas réguas, porque cancelar uma campanha não desfaz o que já chegou:
 *
 *  - campanha VIVA      → bloqueia recebido **e em voo**
 *                         (`REACHED_OR_IN_FLIGHT_STATUSES`)
 *  - campanha CANCELADA → bloqueia o que foi ENTREGUE e o que já está no
 *                         PROVEDOR (`CANCELLED_CAMPAIGN_BLOCKING_STATUSES`);
 *                         libera a fila, que é o que o cancelamento cancela
 *
 * Incluir os estados EM VOO é o ponto todo. `REACHED_STATUSES` sozinho não
 * cobre `QUEUED`/`WAITING_INSTANCE`, e o caso que originou a regra é
 * exatamente esse: 500 disparados, outros 500 criados em seguida — a primeira
 * campanha ainda está na FILA quando a segunda materializa a audiência, e a
 * mesma pessoa entra nas duas.
 *
 * `FAILED` e os `SKIPPED_*` NUNCA bloqueiam: essas pessoas não receberam nada.
 * Bloqueá-las queimaria para sempre quem teve número errado, quem pegou uma
 * queda de canal, e — o pior — quem foi pulado por falta de consentimento e
 * DEPOIS consentiu.
 *
 * As campanhas chegam já expandidas (`templateId → ids`) porque
 * `Campaign.templateId` NÃO tem índice: perguntar por
 * `messages:{none:{campaign:{templateId}}}` viraria um join sem índice varrendo
 * a base inteira a cada prévia. Na forma expandida a consulta cai no
 * `@@index([contactId, campaignId, status])`.
 *
 * Devolve `null` quando não há nenhuma campanha anterior do template — aí não
 * há cláusula a aplicar, e o chamador NÃO deve montar um `none` vazio (que é
 * verdadeiro para todo mundo e daria a impressão de exclusão sem excluir nada).
 */
export function sameTemplateBlockFilter(args: {
  activeCampaignIds: string[];
  cancelledCampaignIds: string[];
}): Prisma.MessageWhereInput | null {
  const OR: Prisma.MessageWhereInput[] = [];
  if (args.activeCampaignIds.length > 0) {
    OR.push({
      campaignId: { in: args.activeCampaignIds },
      status: { in: REACHED_OR_IN_FLIGHT_STATUSES },
    });
  }
  if (args.cancelledCampaignIds.length > 0) {
    OR.push({
      campaignId: { in: args.cancelledCampaignIds },
      status: { in: CANCELLED_CAMPAIGN_BLOCKING_STATUSES },
    });
  }
  if (OR.length === 0) return null;
  return { direction: 'OUTBOUND', OR };
}
