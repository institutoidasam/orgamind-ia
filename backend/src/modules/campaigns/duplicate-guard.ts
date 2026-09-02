import type { MessageStatus, Prisma } from '@prisma/client';
import {
  REACHED_STATUSES,
  REACHED_OR_IN_FLIGHT_STATUSES,
  CANCELLED_CAMPAIGN_BLOCKING_STATUSES,
} from './batch-audience';

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * A GUARDA ANTI-DUPLICATA DO INSTANTE DO ENVIO — UMA SÓ, PARA OS DOIS
 * TRANSPORTES.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * "Esta PESSOA já recebeu — ou já está recebendo — o que esta linha ia mandar?"
 *
 * O sistema tem DOIS caminhos de saída e eles não se cruzam:
 *
 *   • o envio 1-a-1 (`send-message.processor.ts`), que é o padrão e o fallback,
 *     e roda POR MENSAGEM;
 *   • o BROADCAST do Zernio (`zernio-broadcast-send.service.ts`), que enfileira
 *     UM job para o lote inteiro e nunca passa pelo worker — e é onde está o
 *     volume do cliente eleitoral (um canal, 13.000 pessoas).
 *
 * ── POR QUE ESTE ARQUIVO EXISTE (I9 da revisão de integração) ────────────────
 *
 * As duas guardas nasceram em pacotes separados da mesma auditoria, como CÓPIAS
 * deliberadas — e o arquivo do broadcast deixou escrito o combinado: "QUANDO OS
 * DOIS PACOTES ESTIVEREM NA MAIN, o certo é apagar esta cópia". Eles chegaram
 * juntos, e a revisão de integração mediu o preço de não cumprir: as cópias já
 * tinham DIVERGIDO da rede da audiência na régua da campanha CANCELADA, e um
 * `diff` entre as duas não acusava nada porque elas divergiam JUNTAS. Agora é
 * uma função só: um único conjunto de status, um único lugar para errar.
 *
 * A régua de STATUS continua vindo de `batch-audience.ts`, que é a fonte para
 * as QUATRO camadas (recorte da audiência, "reenviar falhas", o contador do
 * botão e o retry unitário) — aqui só se reusa.
 *
 * ── AS DUAS RÉGUAS, E POR QUE AS QUATRO CAMADAS AGORA CONCORDAM ─────────────
 *
 *   • MESMA campanha, ou outra campanha VIVA do mesmo template → bloqueia o que
 *     foi recebido E o que está em voo;
 *   • campanha CANCELADA do mesmo template → bloqueia
 *     `CANCELLED_CAMPAIGN_BLOCKING_STATUSES`, que inclui `SENT`.
 *
 * O `SENT` da campanha cancelada é a decisão do dono (C14, 2026-08-19) e o
 * motivo está escrito lá: cancelar NÃO cancela o que já está no provedor —
 * aquela linha vai ser entregue, o que ainda não voltou é o recibo. Cancelar a
 * campanha errada e recriar a mesma com o mesmo template mandava o texto duas
 * vezes para as mesmas pessoas.
 *
 * Até esta correção, as duas guardas do instante do envio usavam só
 * `RECEIVED_STATUSES` (DELIVERED/READ) nessa cláusula, ou seja: a rede de baixo
 * era mais FROUXA que a de cima exatamente na regra que a auditoria decidiu
 * apertar. Não dava falso positivo, mas deixava a ÚLTIMA linha de defesa cega
 * para o C14 — quem chegasse aqui por um caminho que não passou pela rede da
 * audiência (redisparo manual, linha criada antes do cancelamento, corrida
 * entre o cancelamento e o disparo irmão) saía com a mesma propaganda pela
 * segunda vez, e as camadas teriam "concordado" com resultados opostos.
 *
 * ── E A OBJEÇÃO CONTRA O `SENT`, QUE É LEGÍTIMA E TEM RESPOSTA ──────────────
 *
 * Nos canais sem polling de status (Zernio/GoZap/Evolution) `SENT` é onde a
 * mensagem FICA PRESA quando o número é banido — e o incidente do 9º dígito
 * (2026-08-07) provou que ela pode ficar em `SENT` para sempre sem nunca
 * chegar. Bloquear `SENT` de campanha cancelada fecharia, sozinho, o caminho de
 * recuperação que este cliente mais usa: número banido no meio do disparo →
 * operador CANCELA → recria a campanha em outro canal.
 *
 * A resposta NÃO é afrouxar esta guarda (isso só esconde o problema em uma das
 * quatro camadas). É a porta que o pacote abriu junto:
 * `CampaignsService.releaseUnconfirmedSent` — "o canal morreu, estas SENT nunca
 * chegaram" — que converte em MASSA as `SENT` não confirmadas daquela campanha
 * cancelada para `FAILED`. E `FAILED` não bloqueia em camada nenhuma. Ou seja:
 * aperta-se nas quatro, e a saída é uma só, explícita, auditada e do tamanho do
 * problema (13.000 linhas num clique, não 13.000 cliques).
 *
 * ── TRÊS CUIDADOS QUE VALEM MAIS QUE A PRESSA ───────────────────────────────
 *
 * 1. `id: { not: messageId }` — é o que separa "duplicata" de "redisparo
 *    legítimo", e a razão é um CONTRATO, não uma esperança:
 *    `CampaignsRepository.createMessage({ resendReached: true })` — o caminho de
 *    `POST /campaigns/:id/redispatch { resendToAll: true }` — RESSUSCITA a linha
 *    existente (MESMO id, de volta a `QUEUED`) em vez de criar uma segunda, e o
 *    índice único PARCIAL `Message_campaign_contact_live_key` (OUTBOUND +
 *    estados vivos) impede que uma segunda linha viva exista para o par
 *    (campanha, contato). Então: linha ressuscitada = mesmo id = a guarda não a
 *    vê e o envio SAI; linha EXTRA = outro id = a guarda barra.
 *
 * 2. O desempate `(createdAt, id)` nas irmãs paradas na fila. Sem ele, duas
 *    linhas `QUEUED` do mesmo contato veem UMA À OUTRA e as DUAS se cancelam —
 *    a pessoa não recebe nada, em silêncio, que é exatamente o falso positivo
 *    caro aqui. Com ele, o par tem um vencedor determinístico: a mais VELHA
 *    envia, a mais nova cancela. `id` é o desempate do desempate, porque um
 *    `createMany` grava milhares de linhas com o MESMO `createdAt`.
 *
 * 3. "Mesmo template em outra campanha" é filtro de RELAÇÃO
 *    (`campaign: { templateId }`), e não a expansão `templateId → ids` de
 *    `sameTemplateBlockFilter`. A expansão custaria uma consulta A MAIS por
 *    mensagem (13.000 num disparo) numa `Campaign.templateId` SEM índice — e,
 *    pior, seria um SNAPSHOT: a campanha irmã criada no meio do disparo ficaria
 *    invisível. Aqui a consulta já está presa a UM contato
 *    (`@@index([contactId, campaignId, status])`), então o conjunto de linhas é
 *    de dezenas e o filtro de relação sai sempre FRESCO.
 */

/**
 * O código que o operador vê quando a mensagem não saiu porque a pessoa já
 * tinha recebido. Não é "falha": é recusa deliberada, com a irmã nomeada no
 * `errorMessage` e no audit. O MESMO slug nos dois transportes — eles precisam
 * cair no mesmo balde da tela.
 *
 * ── POR QUE O STATUS É `CANCELLED`, SABENDO QUE ELE CONTA COMO "TRATADO" ─────
 * `CANCELLED` está em `BATCH_HANDLED_STATUSES` (batch-audience.ts), então o
 * contato bloqueado SAI da audiência pendente dos próximos lotes. Isso é
 * DESEJADO: com o índice único parcial, a irmã que bloqueia está sempre em
 * OUTRA campanha do mesmo template, onde ela já foi entregue ou está a caminho.
 * "Tratado nesta campanha" é literalmente verdade — a pessoa recebeu (ou vai
 * receber) o conteúdo, e trazê-la de volta ao próximo lote seria pedir a
 * duplicata que esta guarda acabou de recusar. E não é perda definitiva: os
 * recortes de recuperação (`unreached` e o tick) excluem apenas quem RECEBEU
 * (`REACHED_STATUSES`), e `CANCELLED` não está lá.
 */
export const DUPLICATE_ERROR_CODE = 'duplicate_already_sent';

/**
 * Irmãs que bloqueiam SEMPRE, independentemente de quem nasceu primeiro:
 * `SENT|DELIVERED|READ` (a pessoa já recebeu, ou o provedor já aceitou) e
 * `SENDING` (outro ator JÁ reivindicou a linha e está no provedor agora —
 * assumir que saiu é a única leitura segura).
 */
const DUPLICATE_BLOCKS_ALWAYS: MessageStatus[] = [
  ...REACHED_STATUSES,
  'SENDING',
];

/**
 * Irmãs ainda PARADAS na fila (`QUEUED`/`WAITING_INSTANCE`). Derivado de
 * `REACHED_OR_IN_FLIGHT_STATUSES` de propósito: se um dia nascer um novo status
 * "em voo" lá, ele cai aqui sozinho em vez de virar um furo silencioso.
 *
 * Estas só bloqueiam quando são ANTERIORES a esta linha — ver o cuidado 2 no
 * bloco do topo.
 */
const DUPLICATE_BLOCKS_IF_OLDER: MessageStatus[] =
  REACHED_OR_IN_FLIGHT_STATUSES.filter(
    (s) => !DUPLICATE_BLOCKS_ALWAYS.includes(s),
  );

export function duplicateGuardWhere(args: {
  messageId: string;
  contactId: string;
  campaignId: string;
  templateId: string;
  createdAt: Date;
}): Prisma.MessageWhereInput {
  const sameTemplateOtherCampaign = {
    templateId: args.templateId,
    id: { not: args.campaignId },
  };
  const liveCampaign = {
    ...sameTemplateOtherCampaign,
    status: { not: 'CANCELLED' as const },
  };
  // O DESEMPATE: "esta irmã nasceu ANTES de mim". Determinístico e imutável —
  // depende só de (createdAt, id), nunca do status, que é o que garante que o
  // par sempre tenha exatamente um vencedor mesmo se os dois lados rodarem a
  // guarda no mesmo milissegundo.
  const anterior: Prisma.MessageWhereInput = {
    OR: [
      { createdAt: { lt: args.createdAt } },
      { createdAt: args.createdAt, id: { lt: args.messageId } },
    ],
  };
  return {
    id: { not: args.messageId },
    contactId: args.contactId,
    direction: 'OUTBOUND',
    OR: [
      // Mesma campanha: já recebeu, ou já está no provedor.
      { campaignId: args.campaignId, status: { in: DUPLICATE_BLOCKS_ALWAYS } },
      // Mesma campanha, irmã ainda parada na fila — só a ANTERIOR bloqueia.
      {
        campaignId: args.campaignId,
        status: { in: DUPLICATE_BLOCKS_IF_OLDER },
        ...anterior,
      },
      // Outra campanha VIVA do mesmo template: idem, nas duas réguas.
      {
        campaign: liveCampaign,
        status: { in: DUPLICATE_BLOCKS_ALWAYS },
      },
      {
        campaign: liveCampaign,
        status: { in: DUPLICATE_BLOCKS_IF_OLDER },
        ...anterior,
      },
      // Campanha CANCELADA do mesmo template: o que foi ENTREGUE e o que já
      // está NO PROVEDOR. A MESMA régua do recorte da audiência — ver o bloco
      // do topo para o porquê e para a saída em massa quando o canal morreu.
      {
        campaign: { ...sameTemplateOtherCampaign, status: 'CANCELLED' },
        status: { in: CANCELLED_CAMPAIGN_BLOCKING_STATUSES },
      },
    ],
  };
}
