import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type Campaign,
  type CampaignBatch,
  type FailureReason,
  type Message,
  type MessageStatus,
  CampaignStatus,
  ScheduleType,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { funnelToPartition } from '../whatsapp-providers/zernio-broadcast-counters';
import {
  reachedOrInFlightInCampaign,
  REACHED_OR_IN_FLIGHT_STATUSES,
  REACHED_STATUSES,
} from './batch-audience';
import { buildContactFailureUpdate, classifyFailure } from './failure-reason';
import { INDETERMINATE_DELIVERY_CODES } from './marketing-reachability';

/**
 * O que aconteceu com um "Disparar novamente" nesta mensagem.
 *
 *  • `ok`                   — a linha voltou para a fila.
 *  • `not_redispatchable`   — ela deixou de ser redisparável entre a leitura e
 *                             a escrita (o worker a reivindicou).
 *  • `contact_already_live` — a trava de banco recusou: o MESMO contato já tem
 *                             outra linha viva nesta campanha. Não é erro de
 *                             sistema, é a regra funcionando — e o chamador
 *                             tem de traduzi-la numa recusa explicada, não num
 *                             500.
 */
export type RedispatchResetResult =
  | 'ok'
  | 'not_redispatchable'
  | 'contact_already_live';

/**
 * O mesmo contrato, para o "Reenviar" de uma FALHA (`resetForRetry`).
 *
 *  • `ok`                   — a linha voltou para a fila.
 *  • `not_retryable`        — ela deixou de estar FAILED entre a leitura e a
 *                             escrita (outro operador já a reenviou, ou o
 *                             worker a reivindicou).
 *  • `contact_already_live` — a trava de banco recusou: o MESMO contato já tem
 *                             outra linha viva nesta campanha. É a regra
 *                             funcionando, e o chamador tem de traduzi-la numa
 *                             recusa explicada — nunca num 500.
 */
export type RetryResetResult = 'ok' | 'not_retryable' | 'contact_already_live';

/**
 * ★ I15 — o `errorCode` das linhas que o operador declarou não entregues.
 *
 * Tem um código PRÓPRIO, e não o genérico de canal fora, por três motivos: ele
 * distingue no histórico o que o SISTEMA observou do que o OPERADOR declarou;
 * ele é o que permite auditar depois "quantas foram liberadas na mão, e em qual
 * campanha"; e ele NÃO está em `INDETERMINATE_DELIVERY_CODES` — de propósito,
 * porque o objetivo da liberação é precisamente tornar aquelas pessoas
 * reenviáveis, e um código indeterminado as recusaria no "Reenviar".
 */
export const UNCONFIRMED_SENT_RELEASED_CODE = 'unconfirmed_sent_released';

/**
 * Error codes on a FAILED message whose delivery outcome is UNKNOWN — a
 * client-side timeout (`<provider>.indeterminate` — ANY provider, not just
 * Twilio: the send-message.processor terminalizes a timeout this way for
 * whichever provider sent it, see `INDETERMINATE_TIMEOUTS`) or a worker crash
 * between claim and markSent (`sending_stuck`). Both bulk retry
 * (`retryFailedMessages`/`findFailedMessageIds`) AND a single manual retry
 * (`retryMessage`, below) must refuse these so a possibly-delivered message is
 * never silently re-sent (duplicate delivery + double charge) — an operator
 * clicking "retry" is just as capable of duplicating a delivery as an
 * automatic bulk retry would be.
 *
 * `zernio.timeout`/`gozap.timeout` (the RAW adapter codes, not the
 * `<provider>.indeterminate` terminal) are ALSO in this list — deliberate,
 * not redundant. Before the B3 guard was generalized to every provider, the
 * `@OnWorkerEvent('failed')` handler in send-message.processor.ts wrote the
 * raw code straight to `Message.errorCode` whenever BullMQ exhausted its
 * retries on a Zernio/GoZap timeout (the guard only existed for Twilio, so a
 * Zernio timeout was relaunched, retried 5x, and the FINAL row landed on the
 * raw code — never the terminal). Those legacy rows already exist in prod and
 * carry the exact same maybe-delivered risk as the new terminal rows; see the
 * matching comment on `PERMANENT_RECIPIENT_FAILURE_CODES` in
 * marketing-reachability.ts. `zernio.unreachable` stays OUT — it's a network
 * failure (connection never established), so there's no delivery ambiguity
 * and retrying is correct.
 *
 * C11 — a lista MUDOU DE CASA (marketing-reachability.ts) e é re-exportada
 * daqui para não quebrar os importadores. Ela precisava ser visível para
 * `batch-audience.ts` (que agora exclui da audiência quem tem uma dessas
 * falhas), e este arquivo já importa `batch-audience` — a ida-e-volta fecharia
 * um ciclo de imports.
 */
export { INDETERMINATE_DELIVERY_CODES };

export type CreateCampaignData = {
  name: string;
  templateId: string;
  defaultInstanceId: string;
  segmentId?: string | null;
  filters: Prisma.InputJsonValue;
  variableMap: Prisma.InputJsonValue;
  totalRecipients: number;
  scheduledAt?: Date | null;
  scheduleType?: ScheduleType;
  scheduleConfig?: Prisma.InputJsonValue | null;
  timezone?: string;
  nextRunAt?: Date | null;
  scheduleEnabled?: boolean;
  presenceDelayMs?: number;
  /**
   * "Os N primeiros contatos" da lista filtrada (null = sem limite). PERSISTIDO
   * porque quem materializa a audiência é o DISPARO — um limite que só existisse
   * na prévia deixaria a campanha enfileirar a base inteira.
   */
  limit?: number | null;
  /** C1 — finalidade declarada (FK ConsentPurpose.key); o gate exige consentimento PARA ELA. */
  purposeKey?: string | null;
  /** Reconhecimento de risco anti-ban dos send-checks; como override de consentimento, só em EVOLUTION. */
  override?: boolean;
  overrideJustification?: string | null;
  /** ★ 2026-08-25 — amplia "excluir quem já recebeu" para QUALQUER campanha anterior, não só o mesmo template. */
  excludeAnyPreviousCampaign?: boolean;
  /** ★ 2026-08-25 — respeita a janela de horário de envio (só tem efeito em canal de sessão). */
  respeitarJanelaDeEnvio?: boolean;
};

@Injectable()
export class CampaignsRepository {
  private readonly logger = new Logger(CampaignsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.campaign.findUnique({
      where: { id },
      include: { template: true },
    });
  }

  async listAll() {
    const campaigns = await this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { template: { select: { metaName: true, language: true } } },
    });

    if (campaigns.length === 0) return [];

    const grouped = await this.prisma.message.groupBy({
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      by: ['campaignId', 'status'],
      _count: true,
    });

    const byCampaign = new Map<
      string,
      Array<{ status: string; _count: number }>
    >();
    for (const row of grouped) {
      if (row.campaignId == null) continue;
      const arr = byCampaign.get(row.campaignId) ?? [];
      arr.push({ status: row.status, _count: row._count });
      byCampaign.set(row.campaignId, arr);
    }

    return campaigns.map((c) => ({
      ...c,
      statusCounts: byCampaign.get(c.id) ?? [],
    }));
  }

  /**
   * Apaga a campanha. O CASCADE do schema leva junto as Message (as bolhas do
   * inbox) e os CampaignBatch; ZernioBroadcast.campaignId vira NULL (SetNull), e
   * ConsentEvent — que não tem FK para Campaign e é protegido por trigger — não é
   * tocado. Quem avisa o operador do estrago é a tela, ANTES do clique.
   *
   * ★ O espelho do disparo que sobrevive MUDA DE SEMÂNTICA ao ficar órfão: é o
   * `campaignId` que diz à leitura (ZernioMetricsService) que os contadores são
   * o FUNIL do webhook, e não a partição do painel. Com o SetNull, a linha
   * passaria a ser re-somada como partição — a lida contando duas vezes, os
   * 153% de "entrega" de volta. E não haveria autocorreção: as Message (fonte
   * do webhook) morrem no CASCADE. Por isso os contadores viram partição NO
   * MESMO COMMIT do delete.
   */
  delete(id: string): Promise<Campaign> {
    return this.prisma.$transaction(async (tx) => {
      const mirrors = await tx.zernioBroadcast.findMany({
        where: { campaignId: id },
        select: {
          id: true,
          sentCount: true,
          deliveredCount: true,
          readCount: true,
          failedCount: true,
        },
      });
      for (const m of mirrors) {
        await tx.zernioBroadcast.update({
          where: { id: m.id },
          data: funnelToPartition(m),
        });
      }
      return tx.campaign.delete({ where: { id } });
    });
  }

  create(data: CreateCampaignData): Promise<Campaign> {
    const { scheduleConfig, ...rest } = data;
    return this.prisma.campaign.create({
      data: {
        ...rest,
        scheduledAt: data.scheduledAt ?? null,
        scheduleConfig:
          scheduleConfig === undefined || scheduleConfig === null
            ? Prisma.JsonNull
            : scheduleConfig,
        defaultInstanceId: data.defaultInstanceId,
      },
    });
  }

  /** Find scheduled campaigns due to run at or before `now`. */
  findDueScheduled(now: Date) {
    return this.prisma.campaign.findMany({
      where: {
        scheduleEnabled: true,
        scheduleType: { not: 'IMMEDIATE' },
        nextRunAt: { lte: now, not: null },
      },
      take: 50,
    });
  }

  /**
   * Mark a scheduled campaign as just ran; update lastRunAt and nextRunAt.
   *
   * `totalRecipients` is overwritten with the size of the *current* run, not
   * the cumulative total across all scheduled executions. This matches the
   * column's semantic in this app (the dashboards always read "audience for
   * the most recent dispatch") and avoids a misleading ever-growing count
   * for DAILY/WEEKLY/INTERVAL campaigns. Switch to `{ increment: ... }` if
   * a true accumulator is ever needed.
   *
   * FASE 0: com o tick em modo 'unreached', `totalRecipientsThisRun` é o número
   * de contatos AINDA NÃO ALCANÇADOS nesta execução — não o total da campanha.
   * Já era "o tamanho da execução atual"; a mudança é que agora a execução
   * exclui os recebidos. Nenhum KPI de taxa deve dividir por este campo (ver
   * Fase 3 §3.6).
   */
  async markRan(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date | null,
    totalRecipientsThisRun: number,
  ): Promise<number> {
    // A3 — conditional update guarded on status. runScheduled reads the
    // campaign at the start, dispatches the batch, then calls markRan at the
    // end. If cancel() lands in that window (status→CANCELLED, schedule
    // disabled), a plain `update` here would flip the campaign back to RUNNING
    // and re-enable a recurring schedule — "un-cancelling" it. Excluding
    // CANCELLED from the WHERE makes the racing cancel() the winner: the
    // updateMany matches 0 rows and the campaign stays cancelled. We return
    // the affected-row count so callers can detect "lost the race".
    const result = await this.prisma.campaign.updateMany({
      where: { id, status: { notIn: ['CANCELLED'] } },
      data: {
        lastRunAt,
        nextRunAt,
        // when there's no future run, disable the schedule
        scheduleEnabled: nextRunAt !== null,
        runCount: { increment: 1 },
        totalRecipients: totalRecipientsThisRun,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    return result.count;
  }

  updateStatus(
    id: string,
    status: CampaignStatus,
    fields?: Partial<
      Pick<Campaign, 'startedAt' | 'finishedAt' | 'totalRecipients'>
    >,
  ): Promise<Campaign> {
    return this.prisma.campaign.update({
      where: { id },
      data: { status, ...fields },
    });
  }

  /**
   * Cancel a campaign and disable any pending schedule in a single update.
   * Recurring campaigns (DAILY/WEEKLY/INTERVAL) keep scheduleEnabled=true and
   * a scheduled nextRunAt — without clearing both, findDueScheduled would
   * keep firing them after cancellation.
   */
  cancelAndDisableSchedule(id: string): Promise<Campaign> {
    return this.prisma.campaign.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        finishedAt: new Date(),
        scheduleEnabled: false,
        nextRunAt: null,
      },
    });
  }

  /**
   * Atomic DRAFT -> QUEUED transition. Returns the number of rows updated:
   * 1 if the campaign was in DRAFT and got transitioned, 0 otherwise.
   * Safe under concurrent run() calls — only one caller will see count=1.
   */
  async transitionToQueued(
    id: string,
    totalRecipients: number,
    opts?: { disarmSchedule?: boolean },
  ): Promise<number> {
    const result = await this.prisma.campaign.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        status: 'QUEUED',
        startedAt: new Date(),
        totalRecipients,
        // Firing a one-shot SCHEDULED campaign (ONCE_AT) early via the manual
        // "Disparar" button must also disarm its schedule, or the scheduler
        // re-fires the whole audience at the original nextRunAt = duplicate
        // send. IMMEDIATE campaigns already carry scheduleEnabled=false /
        // nextRunAt=null so this is a no-op for them. RECURRING campaigns
        // (DAILY_AT/WEEKLY/INTERVAL) must KEEP their schedule (disarmSchedule
        // false) so the cadence continues after a manual ad-hoc fire. The
        // scheduler path (runScheduled) uses markRan, not this method.
        ...(opts?.disarmSchedule
          ? { scheduleEnabled: false, nextRunAt: null }
          : {}),
      },
    });
    return result.count;
  }

  countContactsByWhere(where: Prisma.ContactWhereInput): Promise<number> {
    return this.prisma.contact.count({ where });
  }

  /**
   * Is there a campaign currently RUNNING (or QUEUED) on this instance? Used by
   * the OVERLAP send-check. Excludes an optional campaign id (so re-previewing a
   * just-created campaign doesn't flag itself).
   */
  async hasRunningCampaignOnInstance(
    instanceId: string,
    excludeCampaignId?: string,
  ): Promise<boolean> {
    const count = await this.prisma.campaign.count({
      where: {
        defaultInstanceId: instanceId,
        status: { in: ['QUEUED', 'RUNNING'] },
        ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
      },
    });
    return count > 0;
  }

  /**
   * A AMOSTRA da prévia — as pessoas que o operador vê antes de disparar.
   *
   * `orderBy: { id: 'asc' }` NÃO é detalhe: é a MESMA ordem de `findContactsPage`
   * (o disparo). Antes era `createdAt: 'desc'` — a ordem OPOSTA. Enquanto todo
   * mundo recebia, o bug era invisível (os dois conjuntos eram os mesmos, só
   * embaralhados). Com "os N primeiros", a prévia mostraria N pessoas e o disparo
   * mandaria para N pessoas DIFERENTES, do outro extremo da lista — e mandar
   * mensagem para quem não foi escolhido não tem desfazer.
   */
  findContactsByWhere(where: Prisma.ContactWhereInput, take?: number) {
    return this.prisma.contact.findMany({
      where,
      take,
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Recorta a audiência aos N PRIMEIROS contatos, por ORDEM DE CADASTRO.
   *
   * Não dá para implementar isso com `take: N` no disparo: o disparo é paginado
   * por cursor e cada página passa pelo gate de consentimento, então um `take`
   * por página não limita a audiência — e um `take` no total contaria ENVIOS, não
   * contatos (os pulados pelo gate não consomem a cota, e o disparo seguiria
   * varrendo a lista até completar N envios, alcançando gente que o operador NÃO
   * escolheu).
   *
   * O recorte é uma FRONTEIRA: acha o id do N-ésimo contato na ordem do disparo
   * (`id asc`) e devolve a audiência restrita a `id <= esse id`. Vira um
   * predicado comum, que compõe com tudo — o gate, os lotes
   * (`pendingAudienceWhere`) e a contagem da prévia — sem que nenhum deles
   * precise saber que existe um limite.
   *
   * Audiência MENOR que o limite → não existe N-ésimo contato → devolve a
   * audiência intacta. Recortar em `id <= undefined` mandaria para NINGUÉM.
   */
  async applyAudienceLimit(
    where: Prisma.ContactWhereInput,
    limit: number | null | undefined,
  ): Promise<Prisma.ContactWhereInput> {
    if (!limit || limit <= 0) return where;

    const nth = await this.prisma.contact.findMany({
      where,
      orderBy: { id: 'asc' },
      skip: limit - 1,
      take: 1,
      select: { id: true },
    });
    const cutoffId = nth[0]?.id;
    if (!cutoffId) return where;

    return { AND: [where, { id: { lte: cutoffId } }] };
  }

  /**
   * Médio — keyset-paginated audience read for dispatch. The dispatch paths used
   * to `findMany` the WHOLE audience into one array (50k+ full rows on the HTTP
   * thread). This pages by `id` (cuid, unique → stable, gap-free cursor) and
   * selects ONLY the columns the caller needs (id + the variableMap fields), so
   * memory stays bounded regardless of audience size while still enqueueing
   * every recipient.
   *
   * `orderBy id asc` + `cursor`/`skip:1` is the canonical Prisma keyset pattern.
   * Ordering on the unique `id` (not `createdAt`, which isn't unique) guarantees
   * no row is skipped or seen twice across pages.
   */
  findContactsPage<T extends Prisma.ContactSelect>(
    where: Prisma.ContactWhereInput,
    opts: { select: T; take: number; cursorId?: string },
  ) {
    return this.prisma.contact.findMany({
      where,
      select: opts.select,
      orderBy: { id: 'asc' },
      take: opts.take,
      ...(opts.cursorId ? { cursor: { id: opts.cursorId }, skip: 1 } : {}),
    });
  }

  findContactById(id: string) {
    return this.prisma.contact.findUnique({ where: { id } });
  }

  groupMessagesByStatus(campaignId: string) {
    return this.prisma.message.groupBy({
      where: { campaignId },
      by: ['status'],
      _count: true,
    });
  }

  /**
   * When a campaign is cancelled, flip every still-pending message to
   * CANCELLED so the campaign metrics reflect reality and a future
   * worker-pickup (race window) finds the row already terminal.
   * Returns the row count for audit-logging purposes.
   */
  cancelQueuedMessages(campaignId: string): Promise<number> {
    return this.prisma.message
      .updateMany({
        // `WAITING_INSTANCE` entra junto com `QUEUED`: as duas são FILA — a
        // primeira esperando o canal voltar, a segunda esperando o worker.
        // Deixá-la de fora fazia uma campanha cancelada exibir "N aguardando
        // conexão" para sempre e, se o canal voltasse, o replay enfileirava
        // mensagens de uma campanha morta só para o worker as descartar.
        where: { campaignId, status: { in: ['QUEUED', 'WAITING_INSTANCE'] } },
        data: { status: 'CANCELLED', errorCode: 'campaign_cancelled' },
      })
      .then((r) => r.count);
  }

  /**
   * Paginated message list for campaign detail view. Includes contact info
   * (name, phone) since the UI table renders it on every row.
   */
  async listMessages(args: {
    campaignId: string;
    page: number;
    pageSize: number;
    // MessageStatus inteiro (e não uma união literal escrita à mão): a lista
    // curta escondia justamente os SKIPPED_*, e o filtro "Sem consentimento" do
    // frontend voltava 400.
    status?: MessageStatus;
    search?: string;
  }) {
    const where: Prisma.MessageWhereInput = {
      campaignId: args.campaignId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.search
        ? {
            contact: {
              OR: [
                { name: { contains: args.search, mode: 'insensitive' } },
                { phoneE164: { contains: args.search } },
              ],
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              name: true,
              phoneE164: true,
              optedOut: true,
              city: true,
              tags: true,
              profilePictureUrl: true,
            },
          },
        },
        orderBy: [
          { failedAt: 'desc' },
          { sentAt: 'desc' },
          { queuedAt: 'desc' },
        ],
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
      }),
      this.prisma.message.count({ where }),
    ]);

    return { items, total, page: args.page, pageSize: args.pageSize };
  }

  findMessageById(id: string) {
    return this.prisma.message.findUnique({
      where: { id },
      include: { campaign: true },
    });
  }

  /**
   * As linhas FAILED que o "Reenviar falhas" pode reenfileirar.
   *
   * `sameTemplateBlock` é o predicado das campanhas IRMÃS do mesmo template
   * (`sameTemplateBlockFilter`), ou `null` quando não há irmã. Ele entra aqui
   * porque o retry em massa era o único caminho de reenvio que NUNCA consultava
   * a regra "ninguém recebe o mesmo template duas vezes" (C2, auditoria
   * 2026-08-19): a campanha B falha para K, a campanha A (mesmo template)
   * entrega a K depois, e o clique em "Reenviar falhas" de B mandava de novo.
   *
   * `null` NÃO vira `none: {}` de propósito — um `none` vazio é verdadeiro para
   * todo mundo e excluiria a campanha inteira (mesmo motivo documentado em
   * `sameTemplateBlockFilter`).
   */
  findFailedMessageIds(
    campaignId: string,
    sameTemplateBlock?: Prisma.MessageWhereInput | null,
  ) {
    // Fase 0 §0.4 — não reenviar quem já tem uma irmã ENTREGUE ou EM VOO
    // nesta campanha: a falha desta linha é irrelevante se a pessoa já
    // recebeu (ou está para). `is` é CRÍTICO — uma Message com
    // contactId null não pertence a contato nenhum, e `contact: { is }`
    // a exclui corretamente em vez de dar match espúrio.
    const naCampanha: Prisma.ContactWhereInput = {
      messages: { none: reachedOrInFlightInCampaign(campaignId) },
    };
    const contato: Prisma.ContactWhereInput = sameTemplateBlock
      ? { AND: [naCampanha, { messages: { none: sameTemplateBlock } }] }
      : naCampanha;

    return this.prisma.message.findMany({
      // Exclude INDETERMINATE failures (a timeout or a mid-send worker crash: we
      // don't know if the provider actually accepted+delivered the message).
      // Auto-resending those risks a duplicate WhatsApp delivery + double charge,
      // the exact failure this pipeline guards against. An operator can still
      // resend a specific one deliberately from the UI after checking.
      where: {
        campaignId,
        status: 'FAILED',
        errorCode: { notIn: INDETERMINATE_DELIVERY_CODES },
        // C10 — o `distinct` abaixo precisa de um contactId não-nulo para
        // significar alguma coisa: sem isto, todas as linhas órfãs colapsariam
        // numa só (e nenhuma delas tem para quem reenviar).
        contactId: { not: null },
        contact: { is: contato },
      },
      select: { id: true, contactId: true },
      // C10 — UMA linha POR CONTATO, não uma por falha. O retry em massa itera
      // sobre o que este método devolve e reseta+enfileira cada linha dentro do
      // MESMO Promise.all; um contato com duas FAILED transitórias (lote 1
      // falhou, lote 2 recriou a linha e falhou também) recebia DOIS envios
      // reais. Deduplicar DEPOIS, dentro do laço, seria corrida pura — as duas
      // irmãs viram QUEUED ao mesmo tempo. A mais recente é a que representa o
      // contato, e é também a que o contador do botão já conta
      // (`countUnreachedFailedContacts`, que sempre foi por contato distinto).
      orderBy: { createdAt: 'desc' },
      distinct: ['contactId'],
    });
  }

  /**
   * Este contato casa um predicado de bloqueio (tipicamente o das campanhas
   * IRMÃS do mesmo template)? Usado pelo retry de UMA mensagem, que antes só
   * enxergava a própria campanha (N3/C2).
   */
  async hasBlockingSibling(
    block: Prisma.MessageWhereInput,
    contactId: string,
  ): Promise<boolean> {
    const count = await this.prisma.message.count({
      where: { ...block, contactId },
    });
    return count > 0;
  }

  /**
   * Contatos com falha retryável que AINDA não foram alcançados/estão em voo
   * nesta campanha — o N do botão "Reenviar falhas (N)".
   *
   * `sameTemplateBlock` é o MESMO predicado que `findFailedMessageIds` recebe, e
   * pela mesma razão: este número existe para dizer o que o clique VAI fazer.
   * Depois que o reenvio passou a respeitar a regra do mesmo template (C2),
   * contar sem ela prometeria N e enviaria menos — a prévia mentindo.
   */
  async countUnreachedFailedContacts(
    campaignId: string,
    sameTemplateBlock?: Prisma.MessageWhereInput | null,
  ): Promise<number> {
    const naCampanha: Prisma.ContactWhereInput = {
      messages: { none: reachedOrInFlightInCampaign(campaignId) },
    };
    const rows = await this.prisma.message.findMany({
      where: {
        campaignId,
        status: 'FAILED',
        errorCode: { notIn: INDETERMINATE_DELIVERY_CODES },
        contactId: { not: null },
        contact: {
          is: sameTemplateBlock
            ? { AND: [naCampanha, { messages: { none: sameTemplateBlock } }] }
            : naCampanha,
        },
      },
      select: { contactId: true },
      distinct: ['contactId'],
    });
    return rows.length;
  }

  /**
   * O contato já foi ALCANÇADO (SENT/DELIVERED/READ) ou está EM VOO
   * (QUEUED/SENDING/WAITING_INSTANCE) nesta campanha? Usado pelo retry de UMA
   * mensagem (`retryMessage`): reenviar por cima de uma irmã já entregue ou a
   * caminho duplicaria a entrega.
   */
  async hasReachedOrInFlightSibling(
    campaignId: string,
    contactId: string,
    /**
     * ★ C12 (2ª rodada) — a linha que o operador CLICOU não é irmã dela mesma.
     *
     * `redispatchMessage` redispara linhas que podem estar em
     * SENT/DELIVERED/READ — estados que este próprio predicado casa. Sem
     * excluir o id clicado, "disparar novamente" numa mensagem ENTREGUE se
     * auto-bloquearia, respondendo "este contato já recebeu" sobre a linha que
     * o operador acabou de apontar. O retry de FALHA (`retryMessage`) não passa
     * nada aqui: a linha dele é FAILED e nunca casa o predicado.
     */
    excludeMessageId?: string,
  ): Promise<boolean> {
    const count = await this.prisma.message.count({
      where: {
        ...reachedOrInFlightInCampaign(campaignId),
        contactId,
        ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}),
      },
    });
    return count > 0;
  }

  /**
   * Reset a message to QUEUED so it can be re-sent.
   *
   * F2 — NÃO apaga mais errorCode/errorMessage/failedAt/failureReason: a linha
   * volta para QUEUED, mas a prova da falha ANTERIOR precisa sobreviver caso
   * este retry falhe de novo antes de qualquer novo dado chegar (ex.: o
   * operador olhando a lista enquanto o job ainda não rodou). `markSent` é
   * quem limpa essa prova — SÓ no sucesso, nunca na tentativa.
   */
  /**
   * ★ I8 (revisão de integração, 2026-08-19) — AS DUAS TRANCAS QUE O GÊMEO JÁ
   * TINHA E ESTE CAMINHO NÃO.
   *
   * Era um `update` por id, incondicional e sem `try/catch`. Faltavam as duas
   * defesas que `resetForRedispatch` (logo abaixo) ganhou na mesma auditoria:
   *
   *  1. ESCRITA CONDICIONAL (`status: 'FAILED'` no `where`). A leitura do
   *     serviço é TOCTOU: entre ela e esta escrita outro operador pode ter
   *     reenviado a mesma linha, ou o worker pode tê-la reivindicado. Um
   *     `update` por id puro atropelava esse estado; o `updateMany` escopado
   *     devolve `not_retryable` e o serviço recusa com explicação.
   *
   *  2. O P2002 TRADUZIDO. `QUEUED` está DENTRO do predicado do índice único
   *     parcial `Message_campaign_contact_live_key`, então mover esta linha para
   *     QUEUED é ILEGAL se o mesmo contato já ganhou outra linha viva nesta
   *     campanha. A janela é real e não é teórica: o serviço pergunta, o clique
   *     fica preso no lock enquanto um `dispatchAudience` roda, o dispatch cria
   *     a linha viva e solta o lock, e só então o retry escreve. Provado contra
   *     Postgres real: `P2002 Unique constraint failed on the fields:
   *     (campaignId, contactId)` — que subia cru como 500 "An unexpected error
   *     occurred" num botão que o operador clica o tempo todo DURANTE um
   *     disparo.
   */
  async resetForRetry(id: string): Promise<RetryResetResult> {
    try {
      const { count } = await this.prisma.message.updateMany({
        where: { id, status: 'FAILED' },
        data: {
          status: 'QUEUED',
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
        },
      });
      return count > 0 ? 'ok' : 'not_retryable';
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return 'contact_already_live';
      }
      throw e;
    }
  }

  /**
   * "Disparar novamente" no card de UMA mensagem: devolve à fila A PRÓPRIA linha,
   * com as variáveis reavaliadas e o canal atual da campanha.
   *
   * Antes, esse botão chamava `createMessage` e criava uma linha NOVA para um
   * contato que já tinha a dele. O resultado em produção foi o "3 de 2": o
   * denominador da campanha conta CONTATOS (`totalRecipients`), o numerador conta
   * LINHAS DE MENSAGEM. Um contato já pulado ganhava uma 2ª linha, o worker
   * reavaliava o gate e a virava SKIPPED de novo → 3 linhas puladas para 2
   * contatos, e uma barra de distribuição em 150%.
   *
   * Reaproveitar a linha é a correção na RAIZ, e não um clamp no gráfico: mantém
   * a invariante "uma linha por contato por campanha", que é o que impede pulados
   * (mensagens) e destinatários (contatos) de divergirem. É também o que o
   * operador pediu — ele clicou em "disparar novamente" NAQUELA mensagem.
   *
   * Difere de `resetForRetry` (retry de FALHA, que preserva o conteúdo) por
   * também regravar `variables` e `instanceId`: um redisparo relê o contato, que
   * pode ter sido corrigido desde então, e o canal da campanha pode ter mudado.
   */
  /**
   * ★ C12 (auditoria 2026-08-19) — ESCRITA CONDICIONAL, e devolve o count.
   *
   * Era um `update` por id, incondicional: uma linha que o worker estava
   * enviando NAQUELE instante (SENDING, janela de minutos no broadcast do
   * Zernio) voltava para QUEUED, um segundo worker a reivindicava — o claim
   * atômico só protege `{ id, status: 'QUEUED' }` e agora ela ERA QUEUED — e o
   * contato recebia duas vezes a partir de UMA linha. QUEUED e
   * WAITING_INSTANCE entram na guarda porque redisparar quem já está na fila só
   * produziria um job redundante.
   *
   * Devolve `count` (0 = não pegou) porque a guarda de intenção do serviço, por
   * si só, é TOCTOU: entre ler a mensagem e reescrevê-la o worker pode
   * reivindicá-la.
   */
  async resetForRedispatch(
    id: string,
    data: { instanceId: string; variables: Prisma.InputJsonValue },
  ): Promise<RedispatchResetResult> {
    try {
      const { count } = await this.prisma.message.updateMany({
        where: {
          id,
          status: { notIn: ['SENDING', 'QUEUED', 'WAITING_INSTANCE'] },
        },
        data: {
          status: 'QUEUED',
          instanceId: data.instanceId,
          variables: data.variables,
          // F2 — errorCode/errorMessage/failedAt/failureReason NÃO são zerados
          // aqui (ver resetForRetry): a prova da falha anterior sobrevive até o
          // markSent do sucesso.
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
          // ★ DESLIGA O DISPARO ANTIGO DO ZERNIO.
          //
          // A linha continuava apontada para o `ZernioBroadcast` que a enviou
          // da vez passada. `zernio-broadcast-poll.service.ts` seleciona as
          // mensagens POR `zernioBroadcastId` e escreve o status por id, sem
          // olhar o estado atual: enquanto aquele disparo ainda estivesse sendo
          // pollado, ele virava esta linha de volta para SENT/DELIVERED — e aí
          // o novo envio nem saía, porque `claimForSend` exige QUEUED e falha
          // em silêncio. A janela é estreita; o preço de fechá-la é uma linha.
          zernioBroadcastId: null,
          queuedAt: new Date(),
        },
      });
      return count > 0 ? 'ok' : 'not_redispatchable';
    } catch (e) {
      // ★ C12 (2ª rodada) — A SEGUNDA TRANCA, E A QUE EVITA O 500.
      //
      // O índice único parcial "uma linha viva por (campanha, contato)" recusa
      // mover ESTA linha para QUEUED se o mesmo contato já tem outra viva na
      // campanha — o caso normal da retomada por lotes (o lote 1 falhou, o
      // lote 2 recriou a linha). O serviço pergunta antes, mas essa pergunta é
      // TOCTOU: entre ela e este UPDATE outro ator pode criar a linha viva.
      // Deixar o P2002 subir cru custava um 500 genérico ("An unexpected error
      // occurred") num botão que o operador clica o tempo todo.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return 'contact_already_live';
      }
      throw e;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ I15 (revisão de integração) — "O CANAL MORREU: ESTAS NUNCA CHEGARAM."
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * O PROBLEMA. Desde o C14, uma campanha CANCELADA bloqueia também o `SENT`
   * (`CANCELLED_CAMPAIGN_BLOCKING_STATUSES`), e a régua está certa: cancelar não
   * cancela o que já está NO PROVEDOR — aquelas pessoas vão receber. Só que o
   * caminho de recuperação que ESTE cliente mais usa é exatamente o oposto: o
   * número é banido no meio do disparo (já aconteceu várias vezes), o operador
   * CANCELA a campanha e recria em outro canal. Nos canais sem polling de status
   * (Zernio/GoZap/Evolution) `SENT` é justamente onde a mensagem FICA PRESA
   * quando o número cai — ela nunca vira `DELIVERED`. Com a régua nova, todo
   * mundo que ficou em `SENT` naquela campanha morta fica INALCANÇÁVEL para
   * aquele template, nas quatro camadas.
   *
   * A ÚNICA válvula que existia era o "Disparar novamente" NESTA mensagem: uma
   * linha por clique. Para 13.000 pessoas isso não é uma saída.
   *
   * A PERGUNTA CERTA, E QUEM SABE RESPONDER. As duas situações são
   * indistinguíveis pelo banco e opostas na consequência:
   *
   *   • o dono cancelou porque MUDOU DE IDEIA → as `SENT` chegaram → bloquear
   *     está certo, e liberar mandaria a mesma propaganda duas vezes;
   *   • o dono cancelou porque O CANAL MORREU → as `SENT` nunca chegaram →
   *     bloquear queima aquele template para aquelas pessoas, para sempre.
   *
   * Só quem cancelou sabe. Então o sistema PERGUNTA, em vez de adivinhar: este
   * par de métodos é o mecanismo, e a decisão continua sendo do dono, dita
   * explicitamente e registrada no audit.
   *
   * O QUE A LIBERAÇÃO FAZ, E O QUE ELA NÃO TOCA:
   *
   *   • só `SENT`, e só `OUTBOUND`. `DELIVERED`/`READ` são prova de chegada e
   *     NUNCA são tocados — nem por engano, nem a pedido;
   *   • as linhas viram `FAILED` com `failureReason: CANAL_FORA` e um
   *     `errorCode` próprio, então elas aparecem na aba de Falhas com o motivo
   *     legível, em vez de sumirem;
   *   • `sentAt` é PRESERVADO: a linha de fato saiu para o provedor, e apagar
   *     isso seria reescrever a história. O que mudou é a leitura do desfecho;
   *   • `FAILED` não bloqueia em camada NENHUMA (nem no recorte da audiência,
   *     nem nas duas guardas do instante do envio) — é exatamente por isso que
   *     este é o estado de destino: a pessoa volta a ser alcançável pelo mesmo
   *     template, por qualquer caminho, sem exceção especial em lugar nenhum.
   */
  countUnconfirmedSent(campaignId: string): Promise<number> {
    return this.prisma.message.count({
      where: { campaignId, direction: 'OUTBOUND', status: 'SENT' },
    });
  }

  /**
   * Executa a liberação. Devolve quantas linhas de fato mudaram — e é esse
   * número (não o da prévia) que vai para o audit e para a tela: entre a prévia
   * e o clique, um webhook atrasado pode ter virado algumas para `DELIVERED`, e
   * essas ficam de fora, como devem.
   */
  async releaseUnconfirmedSent(
    campaignId: string,
    at: Date = new Date(),
  ): Promise<number> {
    const { count } = await this.prisma.message.updateMany({
      // A MESMA condição da contagem, reavaliada AGORA. `status: 'SENT'` no
      // `where` é o que garante que uma linha que virou DELIVERED no meio do
      // caminho não seja rebaixada a FALHA.
      where: { campaignId, direction: 'OUTBOUND', status: 'SENT' },
      data: {
        status: 'FAILED',
        errorCode: UNCONFIRMED_SENT_RELEASED_CODE,
        errorMessage:
          'Entrega não confirmada: a campanha foi cancelada por falha do canal e ' +
          'esta mensagem nunca teve confirmação de entrega. Liberada pelo operador ' +
          'para poder ser reenviada por outro canal.',
        failureReason: 'CANAL_FORA',
        failedAt: at,
      },
    });
    return count;
  }

  /**
   * ★ UMA LINHA VIVA POR (CAMPANHA, CONTATO) — o lado TypeScript da trava.
   *
   * O banco tem um índice único PARCIAL sobre (campaignId, contactId) restrito
   * a OUTBOUND e aos estados em que uma segunda linha vira uma segunda ENTREGA
   * (`REACHED_OR_IN_FLIGHT_STATUSES`) — ver a migration
   * `20260819010000_message_one_live_row_per_campaign_contact`. Este método é
   * quem sabe o que fazer quando a linha já existe:
   *
   *   • EM VOO (QUEUED/SENDING/WAITING_INSTANCE) → `null`. A mensagem já está a
   *     caminho; criar outra é o defeito, não a correção.
   *   • JÁ RECEBEU (SENT/DELIVERED/READ) → `null`, a não ser que o chamador
   *     tenha pedido `resendReached`, que é o botão "Disparar novamente para
   *     TODOS": aí é a MESMA linha que volta para QUEUED. O operador continua
   *     vendo o botão fazer o que promete; o que muda é que a campanha não
   *     ganha uma segunda linha para a mesma pessoa.
   *   • NADA VIVO (só FAILED/CANCELLED/SKIPPED_*) → cria, como sempre. É o que
   *     mantém a retomada por lotes: quem teve falha transitória volta.
   *
   * `null` no retorno significa "não há mensagem a enfileirar" — o chamador NÃO
   * pode publicar job.
   *
   * ⚠️ Ressuscitar uma linha ENTREGUE apaga `sentAt`/`deliveredAt`/`readAt`/
   * `providerMessageId` dela: eles passam a descrever a NOVA tentativa. É o
   * preço de "uma linha por pessoa por campanha" no reenvio total, e foi a
   * decisão explícita do dono; a prova do envio anterior sobrevive no log de
   * auditoria da campanha, não na linha.
   */
  async createMessage(data: {
    campaignId: string;
    contactId: string;
    instanceId: string;
    variables: Prisma.InputJsonValue;
    /** ZE — o lote que gerou esta mensagem (null fora do fluxo de lotes). */
    campaignBatchId?: string | null;
    /** "Disparar novamente para TODOS": ressuscita a linha de quem já recebeu. */
    resendReached?: boolean;
  }): Promise<Message | null> {
    const viva = await this.prisma.message.findFirst({
      where: {
        campaignId: data.campaignId,
        contactId: data.contactId,
        direction: 'OUTBOUND',
        status: { in: REACHED_OR_IN_FLIGHT_STATUSES },
      },
      select: { id: true, status: true },
    });

    if (viva) {
      const emVoo =
        viva.status === 'QUEUED' ||
        viva.status === 'SENDING' ||
        viva.status === 'WAITING_INSTANCE';
      if (emVoo || !data.resendReached) return null;

      // Condicional: entre a leitura e agora um webhook pode ter mexido na
      // linha. `count === 0` = alguém chegou primeiro; não há o que enfileirar.
      const { count } = await this.prisma.message.updateMany({
        where: { id: viva.id, status: { in: REACHED_STATUSES } },
        data: {
          status: 'QUEUED',
          instanceId: data.instanceId,
          variables: data.variables,
          // O vínculo com o lote SÓ é reescrito quando há um lote NOVO. Gravar
          // `null` fora do fluxo de lotes arrancava a linha do lote que a
          // produziu — um CampaignBatch já fechado perdia uma linha da própria
          // contagem histórica, para trás, sem que ninguém tivesse pedido.
          ...(data.campaignBatchId
            ? { campaignBatchId: data.campaignBatchId }
            : {}),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
          // Mesmo motivo do resetForRedispatch: a linha ressuscitada não pode
          // continuar pendurada no disparo ANTIGO do Zernio, senão o poll dele
          // a vira de volta para SENT/DELIVERED e o novo envio morre calado.
          zernioBroadcastId: null,
          queuedAt: new Date(),
        },
      });
      if (count === 0) return null;
      return this.prisma.message.findUnique({ where: { id: viva.id } });
    }

    try {
      return await this.prisma.message.create({
        data: {
          campaignId: data.campaignId,
          contactId: data.contactId,
          instanceId: data.instanceId,
          variables: data.variables,
          status: 'QUEUED',
          campaignBatchId: data.campaignBatchId ?? null,
        },
      });
    } catch (e) {
      // A leitura acima é TOCTOU por natureza; o índice único do banco é a
      // palavra final. Perder essa corrida significa que OUTRO ator já criou a
      // linha viva deste contato — exatamente o resultado que queríamos. Não é
      // erro de disparo: é a trava funcionando, e derrubar a página inteira por
      // causa dela deixaria os outros 499 contatos sem mensagem.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `createMessage(${data.campaignId}/${data.contactId}): a trava de banco recusou uma segunda linha viva para este contato — nada foi enfileirado.`,
        );
        return null;
      }
      throw e;
    }
  }

  /**
   * T8 — linha de contabilização do gate de opt-in (canal TWILIO): o contato
   * não tem optInAt e a campanha não tem override, então NENHUM job é
   * enfileirado para ele. Status terminal SKIPPED_NO_OPTIN — aparece nos
   * statusCounts da campanha como os demais, sem nunca passar pelo worker.
   */
  /**
   * C1 — linha terminal de contabilização do gate (nunca enfileirada).
   *
   * `suppressed` e `no_consent` são estados DIFERENTES e o operador precisa
   * distingui-los: o primeiro é uma revogação (absoluta, não há o que fazer), o
   * segundo é ausência de consentimento (resolvível coletando opt-in). Colapsar
   * os dois num status só esconderia justamente a métrica que diz se a coleta
   * está funcionando.
   */
  async createSkippedMessage(data: {
    campaignId: string;
    contactId: string;
    instanceId: string;
    reason: 'no_consent' | 'suppressed';
    /** ZE — o lote em que o gate avaliou (e recusou) este contato. */
    campaignBatchId?: string | null;
  }): Promise<Message> {
    const suppressed = data.reason === 'suppressed';
    const payload = {
      campaignBatchId: data.campaignBatchId ?? null,
      instanceId: data.instanceId,
      status: suppressed
        ? ('SKIPPED_SUPPRESSED' as const)
        : ('SKIPPED_NO_CONSENT' as const),
      errorCode: suppressed ? 'suppressed' : 'no_consent',
      errorMessage: suppressed
        ? 'Contato pediu para não receber mais mensagens (opt-out). Revogação é absoluta — nem override envia.'
        : 'Contato sem consentimento ativo para a finalidade desta campanha. Colete o opt-in (link/QR, landing, presencial) antes de enviar.',
    };

    // UMA linha de pulo por contato POR CAMPANHA — não uma por avaliação.
    //
    // "Disparar novamente" reavalia a AUDIÊNCIA INTEIRA (redispatchCampaign usa
    // o `where` dos filtros, não o `pendingWhere`) — e reavaliar é o certo: quem
    // consentiu no intervalo passa a receber. O que NÃO pode é a reavaliação
    // EMPILHAR linhas: os pulados são contados em MENSAGENS nos KPIs e em
    // CONTATOS na aba "Pulados". Com uma 2ª linha por contato, o operador que
    // clicasse "Disparar novamente" (a reação óbvia a uma campanha 100% pulada)
    // veria "4 de 2 destinatários foram pulados" — o número que existe para
    // EXPLICAR o bug viraria ele próprio um absurdo.
    //
    // Sobrescrever é seguro: a linha antiga nunca foi enviada, e o motivo/lote
    // atualizados são a decisão MAIS RECENTE do gate para este contato.
    const existing = await this.prisma.message.findFirst({
      where: {
        campaignId: data.campaignId,
        contactId: data.contactId,
        status: {
          in: ['SKIPPED_NO_CONSENT', 'SKIPPED_SUPPRESSED', 'SKIPPED_NO_OPTIN'],
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return this.prisma.message.update({
        where: { id: existing.id },
        data: { ...payload, queuedAt: new Date() },
      });
    }

    return this.prisma.message.create({
      data: {
        campaignId: data.campaignId,
        contactId: data.contactId,
        ...payload,
      },
    });
  }

  /**
   * C1 — contatos com JANELA DE ATENDIMENTO aberta neste canal (último inbound
   * depois de `since`). A janela autoriza CONVERSAR, nunca fazer campanha de
   * marketing: só o gate da finalidade *utility* a consulta (spec §4.3.4).
   */
  async findContactsWithOpenWindow(
    contactIds: string[],
    instanceId: string,
    since: Date,
  ): Promise<Set<string>> {
    if (contactIds.length === 0) return new Set();
    const rows = await this.prisma.conversation.findMany({
      where: {
        contactId: { in: contactIds },
        instanceId,
        lastInboundAt: { gt: since },
      },
      select: { contactId: true },
    });
    return new Set(
      rows.map((r) => r.contactId).filter((id): id is string => id !== null),
    );
  }

  /**
   * Mark a message as FAILED because the BullMQ enqueue itself failed
   * (e.g. Redis outage). Without this, the row would sit in QUEUED forever
   * with no worker job to pick it up.
   *
   * U4 — callers that hold a classified code (e.g. a DomainError.code) may
   * pass it as `errorCode`; without one, the generic 'enqueue_failed' bucket
   * is preserved.
   *
   * SÓ chame com a linha em QUEUED. O `add` do BullMQ pode estourar DEPOIS de
   * o job entrar na fila; marcar FAILED por cima de uma linha já reivindicada
   * carimbaria "falhou" numa mensagem enviada (e cobrada), que o "Reenviar
   * falhas" duplicaria. Devolve o count: 0 = a linha já não era QUEUED
   * (outro ator a levou).
   */
  async markMessageEnqueueFailed(
    messageId: string,
    errorMessage: string,
    errorCode?: string,
  ): Promise<number> {
    const code = errorCode ?? 'enqueue_failed';
    const { count } = await this.prisma.message.updateMany({
      where: { id: messageId, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        errorCode: code,
        errorMessage,
        failedAt: new Date(),
        failureReason: classifyFailure(code),
      },
    });
    return count;
  }

  /**
   * A2 — atomic send claim. Flip a still-QUEUED message to SENDING *before*
   * calling the provider. Returns the affected-row count:
   *   1 → this attempt owns the send and must call wa.send + markSent
   *   0 → another attempt already claimed/sent it → SKIP (do NOT send)
   *
   * This is the duplicate-send guard: even if BullMQ retries (attempts>1)
   * after a successful send, or a worker crashes mid-pipeline and the job is
   * re-promoted, only one attempt can ever transition QUEUED→SENDING, so
   * wa.send runs at most once per message row.
   */
  async claimForSend(messageId: string): Promise<number> {
    const result = await this.prisma.message.updateMany({
      where: { id: messageId, status: 'QUEUED' },
      // Stamp sendingAt so the reconciler can measure time-IN-SENDING rather
      // than time-since-creation (queuedAt is fixed and would falsely flag a
      // message that legitimately waited out a long pacing/daily-limit delay).
      data: { status: 'SENDING', sendingAt: new Date() },
    });
    return result.count;
  }

  /**
   * A2 — return a claimed (SENDING) row to QUEUED. Used when wa.send throws a
   * retryable error: the claim must be released so BullMQ's retry can re-claim
   * and re-send. Scoped to status:'SENDING' so it never clobbers a row that
   * already advanced to a terminal/other state.
   */
  async releaseClaim(messageId: string): Promise<number> {
    const result = await this.prisma.message.updateMany({
      where: { id: messageId, status: 'SENDING' },
      data: { status: 'QUEUED' },
    });
    return result.count;
  }

  /**
   * A2 — complete the claim by transitioning the SENDING row to SENT. Scoped
   * to status:'SENDING' (updateMany) so it only ever flips the row this
   * attempt claimed; a duplicate attempt that lost the claim owns no SENDING
   * row and is a harmless no-op.
   */
  async markSent(args: {
    messageId: string;
    instanceId: string;
    providerMessageId?: string;
    sentAt?: Date;
    /**
     * BOLHA VAZIA — o corpo RENDERIZADO que a pessoa leu. Vem junto na mesma
     * transição SENDING→SENT (o worker já tem o texto na mão no ato do envio):
     * sem isto a Message ia para o banco com `content` NULL e o Inbox mostrava
     * uma bolha só com hora e ticks. `undefined` é OMISSÃO no Prisma — o retry
     * best-effort do catch, que não repassa o texto, nunca apaga o que já foi
     * gravado.
     */
    content?: string;
    /**
     * F2 — quando presente, limpa best-effort as flags de falha DURÁVEIS do
     * Contact (lastFailureReason/Code/At) no mesmo commit lógico do sucesso:
     * é aqui que a prova morre, não na tentativa (resetForRetry/
     * resetForRedispatch preservam). `failureCount` PERMANECE — é
     * monotônico, sobrevive ao sucesso (sinal "este contato dá trabalho").
     */
    contactId?: string | null;
  }): Promise<void> {
    await this.prisma.message.updateMany({
      where: { id: args.messageId, status: 'SENDING' },
      data: {
        status: 'SENT',
        instanceId: args.instanceId,
        providerMessageId: args.providerMessageId,
        sentAt: args.sentAt ?? new Date(),
        content: args.content,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        failureReason: null,
      },
    });

    if (args.contactId) {
      const contactId = args.contactId;
      await this.prisma.contact
        .update({
          where: { id: contactId },
          data: {
            lastFailureReason: null,
            lastFailureCode: null,
            lastFailureAt: null,
          },
        })
        .catch((e) =>
          this.logger.warn(
            { err: e, contactId },
            'F2: falha ao limpar flag durável de falha do contato após sucesso (best-effort)',
          ),
        );
    }
  }

  /**
   * A2 reconciler — find rows stranded in SENDING (a worker crashed between
   * claim and markSent). Stuck = entered SENDING (sendingAt) longer ago than
   * `cutoff`. We measure from `sendingAt` (set at claim time), NOT `queuedAt`
   * (creation time, fixed across long pacing/daily-limit delays) — otherwise a
   * message that legitimately waited >threshold before sending would be flagged
   * the instant it entered SENDING and FAILED mid-send.
   */
  findStuckSending(cutoff: Date, take: number) {
    return this.prisma.message.findMany({
      where: { status: 'SENDING', sendingAt: { lt: cutoff } },
      select: { id: true, campaignId: true },
      take,
    });
  }

  /**
   * A2 reconciler — recover a stuck SENDING row. We mark it FAILED (not
   * re-QUEUED): a crash between claim and markSent means we do NOT know whether
   * the provider actually accepted the message, so re-queueing risks a real
   * duplicate WhatsApp send — the exact failure A2 exists to prevent. FAILED is
   * the safe terminal state; an operator can deliberately retry from the UI.
   * Scoped to status:'SENDING' so a markSent that wins the race (the row
   * already moved to SENT) is left untouched — returns 0 in that case.
   */
  async recoverStuckSending(messageId: string): Promise<number> {
    const result = await this.prisma.message.updateMany({
      where: { id: messageId, status: 'SENDING' },
      data: {
        status: 'FAILED',
        errorCode: 'sending_stuck',
        errorMessage:
          'Recuperada pelo reconciler: presa em SENDING (provável crash do worker entre o claim e o markSent).',
        failedAt: new Date(),
        failureReason: classifyFailure('sending_stuck'),
      },
    });
    return result.count;
  }

  /**
   * F2 — agregação `[{failureReason, count}]` das Messages FAILED de UMA
   * campanha. Alimenta o endpoint GET /campaigns/:id/failure-reasons (T7).
   * Histórico anterior ao F2 tem `failureReason` NULL (sem backfill) — a
   * própria linha do groupBy vem com `failureReason: null` nesse caso, o
   * chamador decide como rotular.
   */
  async groupFailuresByReason(
    campaignId: string,
  ): Promise<{ failureReason: FailureReason | null; count: number }[]> {
    const rows = await this.prisma.message.groupBy({
      by: ['failureReason'],
      where: { campaignId, status: 'FAILED' },
      _count: true,
    });
    return rows.map((row) => ({
      failureReason: row.failureReason,
      count: row._count,
    }));
  }

  /**
   * Status reconciler (B4) — find cloud rows accepted by the provider (SENT +
   * providerMessageId) that never received a terminal delivery ack, older than
   * `cutoff`. These are the rows the status webhook would have advanced; when
   * the webhook is off/lagging they sit at SENT forever, so the reconciler polls
   * the provider for their real outcome.
   */
  findUnconfirmedSent(cutoff: Date, take: number) {
    return this.prisma.message.findMany({
      where: {
        status: 'SENT',
        providerMessageId: { not: null },
        sentAt: { lt: cutoff },
      },
      select: {
        id: true,
        providerMessageId: true,
        campaignId: true,
        contactId: true,
        // The reconciler routes the status poll by the CHANNEL's provider
        // (multi-provider) — without this select every row reads `undefined`
        // and gets skipped, silently disabling reconciliation.
        instance: { select: { provider: true } },
      },
      // Oldest-unconfirmed first so a persistently-'sent' backlog can't starve
      // newer rows out of the bounded per-tick poll budget.
      orderBy: { sentAt: 'asc' },
      take,
    });
  }

  /**
   * Status reconciler (B4) — apply a polled terminal delivery outcome. Scoped to
   * `status:'SENT'` so it only ever UPGRADES a still-unconfirmed row (SENT is
   * below DELIVERED/READ/FAILED); if a real status callback already advanced the
   * row past SENT between the find and this write, the update no-ops (count 0).
   *
   * `contactId` is optional and comes straight from `findUnconfirmedSent`'s
   * select (the reconciler already has it on hand) — when present and the
   * outcome is FAILED, F2's durable Contact flag is updated best-effort (same
   * as every other FAILED write path in the codebase: webhooks.service.ts,
   * send-message.processor.ts). It never affects the Message write or the
   * returned count.
   */
  async applyReconciledDelivery(args: {
    messageId: string;
    newStatus: 'DELIVERED' | 'READ' | 'FAILED';
    occurredAt: Date;
    errorCode?: string;
    errorMessage?: string;
    contactId?: string | null;
  }): Promise<number> {
    const data: {
      status: 'DELIVERED' | 'READ' | 'FAILED';
      errorCode?: string | null;
      errorMessage?: string | null;
      deliveredAt?: Date;
      readAt?: Date;
      failedAt?: Date;
      failureReason?: FailureReason | null;
    } = {
      status: args.newStatus,
      errorCode: args.errorCode ?? null,
      errorMessage: args.errorMessage ?? null,
    };
    if (args.newStatus === 'DELIVERED') data.deliveredAt = args.occurredAt;
    else if (args.newStatus === 'READ') {
      // A read implies delivery; poll results can jump SENT→READ directly, so
      // stamp deliveredAt too rather than leaving it null on a read row.
      data.readAt = args.occurredAt;
      data.deliveredAt = args.occurredAt;
    } else if (args.newStatus === 'FAILED') {
      data.failedAt = args.occurredAt;
      // F2 — this reconciler path (Twilio poll fallback when the webhook is
      // late/missing) was writing FAILED with a raw errorCode but no
      // failureReason, leaving these rows out of the failure-reasons panel.
      data.failureReason = classifyFailure(args.errorCode);
    }
    const result = await this.prisma.message.updateMany({
      where: { id: args.messageId, status: 'SENT' },
      data,
    });
    if (args.newStatus === 'FAILED' && args.contactId && result.count > 0) {
      await this.prisma.contact
        .update({
          where: { id: args.contactId },
          data: buildContactFailureUpdate(args.errorCode),
        })
        .catch((e) =>
          this.logger.warn(
            { err: e, contactId: args.contactId },
            'F2: falha ao atualizar flag durável de falha do contato (best-effort, reconciler)',
          ),
        );
    }
    return result.count;
  }

  /**
   * Count messages still in flight for a campaign (QUEUED / SENDING /
   * WAITING_INSTANCE). Used to block a redispatch while a previous batch is
   * still draining — the per-campaign lock only guards CONCURRENT dispatches,
   * not a fresh dispatch fired after the first batch's enqueue completed but
   * while its messages are still sending (which, with tier batching, can span
   * days). A second overlapping batch would message every contact twice.
   */
  countInFlight(campaignId: string): Promise<number> {
    return this.prisma.message.count({
      where: {
        campaignId,
        status: { in: ['QUEUED', 'SENDING', 'WAITING_INSTANCE'] },
      },
    });
  }

  /**
   * Park a message as WAITING_INSTANCE (no instance available to send with
   * right now / instance disconnected mid-send). Scoped to the state the
   * CALLER declares via `from` — NOT a fixed `['QUEUED','SENDING']` union:
   * the scope must be exactly the state the caller holds, or a pre-claim job
   * could steal a row a worker already claimed into SENDING (or vice-versa).
   * Returns the count: 0 = the row already left the declared `from` state
   * (another attempt moved it on) — the caller must not send in that case.
   */
  async markWaitingForInstance(args: {
    messageId: string;
    instanceId: string;
    from: 'QUEUED' | 'SENDING';
  }): Promise<number> {
    const { count } = await this.prisma.message.updateMany({
      where: { id: args.messageId, status: args.from },
      data: { status: 'WAITING_INSTANCE', instanceId: args.instanceId },
    });
    return count;
  }

  /**
   * For a resolved `where` clause (the campaign's audience filter), count
   * contacts grouped by their cached `whatsappValid` flag:
   *   - `true`  → reachable (checked and confirmed on WhatsApp)
   *   - `false` → invalid (checked and NOT on WhatsApp)
   *   - `null`  → unknown (never checked yet)
   *
   * Returns { total, reachable, invalid, unknown }.
   */
  async preflightSummary(where: Prisma.ContactWhereInput): Promise<{
    total: number;
    reachable: number;
    invalid: number;
    unknown: number;
  }> {
    const [total, reachable, invalid] = await this.prisma.$transaction([
      this.prisma.contact.count({ where }),
      this.prisma.contact.count({ where: { ...where, whatsappValid: true } }),
      this.prisma.contact.count({ where: { ...where, whatsappValid: false } }),
    ]);
    return { total, reachable, invalid, unknown: total - reachable - invalid };
  }

  async waitingByCampaign(
    campaignId: string,
  ): Promise<{ count: number; instanceNames: string[] }> {
    const grouped = await this.prisma.message.groupBy({
      by: ['instanceId'],
      where: { campaignId, status: 'WAITING_INSTANCE' },
      _count: { _all: true },
    });
    const total = grouped.reduce((acc, g) => acc + g._count._all, 0);
    const instanceIds = grouped
      .map((g) => g.instanceId)
      .filter((id): id is string => id !== null);
    const instances = await this.prisma.channel.findMany({
      where: { id: { in: instanceIds } },
      select: { name: true },
    });
    return { count: total, instanceNames: instances.map((i) => i.name) };
  }

  // ── ZE — LOTES ─────────────────────────────────────────────────────────────

  /**
   * Abre um lote. O `seq` é o próximo número da campanha — atribuído sob o lock
   * 'resend' (o mesmo que serializa todo dispatch), e garantido no banco pelo
   * @@unique([campaignId, seq]): dois lotes concorrentes jamais compartilham
   * número.
   */
  async createBatch(data: {
    campaignId: string;
    requested: number;
    createdByUserId?: string | null;
  }): Promise<CampaignBatch> {
    const last = await this.prisma.campaignBatch.findFirst({
      where: { campaignId: data.campaignId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return this.prisma.campaignBatch.create({
      data: {
        campaignId: data.campaignId,
        seq: (last?.seq ?? 0) + 1,
        requested: data.requested,
        createdByUserId: data.createdByUserId ?? null,
      },
    });
  }

  finishBatch(
    id: string,
    result: { queued: number; skipped: number },
  ): Promise<CampaignBatch> {
    return this.prisma.campaignBatch.update({
      where: { id },
      data: {
        queued: result.queued,
        skipped: result.skipped,
        finishedAt: new Date(),
      },
    });
  }

  countBatches(campaignId: string): Promise<number> {
    return this.prisma.campaignBatch.count({ where: { campaignId } });
  }

  /**
   * ZE — lista paginada de CONTATOS da audiência (não de mensagens).
   *
   * A aba "não enviados" precisa disto: um pendente é, por definição, quem NÃO
   * tem `Message` — logo é invisível para o `/messages`. Ele só existe como um
   * contato que a audiência ainda alcança.
   */
  async listContactsPaged(
    where: Prisma.ContactWhereInput,
    opts: { page: number; pageSize: number },
  ) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        select: {
          id: true,
          name: true,
          phoneE164: true,
          marketingUndeliverableAt: true,
          marketingUndeliverableReason: true,
        },
        orderBy: { id: 'asc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * GATE SILENCIOSO — a aba "Pulados", com o MOTIVO de cada pulo.
   *
   * Não basta listar quem foi bloqueado: o operador precisa saber POR QUÊ, para
   * saber o que fazer (colher opt-in? respeitar a revogação?). Por isso o
   * `skipReason` sai da própria Message que o gate gravou (`errorCode` /
   * `status`) e não é reconstruído a partir de uma heurística.
   */
  async listSkippedContactsPaged(
    audience: Prisma.ContactWhereInput,
    campaignId: string,
    opts: { page: number; pageSize: number },
  ) {
    const where: Prisma.ContactWhereInput = {
      AND: [
        audience,
        {
          messages: {
            some: {
              campaignId,
              status: {
                in: [
                  'SKIPPED_NO_CONSENT',
                  'SKIPPED_SUPPRESSED',
                  'SKIPPED_NO_OPTIN',
                ],
              },
            },
          },
        },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        select: {
          id: true,
          name: true,
          phoneE164: true,
          marketingUndeliverableAt: true,
          marketingUndeliverableReason: true,
          messages: {
            where: {
              campaignId,
              status: {
                in: [
                  'SKIPPED_NO_CONSENT',
                  'SKIPPED_SUPPRESSED',
                  'SKIPPED_NO_OPTIN',
                ],
              },
            },
            select: { status: true, errorCode: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { id: 'asc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);

    const items = rows.map(({ messages, ...contact }) => ({
      ...contact,
      skipReason: messages[0]?.errorCode ?? messages[0]?.status ?? null,
    }));
    return { items, total };
  }

  /**
   * F2 T7 — a aba "falhados" da tela de destinatários: quem tem ao menos uma
   * Message FAILED nesta campanha, com o MOTIVO da falha embutido. Mesmo
   * molde de `listSkippedContactsPaged` acima: a Message FAILED mais recente
   * decide o `failureReason`/`errorCode` exibidos (um contato pode ter mais de
   * uma FAILED nesta campanha — retry avulso que falhou de novo).
   *
   * ⚠️ EXCLUI quem já foi ALCANÇADO ou está EM VOO nesta campanha
   * (`reachedOrInFlightInCampaign`). `createMessage` grava uma LINHA NOVA por
   * disparo e `BATCH_HANDLED_STATUSES` deixa FAILED de fora de propósito: uma
   * falha transitória devolve o contato à audiência pendente e o lote
   * seguinte pode ENTREGAR. Sem este recorte o contato apareceria em
   * "Enviados" E em "Falhas" ao mesmo tempo, e o operador — vendo a aba,
   * achando que ninguém entregou — reenviaria à mão, duplicando a entrega.
   * Esse era o defeito real que este filtro corrige.
   *
   * ⚠️ ISSO NÃO TORNA a aba numericamente igual ao botão "Reenviar falhas
   * (N)" (`countUnreachedFailedContacts`). Os dois predicados DIVERGEM em
   * duas direções conhecidas, não corrigidas por este filtro:
   *   1. `countUnreachedFailedContacts` (e `findFailedMessageIds`, que
   *      `retryFailedMessages` usa para decidir quem reenviar) filtram
   *      `errorCode: { notIn: INDETERMINATE_DELIVERY_CODES }`; esta função
   *      NÃO tem esse filtro. Um contato cujas FAILED nesta campanha são
   *      todas de código indeterminado (`twilio.indeterminate`,
   *      `zernio.indeterminate`, `gozap.indeterminate`, `sending_stuck`, ou os
   *      crus `zernio.timeout`/`gozap.timeout` de linhas legadas) — ou
   *      têm `errorCode` NULL, que um `NOT IN` do SQL
   *      não casa (mesma ressalva documentada em `handledInCampaignFilter`,
   *      batch-audience.ts) — APARECE nesta aba mas não entra no N e não é
   *      reenviado pelo botão.
   *   2. O `audience` que esta função recebe já vem recortado por
   *      `resolveAudienceWhere` (inclui `optedOut: false`, via
   *      filter.converter.ts, e `applyAudienceLimit` — ver
   *      `campaigns.service.ts#listRecipients`). `countUnreachedFailedContacts`
   *      não recebe audiência nenhuma. Quem falhou e depois deu opt-out SAI
   *      desta aba mas CONTINUA contado no N: o botão reenviaria alguém que a
   *      aba não mostra.
   * Igualar os dois predicados é decisão de produto (esconder falhas
   * indeterminadas da aba? mudar o que o N conta?) e está fora do escopo
   * deste método — aqui só se documenta a divergência que já existe.
   */
  async listFailedContactsPaged(
    audience: Prisma.ContactWhereInput,
    campaignId: string,
    opts: { page: number; pageSize: number },
  ) {
    const where: Prisma.ContactWhereInput = {
      AND: [
        audience,
        {
          messages: {
            some: { campaignId, status: 'FAILED' },
          },
        },
        { messages: { none: reachedOrInFlightInCampaign(campaignId) } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        select: {
          id: true,
          name: true,
          phoneE164: true,
          marketingUndeliverableAt: true,
          marketingUndeliverableReason: true,
          messages: {
            where: { campaignId, status: 'FAILED' },
            select: { failureReason: true, errorCode: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { id: 'asc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);

    const items = rows.map(({ messages, ...contact }) => ({
      ...contact,
      failureReason: messages[0]?.failureReason ?? null,
      errorCode: messages[0]?.errorCode ?? null,
    }));
    return { items, total };
  }

  /**
   * Histórico dos lotes + o RESULTADO de cada um. O resultado sai das Messages
   * que o lote gerou (agrupadas por status), e não de contadores gravados na
   * linha do lote: contador duplicado diverge da verdade no primeiro webhook de
   * status que chegar.
   */
  async listBatches(campaignId: string): Promise<
    Array<{
      id: string;
      seq: number;
      requested: number;
      queued: number;
      skipped: number;
      startedAt: Date;
      finishedAt: Date | null;
      statusCounts: Array<{ status: MessageStatus; count: number }>;
    }>
  > {
    const batches = await this.prisma.campaignBatch.findMany({
      where: { campaignId },
      orderBy: { seq: 'desc' },
    });
    if (batches.length === 0) return [];

    const grouped = await this.prisma.message.groupBy({
      by: ['campaignBatchId', 'status'],
      where: { campaignBatchId: { in: batches.map((b) => b.id) } },
      _count: true,
    });

    return batches.map((b) => ({
      id: b.id,
      seq: b.seq,
      requested: b.requested,
      queued: b.queued,
      skipped: b.skipped,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      statusCounts: grouped
        .filter((g) => g.campaignBatchId === b.id)
        .map((g) => ({ status: g.status, count: g._count })),
    }));
  }
}
