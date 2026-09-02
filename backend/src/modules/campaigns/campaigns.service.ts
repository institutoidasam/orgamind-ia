import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import type {
  Prisma,
  Channel,
  CampaignStatus,
  MessageStatus,
  FailureReason,
} from '@prisma/client';
import { TemplateStatus, TemplateCategory } from '@prisma/client';
import {
  CampaignsRepository,
  INDETERMINATE_DELIVERY_CODES,
} from './campaigns.repository';
import {
  pendingAudienceWhere,
  unreachedAudienceWhere,
  unreachedIdleAudienceWhere,
  sameTemplateBlockFilter,
} from './batch-audience';
import { SegmentsRepository } from '../segments/segments.repository';
import { TemplatesRepository } from '../templates/templates.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { warmupEffectiveCap } from '../whatsapp-instances/warmup.helper';
import { TemplateNotFoundError } from '../templates/errors/templates.errors';
import { isOfficialProvider } from '../../schemas/contracts/channel-provider.schema';
import {
  CampaignNotFoundError,
  CampaignInFlightError,
  CampaignAlreadyDispatchedError,
  CampaignOperationInProgressError,
  CampaignBlockedError,
  CampaignBatchNotAllowedError,
  CampaignNoPendingRecipientsError,
  CampaignBatchSizeExceedsPendingError,
  CampaignNotCancelledError,
  CampaignReleaseNotConfirmedError,
  MessageNotFoundError,
  MessageNotRetryableError,
  MessageDeliveryIndeterminateError,
  MessageContactAlreadyReachedError,
  CampaignTemplateProviderMismatchError,
  CampaignTemplateConsentButtonsError,
  CampaignTemplateNotApprovedError,
} from './errors/campaigns.errors';
import {
  computeSendChecks,
  hasBlockingCheck,
  type SendCheck,
} from './send-checks';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import {
  acquireCampaignLock,
  releaseCampaignLock,
  refreshCampaignLock,
  CAMPAIGN_LOCK_TTL_MS,
  type CampaignLockAction,
} from './campaign-lock.helper';
import { toPrismaWhere } from './filter.converter';
import { FAILURE_REASON_LABELS } from './failure-reason';
import { resolveHistoryTargets } from './history-filter.resolver';
import { findSegmentsReferencingCampaign } from './dependent-segments';
import { computeNextRun } from './schedule.util';
import {
  QUEUE_NAMES,
  type SendMessageJob,
  type ZernioBroadcastDispatchJob,
  type ZernioBroadcastCancelJob,
} from '../queue/queue.constants';
import { ValidationError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import {
  hasExcludeInvalidGroup,
  invalidContactWhere,
  stripExcludeInvalidGroup,
} from '../../shared/contact-validity';
import {
  AUDIT_CLS_KEY,
  type AuditContext,
} from '../../shared/audit/audit.service';
import { ConsentService } from '../consent/consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  filterGroupSchema,
  type FilterGroup,
} from '../../schemas/contracts/filter.schema';
import type {
  CreateCampaign,
  PreflightChecksInput,
  VariableMap,
} from '../../schemas/contracts/campaign.schema';
import type { ScheduleConfig } from '../../schemas/contracts/schedule.schema';
import { auditZernioTemplateRow } from '../../schemas/contracts/consent-button.schema';

// Process dispatch in chunks of this size with Promise.all per chunk so a
// 50k-contact campaign doesn't try to serialize 100k+ DB+Redis ops in a
// single HTTP request. Also the keyset page size: we fetch the audience one
// page at a time (instead of one giant findMany) so memory stays bounded.
const DISPATCH_CHUNK_SIZE = 500;

// Contact scalar columns a variableMap `field` mapping may reference. We only
// SELECT the columns the variableMap actually needs (plus id). Restricting to a
// known whitelist means a typo'd `field` is simply not selected (→ '' via the
// `?? ''` fallback, the pre-existing graceful behaviour) instead of crashing
// Prisma with an unknown-column select.
const CONTACT_VARIABLE_COLUMNS = new Set<string>([
  'name',
  'city',
  'group',
  'phoneE164',
  'tags',
  'whatsappValid',
  'profilePictureUrl',
]);

/**
 * C1 — teto de destinatários do override de consentimento (spec §4). Onde o
 * override sobrevive (EVOLUTION) ele é uma válvula de exceção para casos
 * pontuais, não um caminho de disparo em massa: 100 é pequeno o bastante para
 * que um erro de julgamento não vire um incidente de 13 mil pessoas.
 */
export const CONSENT_OVERRIDE_MAX_RECIPIENTS = 100;

/**
 * A janela de atendimento de 24h autoriza CONVERSAR, não fazer campanha de
 * marketing. A única finalidade que ela pode cobrir é a de natureza *utility*
 * (spec §4.3.4) — as outras quatro são marketing para efeito da Meta.
 */
const WINDOW_ELIGIBLE_PURPOSE = 'servico_projeto';
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Os recortes que `resolveAudience` sabe montar sobre a MESMA audiência:
 *   pending        — exclui já TRATADO (11 status, inclui os pulados pelo
 *                    gate). É o recorte do LOTE: não repete nem quem está em voo.
 *   unreached      — exclui só quem RECEBEU (SENT|DELIVERED|READ). Os pulados
 *                    pelo gate VOLTAM: é o recorte do "Disparar novamente",
 *                    que só roda com `countInFlight === 0` (I10).
 *   unreached-idle — o recorte do TICK RECORRENTE: como `unreached`, mas
 *                    excluindo TAMBÉM quem está EM VOO. O tick não tem a
 *                    guarda de I10 e volta a cada 5–60 min sobre um lote que
 *                    leva horas para drenar (C1/C4 da auditoria 2026-08-19).
 *   full           — a audiência inteira, ignorando o histórico de mensagens.
 */
export type AudienceMode =
  | 'pending'
  | 'unreached'
  | 'unreached-idle'
  | 'full';

/**
 * A.5 — os números do CABEÇALHO DE PROGRESSO, numa fonte de verdade só.
 *
 * O tipo mora aqui (e não inline na assinatura) porque a resposta de
 * `POST /campaigns/:id/batches` também o carrega: a tela recebe o lote e o
 * resumo na MESMA ida, sem uma segunda chamada que mostraria números de antes
 * do lote.
 *
 * `inFlight`/`waiting`/`failed`/`skipped` contam MENSAGENS; `total`, `sent`,
 * `pending` e `unreachable` contam CONTATOS. A distinção é deliberada e é a
 * mesma de antes desta mudança — a trava de banco garante UMA linha viva por
 * (campanha, contato), então em voo os dois números coincidem na prática.
 */
export type CampaignBatchSummary = {
  /** Público: quem casa com filtros/segmento depois das exclusões. */
  total: number;
  /** Já receberam: SENT/DELIVERED/READ nesta campanha, em CONTATOS distintos. */
  sent: number;
  /** Restam: elegíveis sem linha viva nem alcançada — quem o próximo lote pega. */
  pending: number;
  /** Em fila: QUEUED + SENDING + WAITING_INSTANCE. */
  inFlight: number;
  /** Aguardando o canal reconectar: WAITING_INSTANCE, isolado do resto. */
  waiting: number;
  unreachable: number;
  failed: number;
  skipped: number;
  isMarketing: boolean;
  status: CampaignStatus;
};

/**
 * Review T15 — extrai a janela `{ id: { lte: cutoffId } }` que
 * `CampaignsRepository#applyAudienceLimit` já calculou dentro de `base`
 * (`{ AND: [where, { id: { lte: cutoffId } }] }`, sempre como o ÚLTIMO
 * elemento do `AND`; sem `limit`, `applyAudienceLimit` devolve `where`
 * intacto e não há janela).
 *
 * Reaproveitar a janela aqui — em vez de chamar `applyAudienceLimit` de novo
 * ou mudar o contrato do repositório — é o jeito menos invasivo de manter
 * `excludedInvalid` na MESMA janela de id que `count`/`sample` (`base`) já
 * usam, sem duplicar a query de corte nem mexer nos callers/testes
 * existentes de `applyAudienceLimit`.
 */
function extractIdWindow(
  base: Prisma.ContactWhereInput,
): Prisma.ContactWhereInput | null {
  const and = (base as { AND?: unknown }).AND;
  if (!Array.isArray(and) || and.length === 0) return null;
  const last = and[and.length - 1];
  if (last && typeof last === 'object' && 'id' in (last as object)) {
    return last as Prisma.ContactWhereInput;
  }
  return null;
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly repo: CampaignsRepository,
    private readonly segmentsRepo: SegmentsRepository,
    private readonly templatesRepo: TemplatesRepository,
    private readonly instancesRepo: WhatsappInstancesRepository,
    @InjectQueue(QUEUE_NAMES.WHATSAPP_SEND)
    private readonly sendQueue: Queue<SendMessageJob>,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly consent: ConsentService,
    // T4 — o CHOKE POINT do F1: todo toPrismaWhere sobre um filtro que pode
    // conter um nó history precisa do resolveHistoryTargets rodando ANTES,
    // com este PrismaService. Fica antes das duas filas opcionais abaixo
    // porque um parâmetro obrigatório não pode vir depois de um opcional
    // (TS1016) — ver o comentário delas para o motivo de serem as últimas.
    private readonly prisma: PrismaService,
    // ZB — as duas filas do BROADCAST do Zernio. Vêm por ÚLTIMO, e são
    // OPCIONAIS, de propósito: os specs históricos constroem este serviço
    // posicionalmente, e um parâmetro novo no meio quebraria todos eles sem
    // provar nada. Em produção o Nest sempre as injeta.
    //
    // O acesso é sempre com `?.` — e quando a fila NÃO existe, o código GRITA
    // (ver `cancel` e `dispatchAudience`). Um kill-switch que falha em silêncio é
    // pior do que um que não existe: o operador acha que parou o disparo.
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH)
    private readonly broadcastDispatchQueue?: Queue<ZernioBroadcastDispatchJob>,
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL)
    private readonly broadcastCancelQueue?: Queue<ZernioBroadcastCancelJob>,
  ) {}

  /**
   * A4 — acquire the per-campaign resend lock and start a heartbeat that
   * REFRESHES it (compare-and-extend keyed by our token) at half the TTL while
   * the caller works. A dispatch that pages a 50k+ audience can outlive
   * CAMPAIGN_LOCK_TTL_MS; without the heartbeat the mutex would expire mid-run
   * and admit a concurrent second full dispatch (double-send). Returns the
   * acquisition token + a `stop()` to clear the heartbeat, or null when another
   * invocation already holds the lock.
   */
  private async acquireResendLock(
    campaignId: string,
    action: CampaignLockAction,
  ): Promise<{ token: string; stop: () => void } | null> {
    const token = await acquireCampaignLock(this.redis, campaignId, action);
    if (!token) return null;
    const heartbeat = setInterval(
      () => {
        void refreshCampaignLock(this.redis, campaignId, action, token);
      },
      Math.max(1, Math.floor(CAMPAIGN_LOCK_TTL_MS / 2)),
    );
    // Don't keep the event loop alive just for the heartbeat.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    return { token, stop: () => clearInterval(heartbeat) };
  }

  /**
   * A4 — run `fn` while holding the per-campaign resend lock. If another
   * invocation already holds it (double-click / two operators), reject with
   * CampaignOperationInProgressError instead of creating duplicate
   * jobs/batches. The lock is refreshed while `fn` runs and always released
   * (owner-checked compare-and-delete) in a finally.
   */
  private async withCampaignLock<T>(
    campaignId: string,
    action: CampaignLockAction,
    fn: () => Promise<T>,
  ): Promise<T> {
    const held = await this.acquireResendLock(campaignId, action);
    if (!held) {
      throw new CampaignOperationInProgressError();
    }
    try {
      return await fn();
    } finally {
      held.stop();
      await releaseCampaignLock(this.redis, campaignId, action, held.token);
    }
  }

  /**
   * Resolve the FilterGroup that defines a campaign's recipient set.
   *
   * Broadcast campaigns (`segmentId` set) are DYNAMIC: their audience is the
   * segment's CURRENT members, re-read from the segment on every run/dispatch.
   * Plain campaigns keep the historical behaviour of using the inline
   * `campaign.filters` snapshot. If the segment was deleted out from under a
   * broadcast we fall back to the campaign's stored snapshot rather than
   * blowing up the dispatch.
   */
  async resolveRecipientFilters(campaign: {
    segmentId?: string | null;
    filters: unknown;
  }): Promise<FilterGroup> {
    if (campaign.segmentId) {
      const segment = await this.segmentsRepo.findById(campaign.segmentId);
      if (segment) return this.parseStoredFilter(segment.filters, 'segment');
      this.logger.warn(
        `Broadcast segment ${campaign.segmentId} not found; falling back to the campaign's stored filter snapshot (audience is now frozen).`,
      );
    }
    return this.parseStoredFilter(campaign.filters, 'campaign');
  }

  /**
   * A audiência do DISPARO: o filtro resolvido, convertido em `where` e JÁ
   * RECORTADO pelo limite persistido da campanha ("os N primeiros").
   *
   * Existe como chokepoint ÚNICO de propósito. Os quatro caminhos que disparam
   * (`run`, `runScheduledLocked`, `redispatchCampaign`, `sendBatch`) montavam o
   * `where` cada um por si, com as mesmas duas linhas copiadas. Um limite que
   * fosse aplicado em três deles e esquecido no quarto é exatamente o bug que
   * este método torna impossível: o agendador materializaria a base inteira,
   * horas depois, sem ninguém olhando.
   *
   * O recorte é `id <= (id do N-ésimo contato)` — ver `applyAudienceLimit`. Como
   * é só mais um predicado, ele compõe com o gate de consentimento e com o
   * filtro de pendentes dos lotes sem que nenhum dos dois saiba que existe.
   */
  private async resolveAudienceWhere(campaign: {
    filters: unknown;
    segmentId?: string | null;
    limit?: number | null;
  }): Promise<Prisma.ContactWhereInput> {
    const filters = await this.resolveRecipientFilters(campaign as never);
    const resolved = await resolveHistoryTargets(filters, this.prisma);
    const where = toPrismaWhere(resolved) as Prisma.ContactWhereInput;
    return this.repo.applyAudienceLimit(where, campaign.limit);
  }

  /**
   * Médio — re-validate a stored JSON filter with `filterGroupSchema` instead of
   * a bare `as` cast. The `filters` column is persisted JSON; a row written
   * before the op/value constraints existed (or by a future bug) could carry an
   * invalid shape (e.g. `{ op:'in', value:'x' }`) that `toPrismaWhere` turns
   * into an invalid Prisma `where` and 500s the (often unattended, scheduled)
   * dispatch. Re-parsing at dispatch time turns that into a clean, attributable
   * domain error rather than a crash two modules away.
   */
  private parseStoredFilter(
    raw: unknown,
    source: 'campaign' | 'segment',
  ): FilterGroup {
    const parsed = filterGroupSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        `Stored ${source} filter failed re-validation: ${parsed.error.message}`,
      );
      throw new ValidationError(
        'O filtro de destinatários armazenado é inválido. Edite a campanha/segmento e salve novamente.',
        `invalid stored ${source} filter: ${parsed.error.message}`,
        'campaign.invalid_stored_filter',
      );
    }
    return parsed.data;
  }

  /**
   * Return a reachability summary for the campaign's resolved recipient set,
   * using cached `whatsappValid` values — no live Evolution call.
   */
  async preflight(id: string): Promise<{
    total: number;
    reachable: number;
    invalid: number;
    unknown: number;
  }> {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);

    // FASE 0 §0.1 — o preflight é a prévia do que o disparo VAI fazer, então
    // usa o MESMO recorte ('unreached'): numa campanha DRAFT (o caso comum)
    // ainda não existe Message nenhuma, então unreached === full e a mudança é
    // inócua; numa campanha já executada, a tela pararia de contar quem já
    // recebeu como se ainda fosse alcançar — exatamente o que "Disparar
    // novamente" faz de verdade.
    const { where } = await this.resolveAudience(campaign, 'unreached');

    return this.repo.preflightSummary(where);
  }

  /**
   * Compute a WhatsApp reachability summary directly from a filter group —
   * used in the campaign wizard before the campaign is persisted.
   */
  async preflightByFilters(filters: FilterGroup): Promise<{
    total: number;
    reachable: number;
    invalid: number;
    unknown: number;
  }> {
    const resolved = await resolveHistoryTargets(filters, this.prisma);
    const where = toPrismaWhere(resolved) as Prisma.ContactWhereInput;
    return this.repo.preflightSummary(where);
  }

  /**
   * A prévia: quantos vão receber, e QUEM (uma amostra).
   *
   * Os dois números saem da audiência JÁ RECORTADA pelo limite ("os N
   * primeiros") — e a amostra sai na ORDEM DO DISPARO. Antes, a amostra vinha em
   * `createdAt: 'desc'` e o disparo lia em `id: 'asc'`: ordens opostas. Sem
   * limite ninguém notava (todo mundo recebia). Com "os N primeiros", a tela
   * mostraria N pessoas e o disparo mandaria para N pessoas DIFERENTES.
   */
  async preview(
    filters: FilterGroup,
    limit?: number | null,
    /**
     * ★ O template ESCOLHIDO no assistente. Com ele, a prévia aplica a mesma
     * exclusão que o disparo aplicará (spec 2026-08-12) e informa quantos
     * ficaram de fora.
     *
     * Opcional porque a campanha ainda não existe quando o passo 3 roda — e
     * porque as chamadas antigas (sem template escolhido) precisam continuar
     * devolvendo exatamente o que devolviam.
     *
     * Sem isto a tela prometeria 500 e o disparo entregaria 88: é literalmente
     * o contrato que a Fase 0 existiu para consertar.
     */
    templateId?: string | null,
    /**
     * ★ Pedido do cliente 2026-08-25 — espelha `Campaign.excludeAnyPreviousCampaign`
     * na prévia (mesmo motivo do `templateId` acima: sem isto a tela promete um
     * número que o disparo não confere). `false`/ausente preserva a régua de
     * sempre (só o mesmo template).
     */
    excludeAnyPreviousCampaign = false,
  ) {
    const resolved = await resolveHistoryTargets(filters, this.prisma);
    const where = toPrismaWhere(resolved) as Prisma.ContactWhereInput;
    const base = await this.repo.applyAudienceLimit(where, limit);

    // A.2/B.4 — QUANTOS a exclusão de inválidos tirou.
    //
    // A conta é feita sobre a audiência SEM a exclusão, de propósito: o filtro
    // que chega aqui JÁ exclui os inválidos, então contá-los na audiência
    // final daria ZERO por construção, e a linha da prévia mostraria
    // "0 inválidos excluídos" para sempre. Só custa uma query, e só quando o
    // operador de fato ligou o toggle.
    //
    // Review T15 — a conta tem de ficar na MESMA janela de id que `base`
    // (count/sample) já usa: sem isto, com `limit` setado, contaríamos
    // inválidos da tabela INTEIRA e o total (`count + excludedSameTemplate +
    // excludedInvalid`) que a tela soma ficaria inflado. `extractIdWindow`
    // reaproveita o corte que `applyAudienceLimit` já calculou em `base`
    // (`{ AND: [where, { id: { lte: cutoffId } }] }`) em vez de recalcular o
    // cutoff com uma segunda query.
    const idWindow = extractIdWindow(base);
    const excludedInvalid = hasExcludeInvalidGroup(resolved)
      ? await this.repo.countContactsByWhere({
          AND: [
            toPrismaWhere(
              stripExcludeInvalidGroup(resolved),
            ) as Prisma.ContactWhereInput,
            invalidContactWhere(),
            ...(idWindow ? [idWindow] : []),
          ],
        })
      : 0;

    // Campanha nova ainda não tem id — nenhuma irmã a ignorar.
    const bloqueio = templateId
      ? await this.sameTemplateExclusion(
          null,
          templateId,
          excludeAnyPreviousCampaign,
        )
      : null;
    if (!bloqueio) {
      const [count, sample] = await Promise.all([
        this.repo.countContactsByWhere(base),
        this.repo.findContactsByWhere(base, 10),
      ]);
      return { count, sample, excludedSameTemplate: 0, excludedInvalid };
    }

    const audience: Prisma.ContactWhereInput = {
      AND: [base, { messages: { none: bloqueio } }],
    };
    // Os dois números: o de antes só para dizer QUANTOS saíram. A amostra vem
    // da audiência FILTRADA — listar quem não vai receber seria pior que não
    // listar nada.
    const [semRegra, count, sample] = await Promise.all([
      this.repo.countContactsByWhere(base),
      this.repo.countContactsByWhere(audience),
      this.repo.findContactsByWhere(audience, 10),
    ]);
    return {
      count,
      sample,
      excludedSameTemplate: Math.max(0, semRegra - count),
      excludedInvalid,
    };
  }

  /**
   * Resolve the audience + instance + schedule context and run the pure
   * send-checks (anti-ban misconfiguration analysis). Centralises the data
   * gathering so create() and preflightChecks() agree on the same input.
   */
  async runChecks(args: {
    filters: FilterGroup;
    defaultInstanceId: string;
    schedule: ScheduleConfig;
    timezone: string;
    /**
     * Campaign id of the campaign being checked, when it already exists. The
     * OVERLAP check excludes it so a campaign never counts ITSELF as a
     * conflicting "running campaign on the instance".
     */
    excludeCampaignId?: string;
  }): Promise<SendCheck[]> {
    const resolvedFilters = await resolveHistoryTargets(
      args.filters,
      this.prisma,
    );
    const where = toPrismaWhere(resolvedFilters) as Prisma.ContactWhereInput;
    const [recipients, reachability, instance, hasRunningCampaignOnInstance] =
      await Promise.all([
        this.segmentsRepo.countContactsByWhere(where),
        this.segmentsRepo.preflightSummary(where),
        this.instancesRepo.findById(args.defaultInstanceId),
        this.repo.hasRunningCampaignOnInstance(
          args.defaultInstanceId,
          args.excludeCampaignId,
        ),
      ]);

    // Defensive default if the instance row is missing — checks degrade to
    // info/warn without a hard crash.
    const inst = instance ?? {
      sentToday: 0,
      dailySendLimit: 500,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sendWindowEnabled: true,
    };

    const nextRunAt =
      args.schedule.type === 'IMMEDIATE'
        ? null
        : computeNextRun(args.schedule, new Date(), args.timezone, null);

    // Anti-ban warm-up: the VOLUME check's remaining-budget must reflect the
    // number's warm-up cap, not the raw dailySendLimit — otherwise the wizard
    // would let an operator create a campaign that then stalls at the (lower)
    // effective cap. The defensive `inst` fallback has no warmupStartedAt → full.
    const effectiveDailyLimit = warmupEffectiveCap(
      (instance as Channel | null)?.warmupStartedAt ?? null,
      new Date(),
      inst.dailySendLimit,
    );

    const checks = computeSendChecks({
      recipients,
      reachability,
      instance: {
        sentToday: inst.sentToday,
        dailySendLimit: effectiveDailyLimit,
        sendWindowStartHour: inst.sendWindowStartHour,
        sendWindowEndHour: inst.sendWindowEndHour,
        sendWindowEnabled: inst.sendWindowEnabled,
        // Broadcast do Zernio enfileira o excedente sozinho (corta no teto da
        // janela de 24h e re-enfileira) — o VOLUME informa em vez de bloquear.
        queuesOverflow:
          (instance as Channel | null)?.provider === 'ZERNIO' &&
          (instance as Channel | null)?.zernioBroadcastEnabled === true,
      },
      schedule: args.schedule,
      hasRunningCampaignOnInstance,
      nextRunAt,
      timezone: args.timezone,
    });

    // U2 — surface a missing/soft-deleted instance as a BLOCK check so the
    // wizard's preflight shows the real problem before the operator confirms.
    // The defensive `inst` default above only keeps the other checks from
    // crashing; it must not mask the fact that sending would be impossible
    // (every send fails at the router with "instance has been deleted").
    if (!instance || !instance.isActive) {
      checks.push({
        code: 'INSTANCE_DELETED',
        severity: 'block',
        message:
          'A conexão selecionada foi removida ou não existe. Selecione outra conexão para a campanha.',
      });
    }

    return checks;
  }

  /**
   * Preflight the campaign wizard's "send analysis": resolve the audience from
   * the inline filters, summarise reachability, and run all send-checks. Used by
   * the confirm step before the campaign is persisted.
   */
  async preflightChecks(input: PreflightChecksInput): Promise<{
    recipients: number;
    reachability: {
      total: number;
      reachable: number;
      invalid: number;
      unknown: number;
    };
    checks: SendCheck[];
    /**
     * C1b — quantos da audiência filtrada o GATE deixaria passar, e quantos ele
     * vai pular. `null` enquanto não há finalidade: sem ela não existe número a
     * mostrar (e inventar "0 de 120" leria como "sua base não consentiu",
     * quando o que falta é o operador escolher).
     *
     * `withConsent` é só o consentimento EXPLÍCITO; `eligible` é o que o gate
     * realmente autoriza (granted ∪ janela de atendimento aberta, quando a
     * finalidade é a que a janela cobre). São números diferentes e a UI precisa
     * dos dois: o primeiro explica o que falta COLETAR, o segundo é o que vai
     * SAIR — e é o único que pode travar o botão, sob pena de a tela passar a
     * bloquear um disparo que o gate autorizaria.
     */
    consent: {
      purposeKey: string;
      withConsent: number;
      /** Elegíveis pela janela de 24h e SEM grant explícito (eligible - granted). */
      viaOpenWindow: number;
      /** O que o gate deixaria passar hoje: granted ∪ janela. */
      eligible: number;
      withoutConsent: number;
    } | null;
  }> {
    const resolvedFilters = await resolveHistoryTargets(
      input.filters,
      this.prisma,
    );
    const where = toPrismaWhere(resolvedFilters) as Prisma.ContactWhereInput;
    // A janela de atendimento é o 2º caminho do gate (decide(), ~l. 1480) e vale
    // exatamente para UMA finalidade. A condição é replicada aqui a partir da
    // MESMA constante — se ela mudar, as duas mudam juntas.
    const window =
      input.purposeKey === WINDOW_ELIGIBLE_PURPOSE
        ? {
            instanceId: input.defaultInstanceId,
            since: new Date(Date.now() - SERVICE_WINDOW_MS),
          }
        : null;
    const [recipients, reachability, checks, withConsent, eligible] =
      await Promise.all([
        this.segmentsRepo.countContactsByWhere(where),
        this.segmentsRepo.preflightSummary(where),
        this.runChecks({
          filters: input.filters,
          defaultInstanceId: input.defaultInstanceId,
          schedule: input.schedule,
          timezone: input.timezone,
        }),
        input.purposeKey
          ? this.consent.countGrantedInAudience(where, input.purposeKey)
          : Promise.resolve(null),
        input.purposeKey
          ? this.consent.countEligibleInAudience(
              where,
              input.purposeKey,
              window,
            )
          : Promise.resolve(null),
      ]);
    return {
      recipients,
      reachability,
      checks,
      consent:
        input.purposeKey && withConsent !== null && eligible !== null
          ? {
              purposeKey: input.purposeKey,
              withConsent,
              // `eligible` é uma superconjunto de `withConsent` (mesmo filtro +
              // um OR a mais), mas as contagens são consultas independentes e a
              // audiência pode mudar entre elas: nada de número negativo.
              viaOpenWindow: Math.max(0, eligible - withConsent),
              eligible,
              withoutConsent: Math.max(0, recipients - eligible),
            }
          : null,
    };
  }

  async create(input: CreateCampaign) {
    const template = await this.templatesRepo.findById(input.templateId);
    if (!template) throw new TemplateNotFoundError(input.templateId);

    // T7 — a template built for one provider can't be sent through a
    // channel of a different provider. A missing channel isn't checked here
    // — that's the INSTANCE_DELETED guard below (via runChecks), which is
    // unconditional and not overridable.
    const channel = await this.instancesRepo.findById(input.defaultInstanceId);
    if (channel && channel.provider !== template.provider) {
      throw new CampaignTemplateProviderMismatchError(
        template.provider,
        channel.provider,
      );
    }

    // ZC6 — gate de campanha: só APPROVED entra. Aqui é a checagem de UX (falha
    // cedo, com mensagem clara); a AUTORITATIVA roda no disparo
    // (assertTemplateProviderMatchesChannel), porque o status pode mudar SOZINHO
    // entre a criação e a execução — a Meta pausa/desabilita um template
    // aprovado e avisa por webhook.
    if (template.status !== TemplateStatus.APPROVED) {
      throw new CampaignTemplateNotApprovedError(
        template.metaName,
        template.status,
      );
    }

    // ★ E APROVADO NÃO BASTA: os botões precisam ser LEGÍVEIS. Ver
    // assertTemplateConsentButtonsUsable — o gate que impede um template de
    // opt-in de rótulo não reconhecido de chegar aos 13.400.
    this.assertTemplateConsentButtonsUsable(template);

    // C1b/C2 — a FINALIDADE é declarada na criação, não descoberta no dispatch,
    // e é OBRIGATÓRIA em TODOS OS PROVEDORES.
    //
    // O C1b só a exigia em canal oficial, deixando-a opcional no EVOLUTION
    // (spec §4.5, "lá não há contrato com a Meta a violar"). Isso era um
    // footgun: o gate de dispatch consulta consentimento POR FINALIDADE em
    // TODO provedor — sem `purposeKey`, `hasConsent(contact, null)` é falso e a
    // audiência inteira vira SKIPPED_NO_CONSENT. Ou seja, a campanha era criada
    // com sucesso e NÃO ENVIAVA NADA, em silêncio. Falhar aqui é a única forma
    // de o erro ser legível.
    //
    // (O override do Evolution continua existindo — mas ele fura a falta de
    // CONSENTIMENTO, não a falta de FINALIDADE: sem finalidade não há sequer o
    // que consentir.)
    if (!input.purposeKey) {
      throw new ValidationError(
        'Selecione a finalidade da campanha — o consentimento é registrado por finalidade.',
        'purposeKey is required on every provider (o gate de consentimento é por finalidade)',
        'campaign.purpose_required',
      );
    }

    // Uma key inexistente/inativa é indistinguível, no gate, de campanha sem
    // finalidade: `grantedContactIds` devolve vazio e 100% é pulado em silêncio.
    if (input.purposeKey) {
      const purpose = await this.consent.findActivePurpose(input.purposeKey);
      if (!purpose) {
        throw new ValidationError(
          'A finalidade selecionada não existe ou foi desativada. Escolha uma finalidade ativa.',
          `unknown or inactive ConsentPurpose '${input.purposeKey}'`,
          'campaign.purpose_unknown',
        );
      }
    }

    // A audiência JÁ RECORTADA pelo limite ("os N primeiros"). O `totalRecipients`
    // tem de ser o do RECORTE: é ele o denominador da barra de progresso e o teto
    // do override. Contar 13.400 numa campanha limitada a 200 daria uma barra que
    // nunca fecha e um teto de override calculado sobre gente que não vai receber.
    const resolvedFilters = await resolveHistoryTargets(
      input.filters,
      this.prisma,
    );
    // A.1 — campanha nova nasce SEM recorte: `input.limit` é sempre null/undefined
    // (o contrato recusa qualquer número). `applyAudienceLimit` fica no caminho
    // de propósito, para o `create` continuar usando o MESMO resolvedor das
    // campanhas legadas — passando null ele devolve o `where` intacto.
    const where = await this.repo.applyAudienceLimit(
      toPrismaWhere(resolvedFilters) as Prisma.ContactWhereInput,
      null,
    );
    const totalRecipients = await this.repo.countContactsByWhere(where);

    // Anti-ban send-checks gate: a `block`-severity check rejects the create
    // unless the operator has acknowledged the risk via `override`.
    const checks = await this.runChecks({
      filters: input.filters,
      defaultInstanceId: input.defaultInstanceId,
      schedule: input.schedule,
      timezone: input.timezone,
    });

    // U2 — a deleted/inactive default instance is a HARD error, independent of
    // the override gate below: `override` acknowledges anti-ban *risk*, but
    // sending through a missing instance is *impossible* (every send fails at
    // the router). Reuses the runChecks fetch via the INSTANCE_DELETED check.
    if (checks.some((c) => c.code === 'INSTANCE_DELETED')) {
      throw new ValidationError(
        'A conexão selecionada foi removida ou não existe. Selecione outra conexão.',
        'defaultInstanceId must reference an active instance',
        'campaign.instance_deleted',
      );
    }

    if (!input.override && hasBlockingCheck(checks)) {
      throw new CampaignBlockedError(
        checks.filter((c) => c.severity === 'block'),
      );
    }

    // C1 — invariantes do override de CONSENTIMENTO (spec §4). Só se aplicam
    // onde ele sobrevive: canal de provider NÃO-OFICIAL (hoje só a EVOLUTION,
    // mas a condição é o trait, não o literal). Em canal oficial o override é
    // ignorado pelo gate, e continua servindo apenas como reconhecimento de
    // risco anti-ban dos send-checks acima. A invariante de role ADMIN é
    // estrutural (@Roles('ADMIN') no controller).
    if (input.override && channel?.provider != null && !isOfficialProvider(channel.provider)) {
      if (!input.overrideJustification?.trim()) {
        throw new ValidationError(
          'Enviar sem consentimento exige uma justificativa escrita (ela fica registrada e auditada).',
          'overrideJustification is required when override is used on a non-official provider',
          'campaign.override_justification_required',
        );
      }
      if (totalRecipients > CONSENT_OVERRIDE_MAX_RECIPIENTS) {
        throw new ValidationError(
          `Enviar sem consentimento é limitado a ${CONSENT_OVERRIDE_MAX_RECIPIENTS} destinatários por campanha ` +
            `(esta tem ${totalRecipients}). Reduza o público ou colete o consentimento.`,
          `override audience ${totalRecipients} exceeds ${CONSENT_OVERRIDE_MAX_RECIPIENTS}`,
          'campaign.override_audience_too_large',
        );
      }
    }

    const now = new Date();

    // Reject ONCE_AT with a runAt in the past. Without this, nextRunAt would
    // be a past timestamp and the scheduler would fire it on the next tick;
    // if runScheduled errored before markRan, subsequent ticks would re-fire
    // the same past target. Forcing a future target makes the schedule
    // unambiguous (use IMMEDIATE for "send now").
    if (input.schedule.type === 'ONCE_AT') {
      const target = new Date(input.schedule.runAt);
      if (target.getTime() <= now.getTime()) {
        throw new ValidationError(
          'O agendamento ONCE_AT precisa ser uma data/hora no futuro.',
          'runAt must be in the future',
          'campaign.schedule_in_past',
        );
      }
    }

    const nextRunAt =
      input.schedule.type === 'IMMEDIATE'
        ? null
        : computeNextRun(input.schedule, now, input.timezone, null);

    const result = await this.repo.create({
      name: input.name,
      templateId: input.templateId,
      defaultInstanceId: input.defaultInstanceId,
      segmentId: input.segmentId ?? null,
      filters: input.filters as Prisma.InputJsonValue,
      variableMap: input.variableMap as Prisma.InputJsonValue,
      totalRecipients,
      scheduledAt:
        input.schedule.type === 'ONCE_AT' ? input.schedule.runAt : null,
      scheduleType: input.schedule.type,
      scheduleConfig: input.schedule as unknown as Prisma.InputJsonValue,
      timezone: input.timezone,
      nextRunAt,
      scheduleEnabled: input.schedule.type !== 'IMMEDIATE',
      presenceDelayMs: input.presenceDelayMs ?? 0,
      // A.1 — LEGADO. Campanha nova nunca grava recorte: quem dimensiona o
      // envio é o 1º lote. A coluna continua existindo para as campanhas
      // criadas antes de 2026-08.
      limit: null,
      // C1 — a finalidade que o gate vai exigir do consentimento de cada
      // destinatário. Sem ela, o gate não passa ninguém em nenhum provedor.
      purposeKey: input.purposeKey ?? null,
      // Reconhecimento de risco anti-ban dos send-checks. Como override de
      // CONSENTIMENTO só vale em EVOLUTION, e só com as invariantes acima.
      override: input.override ?? false,
      overrideJustification: input.overrideJustification?.trim() || null,
      // ★ 2026-08-25 — "excluir quem já recebeu": false preserva a régua de
      // sempre (só o mesmo template); ver sameTemplateExclusion.
      excludeAnyPreviousCampaign: input.excludeAnyPreviousCampaign ?? false,
      // ★ 2026-08-25 — janela de horário de envio; ver send-message.processor.ts.
      respeitarJanelaDeEnvio: input.respeitarJanelaDeEnvio ?? true,
    });
    await this.audit.log('campaign.create', 'Campaign', result.id, {
      name: result.name,
      templateId: result.templateId,
      totalRecipients,
      scheduleType: input.schedule.type,
      nextRunAt: nextRunAt?.toISOString(),
    });
    return result;
  }

  /**
   * Find campaigns that should run now (scheduler tick).
   */
  findDueScheduledCampaigns(now: Date) {
    return this.repo.findDueScheduled(now);
  }

  /**
   * Run a scheduled campaign and reschedule the next run if recurring.
   * Unlike run() (manual), this allows multiple runs of the same campaign
   * over time and doesn't require DRAFT status.
   */
  async runScheduled(id: string) {
    // Bug 2 — take the SAME per-campaign 'resend' lock the manual run() path
    // holds, so a scheduler tick and a concurrent run()/redispatch can't both
    // dispatch the same campaign (every recipient messaged twice). Unlike the
    // resend paths this is a background job: if the lock is held we skip this
    // tick gracefully (the other dispatch is handling it) rather than throwing.
    const held = await this.acquireResendLock(id, 'resend');
    if (!held) {
      this.logger.warn(
        `runScheduled(${id}): another dispatch holds the resend lock — skipping this tick.`,
      );
      return { queued: 0 };
    }
    try {
      return await this.runScheduledLocked(id);
    } finally {
      held.stop();
      await releaseCampaignLock(this.redis, id, 'resend', held.token);
    }
  }

  private async runScheduledLocked(id: string) {
    // Read the campaign INSIDE the lock so scheduleEnabled reflects a concurrent
    // run() that just consumed/disarmed a one-shot schedule (else we'd re-fire).
    const campaign = await this.repo.findById(id);
    if (!campaign) return { queued: 0 };
    if (!campaign.scheduleEnabled) return { queued: 0 };

    // IMMEDIATE campaigns shouldn't have scheduleEnabled, but if a row was
    // hand-edited (or migrated from before scheduleConfig was required),
    // bail rather than crash on `config.type` access in computeNextRun.
    if (campaign.scheduleConfig == null) {
      await this.repo.markRan(id, new Date(), null, 0);
      return { queued: 0 };
    }

    // FASE 0 §0.3 — o tick recorrente reenvia só a quem NÃO recebeu. Antes ele
    // usava a audiência inteira e reenviava para todos a cada execução.
    //
    // ★ C1/C4 (auditoria 2026-08-19) — e nem para quem ainda está EM VOO.
    // `unreached` sozinho não bastava aqui: ao contrário do "Disparar
    // novamente" (que I10 recusa enquanto `countInFlight > 0`), o tick volta a
    // cada 5–60 minutos por cima de um lote que leva HORAS para drenar. Com
    // 13.000 eleitores e o teto de 24h do tier, o tick seguinte encontrava
    // ~12.500 linhas ainda QUEUED e criava uma segunda para cada uma.
    // A.4 — `audience` (o público) vem junto com `where` (o recorte do tick):
    // o primeiro é o DENOMINADOR gravado em `totalRecipients`, o segundo é
    // quem de fato é enfileirado agora.
    const { audience, where } = await this.resolveAudience(
      campaign,
      'unreached-idle',
    );
    const variableMap = campaign.variableMap as unknown as VariableMap;
    const config = campaign.scheduleConfig as unknown as ScheduleConfig;
    const correlationId = this.readCorrelationId();

    const { queued } = await this.dispatchAudience({
      campaignId: id,
      where,
      variableMap,
      templateId: campaign.templateId,
      defaultInstanceId: campaign.defaultInstanceId,
      correlationId,
      purposeKey: campaign.purposeKey ?? null,
      override: campaign.override ?? false,
      overrideJustification: campaign.overrideJustification ?? null,
      excludeAnyPreviousCampaign: campaign.excludeAnyPreviousCampaign ?? false,
      // Use `message.id` (uniquely generated per row) so concurrent scheduler
      // ticks reading the same `runCount` can't collide on the same `jobId` and
      // have BullMQ silently dedupe — that path used to strand half the
      // freshly-created Messages in QUEUED forever.
      makeJobId: (contactId, messageId) =>
        createHash('sha256')
          .update(`${id}:${contactId}:${messageId}`)
          .digest('hex'),
    });

    // A3 — cancel() may have landed while we were dispatching this batch. The
    // initial `campaign` read is now stale, so re-read right before markRan and
    // abort if it was cancelled: markRan would otherwise flip the campaign back
    // to RUNNING and re-enable a recurring schedule ("un-cancelling" it). The
    // messages we just created are guarded at send time by the worker's
    // CANCELLED check and the A2 claim.
    const fresh = await this.repo.findById(id);
    if (!fresh || fresh.status === 'CANCELLED') {
      this.logger.warn(
        `runScheduled(${id}): campaign was cancelled during dispatch — skipping markRan to avoid resurrecting it.`,
      );
      return { queued };
    }

    const now = new Date();
    const next = computeNextRun(config, now, campaign.timezone, now);
    // markRan is itself conditional (WHERE status notIn CANCELLED) and returns
    // the affected-row count. count===0 means a cancel slipped in between the
    // re-read and the update (TOCTOU) — treat it as "did not run" and skip the
    // scheduled_run audit so metrics don't claim a dispatch that was undone.
    // A.4 — o que vai para `totalRecipients` é o PÚBLICO ELEGÍVEL VIVO desta
    // execução, não os `queued` deste tick. Gravar o pendente fazia a barra de
    // progresso dividir por um denominador que encolhia a cada rodada —
    // ">100%" e "0 destinatários" saíam daqui.
    const totalRecipients = await this.repo.countContactsByWhere(audience);
    const ranCount = await this.repo.markRan(id, now, next, totalRecipients);
    if (ranCount === 0) {
      this.logger.warn(
        `runScheduled(${id}): markRan matched 0 rows (cancelled mid-flight) — skipping audit.`,
      );
      return { queued };
    }

    await this.audit.log('campaign.scheduled_run', 'Campaign', id, {
      recipients: queued,
      runCount: campaign.runCount + 1,
      nextRunAt: next?.toISOString() ?? null,
    });

    // Mesmo motivo do run(): uma campanha AGENDADA cuja audiência foi 100%
    // pulada pelo gate não enfileira job nenhum, e sem isto ficaria RUNNING
    // eternamente. (maybeCompleteCampaign é no-op se a campanha ainda tem
    // mensagens em voo ou se um lote seguinte ainda tem pendentes.)
    await this.maybeCompleteCampaign(id);

    return { queued };
  }

  list() {
    return this.repo.listAll();
  }

  async getById(id: string) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    const statusCounts = await this.repo.groupMessagesByStatus(id);
    const countOf = (status: string) =>
      statusCounts.find((g) => g.status === status)?._count ?? 0;
    // GATE SILENCIOSO — os pulados JÁ vinham em `statusCounts` (o groupBy não
    // filtra status), mas nenhum agregado os somava: a tela mostrava zero em
    // TODOS os contadores e o operador concluía que o sistema tinha quebrado.
    // Derivamos o número aqui para que a UI não tenha que redescobrir a regra.
    const skippedNoConsent = countOf('SKIPPED_NO_CONSENT');
    const skippedSuppressed = countOf('SKIPPED_SUPPRESSED');
    const skippedLegacy = countOf('SKIPPED_NO_OPTIN');
    // F2 T8 — `countOf('FAILED')` conta LINHAS de Message FAILED, não
    // CONTATOS distintos: uma pessoa com 3 tentativas FAILED nesta campanha
    // infla esse número em 3x. `countUnreachedFailedContacts` (repo, Fase 0)
    // já filtra INDETERMINATE e quem já tem uma irmã entregue/em voo — é o
    // número que "Reenviar falhas" REALMENTE vai reenfileirar.
    // C2 — e, desde que o reenvio passou a respeitar a regra do mesmo template,
    // com o MESMO predicado das campanhas irmãs. Contar sem ele faria o botão
    // prometer N e enviar menos.
    const retryableFailedCount = await this.repo.countUnreachedFailedContacts(
      id,
      await this.sameTemplateExclusion(
        id,
        campaign.templateId,
        campaign.excludeAnyPreviousCampaign,
      ),
    );
    return {
      ...campaign,
      statusCounts,
      skippedNoConsent,
      skippedSuppressed,
      skippedTotal: skippedNoConsent + skippedSuppressed + skippedLegacy,
      retryableFailedCount,
    };
  }

  /**
   * APAGAR uma campanha — de vez.
   *
   * O que isto DESTRÓI (via `onDelete: Cascade` no schema):
   *   • as Message da campanha — que são as BOLHAS DO INBOX
   *     (`Message.conversationId`). Apagar uma campanha que ENVIOU de verdade
   *     arranca essas bolhas das conversas: o contato responde a uma mensagem que
   *     não aparece mais no histórico do operador. A tela avisa disso ANTES, com
   *     o número de mensagens, e exige confirmação.
   *   • os CampaignBatch (Cascade).
   *
   * O que SOBREVIVE, por construção do schema — e é o que importa juridicamente:
   *   • ConsentEvent: não tem FK para Campaign, e há TRIGGER no banco proibindo
   *     UPDATE/DELETE. O consentimento é prova; nenhum "apagar campanha" o toca.
   *   • ZernioBroadcast: `SetNull` — o histórico do disparo no Zernio continua.
   *   • AuditEvent: sem FK (entityType/entityId), sobrevive.
   *
   * Campanha EM VOO (QUEUED/RUNNING) é recusada: ver CampaignInFlightError.
   */
  async remove(id: string) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);

    if (campaign.status === 'QUEUED' || campaign.status === 'RUNNING') {
      throw new CampaignInFlightError(campaign.status);
    }

    await this.repo.delete(id);

    await this.audit.log('campaign.delete', 'Campaign', id, {
      name: campaign.name,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
    });

    return { deleted: true as const, id };
  }

  /**
   * F1 T9 — quais Segmentos ficam com um filtro "furado" se `id` for apagada.
   * `Message.campaignId` é `onDelete: Cascade` (ver `remove` acima): apagar a
   * campanha apaga também o registro de quem já recebeu dela, e um Segment com
   * um nó history `{campaignIds:[id]}` para de excluir essas pessoas
   * silenciosamente — elas voltam a entrar em qualquer filtro/segmento que o
   * cite. É o que alimenta o aviso na tela de apagar (ANTES do clique).
   */
  async getDependentSegments(
    id: string,
  ): Promise<{ id: string; name: string }[]> {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);

    const segments = await this.segmentsRepo.findAllWithFilters();
    return findSegmentsReferencingCampaign(segments, id);
  }

  async cancel(id: string) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    const wasScheduled = campaign.scheduleEnabled;
    const result = await this.repo.cancelAndDisableSchedule(id);

    // Drain BullMQ jobs targeting this campaign so delayed messages don't
    // fire tomorrow morning and waiting jobs don't slip through the worker.
    // The worker also guards on campaign.status, so this is belt-and-braces.
    const drained = await this.drainPendingJobs(id);

    // Flip every still-QUEUED message to CANCELLED. The campaign-level
    // status is already CANCELLED; this just keeps the per-message metric
    // honest (so "Na fila" doesn't display N pending forever).
    const cancelledMessages = await this.repo.cancelQueuedMessages(id);

    // ★ ZB — O KILL-SWITCH DO BROADCAST.
    //
    // Drenar a fila do orgamind NÃO PARA um broadcast do Zernio: as mensagens já
    // estão LÁ DENTRO, e o Zernio segue disparando alegremente as centenas que
    // recebeu. Sem isto, "Cancelar campanha" seria uma mentira — e este é o mesmo
    // caminho que o kill-switch automático usa (queda de qualityRating, `131031`
    // conta bloqueada, `132015` template pausado), porque ele chama `cancel()`.
    //
    // Vai por FILA, não por chamada direta: cancelar N disparos são N chamadas
    // HTTP ao Zernio, e uma falha de rede não pode derrubar o cancelamento da
    // campanha (o operador apertaria "Cancelar", veria um erro, e a campanha
    // continuaria RUNNING). O cancel do orgamind é instantâneo; o do Zernio é
    // retentado pelo BullMQ. Best-effort no enqueue pelo mesmo motivo.
    await this.broadcastCancelQueue
      ?.add(
        'cancel',
        { campaignId: id },
        { jobId: `zernio-cancel:${id}:${Date.now()}` },
      )
      .catch((e) =>
        this.logger.error(
          { err: e, campaignId: id },
          'KILL-SWITCH: falhou ao enfileirar o cancelamento dos broadcasts do Zernio — ' +
            'eles podem AINDA ESTAR DISPARANDO',
        ),
      );

    await this.audit.log('campaign.cancel', 'Campaign', id, {
      wasScheduled,
      drainedJobs: drained,
      cancelledMessages,
    });
    return result;
  }

  /**
   * Remove every BullMQ job (delayed / waiting / prioritized / paused) whose
   * payload references the given campaignId. Active jobs are intentionally
   * left alone — they'll be in-flight on the worker; the worker's
   * status-CANCELLED guard handles them. Returns the number of jobs removed.
   */
  private async drainPendingJobs(campaignId: string): Promise<number> {
    const states = ['delayed', 'waiting', 'paused', 'prioritized'] as const;
    let removed = 0;
    const jobs = await this.sendQueue.getJobs(states as never);
    for (const job of jobs) {
      if (job.data?.campaignId !== campaignId) continue;
      try {
        await job.remove();
        removed += 1;
      } catch {
        // Job likely transitioned to active between getJobs and remove —
        // the worker guard will catch it.
      }
    }
    return removed;
  }

  /**
   * Transition the campaign to a terminal status when no QUEUED messages
   * remain. Idempotent + safe to call repeatedly from the worker and
   * webhook paths.
   *
   * Rules (only fire when no QUEUED rows remain):
   * - any (SENT | DELIVERED | READ) ≥ 1 → COMPLETED (partial-success is
   *   still COMPLETED — failure rate is visible in the metrics)
   * - 100% FAILED/CANCELLED → FAILED at the campaign level
   *
   * Skipped silently for terminal-status campaigns (COMPLETED / FAILED /
   * CANCELLED) and DRAFT campaigns (no messages yet).
   *
   * Read-receipts caveat: many users disable WhatsApp read confirmations,
   * so "all READ" is not a reliable completion signal. We require only
   * that the QUEUED list is empty — DELIVERED/READ continue to arrive as
   * post-completion metrics.
   */
  async maybeCompleteCampaign(campaignId: string): Promise<void> {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) return;
    const status = campaign.status;
    if (
      status === 'COMPLETED' ||
      status === 'FAILED' ||
      status === 'CANCELLED' ||
      status === 'DRAFT'
    ) {
      return;
    }

    const grouped = await this.repo.groupMessagesByStatus(campaignId);
    // Nenhuma Message materializada ainda: a campanha acabou de ser reivindicada
    // e o dispatch está no meio do caminho. Concluí-la aqui seria fechá-la antes
    // de ela existir.
    if (grouped.length === 0) return;
    // Non-terminal states that MUST count as pending, or the campaign completes
    // while some recipients have not been (successfully) messaged:
    // - QUEUED / SENDING: in flight; a concurrent worker's markSent could
    //   otherwise complete the campaign while a sibling is still sending (and if
    //   that message later fails, the campaign is already terminal and never
    //   re-evaluates).
    // - WAITING_INSTANCE: parked because the routed instance is offline. These
    //   are replayed (WAITING_INSTANCE -> QUEUED -> sent) when the instance
    //   reconnects. Completing now would mark the campaign done though those
    //   recipients were never contacted, and the terminal status would block
    //   re-completion after the replay (permanently wrong finishedAt/audit).
    const stillPending = grouped.some(
      (g) =>
        g.status === 'QUEUED' ||
        g.status === 'SENDING' ||
        g.status === 'WAITING_INSTANCE',
    );
    if (stillPending) return;

    // ZE — numa campanha EM LOTES, "nenhuma mensagem em voo" não significa
    // "acabou": significa que o lote atual escoou e a campanha está esperando o
    // próximo. Ela só termina quando não sobra NINGUÉM pendente na audiência.
    //
    // O guard é restrito às campanhas que têm lotes de propósito. No "Disparar"
    // clássico a audiência inteira é enfileirada de uma vez, e uma falha
    // transitória devolveria o contato à lista de pendentes — travando a
    // campanha em RUNNING para sempre. Aquele fluxo mantém a semântica de
    // sempre: sem mensagem em voo, acabou.
    //
    // A consulta só roda DEPOIS do short-circuit acima, então na prática ela
    // acontece uma vez por lote (quando a última mensagem dele termina), e não a
    // cada mensagem.
    const batchCount = await this.repo.countBatches(campaignId);
    if (batchCount > 0) {
      const { where } = await this.resolveAudience(campaign, 'pending');
      const pending = await this.repo.countContactsByWhere(where);
      if (pending > 0) return; // segue EM ANDAMENTO
    }

    const totalSucceeded = grouped
      .filter(
        (g) =>
          g.status === 'SENT' ||
          g.status === 'DELIVERED' ||
          g.status === 'READ',
      )
      .reduce((acc, g) => acc + g._count, 0);

    const countOf = (status: string) =>
      grouped.find((g) => g.status === status)?._count ?? 0;
    const failed = countOf('FAILED');
    const skippedNoConsent = countOf('SKIPPED_NO_CONSENT');
    const skippedSuppressed = countOf('SKIPPED_SUPPRESSED');

    // GATE SILENCIOSO — "zero enviadas" NÃO é sinônimo de FALHA.
    //
    // Uma campanha cuja audiência inteira foi BLOQUEADA pelo gate de
    // consentimento não falhou: ela foi corretamente impedida de enviar. Marcá-la
    // FAILED mandaria o operador caçar um erro que não existe (foi exatamente o
    // que aconteceu: ele passou horas achando que era o horário/agendamento). A
    // verdade — "0 enviadas, 2 bloqueadas por falta de consentimento" — vem do
    // CONTADOR, não do status. FAILED fica reservado para falhas REAIS de envio.
    const nextStatus =
      totalSucceeded > 0 ? 'COMPLETED' : failed > 0 ? 'FAILED' : 'COMPLETED';
    await this.repo.updateStatus(campaignId, nextStatus, {
      finishedAt: new Date(),
    });
    await this.audit.log(
      nextStatus === 'COMPLETED' ? 'campaign.completed' : 'campaign.failed',
      'Campaign',
      campaignId,
      { totalSucceeded, failed, skippedNoConsent, skippedSuppressed },
    );
  }

  async listMessages(
    campaignId: string,
    query: {
      page: number;
      pageSize: number;
      status?: MessageStatus;
      search?: string;
    },
  ) {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);
    return this.repo.listMessages({ campaignId, ...query });
  }

  /**
   * Redispatch a single contact: devolve à fila A PRÓPRIA linha da mensagem, com
   * as variáveis reavaliadas a partir do contato (que pode ter sido corrigido) e
   * o canal atual da campanha.
   *
   * NÃO cria uma linha nova — e é aí que morava o "3 de 2". O denominador da
   * campanha conta CONTATOS (`totalRecipients`); o numerador (pulados, enviados)
   * conta LINHAS DE MENSAGEM. Clonar a linha a cada redisparo fazia o numerador
   * crescer sobre um denominador fixo: campanha com 2 destinatários exibindo 3
   * pulados, barra de distribuição em 150%.
   *
   * A invariante que isto preserva — UMA linha por contato por campanha — é a
   * mesma que `createSkippedMessage` já mantinha do lado do gate. É ela que
   * impede pulados e destinatários de divergirem.
   */
  async redispatchMessage(messageId: string) {
    const original = await this.repo.findMessageById(messageId);
    if (!original) throw new MessageNotFoundError(messageId);
    if (!original.campaignId || !original.contactId)
      throw new MessageNotFoundError(messageId);

    // ★ C12 (auditoria 2026-08-19) — NÃO SE REDISPARA UMA LINHA EM VOO.
    //
    // A UI renderiza este botão para QUALQUER status. Com a linha em SENDING o
    // worker está DENTRO do `wa.send` (minutos, no broadcast do Zernio):
    // devolvê-la a QUEUED a torna reivindicável de novo, um segundo worker a
    // reivindica e envia, e o primeiro conclui o dele — duas entregas a partir
    // de UMA linha, exatamente o que o claim atômico existe para impedir.
    // QUEUED/WAITING_INSTANCE não duplicam entrega (o claim é por linha), mas
    // recusá-los é grátis e evita jobs órfãos competindo pela mesma linha.
    if (
      original.status === 'SENDING' ||
      original.status === 'QUEUED' ||
      original.status === 'WAITING_INSTANCE'
    ) {
      throw new MessageNotRetryableError(original.status);
    }

    const campaign = await this.repo.findById(original.campaignId);
    if (!campaign) throw new CampaignNotFoundError(original.campaignId);

    const contact = await this.repo.findContactById(original.contactId);
    if (!contact) throw new MessageNotFoundError(original.contactId);

    // ★ C12 (2ª rodada) — E NEM QUANDO O CONTATO TEM OUTRA LINHA VIVA.
    //
    // A guarda acima olha só o status DESTA linha. Não basta: desde a trava de
    // banco ("uma linha viva por campanha+contato"), mover esta linha para
    // QUEUED é ILEGAL se o mesmo contato já tem outra viva na campanha — e esse
    // é o caso NORMAL da retomada por lotes (o lote 1 falhou por queda
    // transitória, o lote 2 recriou a linha de propósito). A tabela de
    // mensagens renderiza "Disparar novamente" em todas as linhas; sem esta
    // pergunta, o clique na FAILED antiga estourava P2002 lá no banco e o
    // operador levava um 500 genérico + Sentry, sem explicação nenhuma.
    //
    // `original.id` sai da conta: a própria linha clicada pode estar
    // SENT/DELIVERED/READ (redisparar uma entregue é legítimo — é a saída
    // manual do incidente do 9º dígito), e ela não é irmã dela mesma.
    const irmaViva = await this.repo.hasReachedOrInFlightSibling(
      original.campaignId,
      original.contactId,
      original.id,
    );
    if (irmaViva) throw new MessageContactAlreadyReachedError();

    const variableMap = campaign.variableMap as unknown as VariableMap;
    const variables: Record<string, string> = {};
    for (const [key, mapping] of Object.entries(variableMap)) {
      if (mapping.source === 'literal') variables[key] = mapping.value;
      else
        variables[key] = String(
          (contact as unknown as Record<string, unknown>)[mapping.field] ?? '',
        );
    }

    // A4 — serialise per campaign so a double-click can't create two new rows
    // (two sends to one contact). Shares the single 'resend' lock with
    // retry/redispatchCampaign so those can't run concurrently either.
    return this.withCampaignLock(campaign.id, 'resend', async () => {
      // A MESMA linha volta para a fila. Nada de clone — ver o doc acima ("3 de 2").
      //
      // C12 — a escrita é condicional e devolve o count. `0` significa que a
      // linha deixou de ser redisparável entre a leitura e agora (o worker a
      // reivindicou): não há nada a enfileirar, e enfileirar assim mesmo
      // publicaria um job sobre uma linha que outro ator está enviando.
      const pegou = await this.repo.resetForRedispatch(original.id, {
        instanceId: campaign.defaultInstanceId,
        variables: variables as Prisma.InputJsonValue,
      });
      // A pergunta feita antes do lock é TOCTOU: entre ela e esta escrita o
      // contato pode ter ganhado uma linha viva. Quem recusa aí é o BANCO, e a
      // recusa dele tem de chegar ao operador como a MESMA conversa ("este
      // contato já recebeu"), nunca como erro inesperado.
      if (pegou === 'contact_already_live') {
        throw new MessageContactAlreadyReachedError();
      }
      if (pegou !== 'ok') {
        throw new MessageNotRetryableError(original.status);
      }

      const correlationId = this.readCorrelationId();
      const jobId = createHash('sha256')
        .update(
          `${campaign.id}:${contact.id}:redispatch_one:${Date.now()}:${original.id}`,
        )
        .digest('hex');

      await this.enqueueOrFail({
        messageId: original.id,
        campaignId: campaign.id,
        correlationId,
        jobId,
      });

      if (
        campaign.status === 'COMPLETED' ||
        campaign.status === 'FAILED' ||
        campaign.status === 'CANCELLED'
      ) {
        await this.repo.updateStatus(campaign.id, 'RUNNING');
      }

      await this.audit.log('message.redispatch', 'Message', original.id, {
        campaignId: campaign.id,
        contactId: contact.id,
        // Mesma linha: o redisparo reaproveita a mensagem clicada, não a clona.
        originalMessageId: messageId,
      });

      return { queued: 1, messageId: original.id };
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ I15 (revisão de integração) — A SAÍDA EM MASSA PARA O NÚMERO BANIDO.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ── A PERGUNTA QUE SÓ O DONO SABE RESPONDER ─────────────────────────────────
   *
   * Uma campanha CANCELADA bloqueia também o que ficou em `SENT`, e a régua está
   * certa: cancelar não cancela o que já está NO PROVEDOR. Mas há DOIS motivos
   * para cancelar, indistinguíveis pelo banco e opostos na consequência:
   *
   *   • MUDEI DE IDEIA → as `SENT` chegaram → bloquear é o certo, e liberar
   *     mandaria a mesma propaganda duas vezes para as mesmas pessoas;
   *   • O CANAL MORREU (o número foi banido no meio do disparo — o histórico
   *     desta operação) → as `SENT` nunca chegaram, e nunca vão: nos canais sem
   *     polling de status é ali que a mensagem fica presa para sempre. Bloquear
   *     queima aquele template para aquela gente, e a única válvula que existia
   *     era uma linha por clique.
   *
   * Só quem cancelou sabe qual dos dois foi. Então o sistema NÃO adivinha: ele
   * pergunta. `previewUnconfirmedSent` mostra o tamanho do estrago
   * ("N mensagens desta campanha saíram e nunca tiveram confirmação"), e
   * `releaseUnconfirmedSent` executa a declaração do dono — explícita
   * (`confirm`), com motivo opcional em texto livre, e registrada no audit com
   * o número real.
   *
   * ── AS TRAVAS, E POR QUE CADA UMA ───────────────────────────────────────────
   *
   *  1. só campanha CANCELADA. Cancelar é um ato visível e anterior; ele também
   *     garante que nada mais está saindo por ali enquanto a liberação roda.
   *  2. só `SENT`. `DELIVERED`/`READ` são prova de chegada e ficam intocados —
   *     nem a pedido do operador. Isto NÃO é um botão de "mandar de novo para
   *     todo mundo", e a diferença entre as duas coisas é exatamente esta linha.
   *  3. `confirm` obrigatório, depois da prévia: o número na tela e o "sim, são
   *     essas" são dois passos.
   *  4. sob o MESMO lock 'resend' dos outros caminhos de reenvio, para não
   *     correr contra um disparo/retomada da mesma campanha.
   *
   * O que a liberação NÃO faz: enfileirar nada. Ela só devolve aquelas pessoas
   * à condição de alcançáveis (as linhas viram FALHA, e falha não bloqueia em
   * camada nenhuma). Quem decide o que enviar, por qual canal e quando continua
   * sendo o operador, no fluxo normal de criar a campanha nova.
   *
   * ── O QUE CONTINUA SENDO DECISÃO DE PRODUTO, E ESTÁ AQUI PARA O DONO VER ────
   *
   * O mecanismo é neutro de propósito. O que NÃO cabe ao backend decidir:
   * (a) se a tela deve oferecer isso no próprio diálogo de cancelamento
   *     ("por que está cancelando?"), o que capturaria a intenção no momento em
   *     que ela existe, em vez de depender do operador lembrar depois;
   * (b) se a liberação deveria ser automática quando o cancelamento vier de um
   *     kill-switch de BANIMENTO (131031 e afins), onde a resposta é conhecida
   *     pelo sistema. As duas melhorias exigem gravar o MOTIVO do cancelamento
   *     na campanha — uma coluna nova, fora do alcance deste pacote.
   */
  async previewUnconfirmedSent(id: string) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    const unconfirmedSent = await this.repo.countUnconfirmedSent(id);
    return {
      campaignId: id,
      campaignStatus: campaign.status,
      // `releasable` responde à pergunta que a tela precisa fazer ANTES de
      // mostrar o botão: numa campanha que não está cancelada o número existe,
      // mas a porta está fechada — e dizer isso é melhor do que sumir com ela.
      releasable: campaign.status === 'CANCELLED',
      unconfirmedSent,
    };
  }

  async releaseUnconfirmedSent(
    id: string,
    opts: { confirm: boolean; reason?: string },
  ) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    if (campaign.status !== 'CANCELLED') {
      throw new CampaignNotCancelledError(campaign.status);
    }
    if (!opts.confirm) throw new CampaignReleaseNotConfirmedError();

    return this.withCampaignLock(id, 'resend', async () => {
      const released = await this.repo.releaseUnconfirmedSent(id);
      await this.audit.log(
        'campaign.release_unconfirmed_sent',
        'Campaign',
        id,
        {
          // O número REAL, não o da prévia: entre uma e outra um webhook
          // atrasado pode ter confirmado algumas, e essas ficaram de fora.
          released,
          templateId: campaign.templateId,
          reason: opts.reason ?? null,
        },
      );
      return { released };
    });
  }

  /** Retry a single failed message (re-enqueue with original variables). */
  async retryMessage(messageId: string) {
    const message = await this.repo.findMessageById(messageId);
    if (!message) throw new MessageNotFoundError(messageId);
    if (message.status !== 'FAILED') {
      throw new MessageNotRetryableError(message.status);
    }
    // INDETERMINATE failures (send timeout / mid-send crash) may already have
    // been delivered+billed — refuse the auto-resend so we never duplicate.
    if (INDETERMINATE_DELIVERY_CODES.includes(message.errorCode ?? '')) {
      throw new MessageDeliveryIndeterminateError();
    }
    if (!message.campaignId) throw new MessageNotFoundError(messageId);
    const campaignId = message.campaignId;

    // A4 — serialise per campaign (retry-scoped). Two operators retrying the
    // same FAILED message would both resetForRetry → QUEUED and enqueue a job
    // with a distinct jobId; the A2 claim makes only one actually send, but we
    // still don't want two competing jobs. The lock makes the second caller
    // bounce with CampaignOperationInProgressError.
    //
    // ★ I8 (revisão de integração) — AS PERGUNTAS ENTRARAM PARA DENTRO DO LOCK.
    //
    // Elas ficavam FORA, e a escrita sempre foi DENTRO. A janela entre as duas
    // não era teórica: o operador clica "Reenviar" (as perguntas passam, o
    // contato não tem linha viva), o clique fica preso no lock porque um
    // `dispatchAudience` está rodando, o dispatch CRIA a linha viva daquele
    // contato e solta o lock — e só então o retry escreve, contra um banco que
    // mudou. Perguntar aqui dentro, com o disparo já bloqueado, fecha a maior
    // parte da janela; o que sobrar é pego pela trava de banco no
    // `resetForRetry`, que agora traduz o P2002 em vez de virar 500.
    return this.withCampaignLock(campaignId, 'resend', async () => {
      // Fase 0 §0.4 — não ressuscitar quem já foi ALCANÇADO (SENT/DELIVERED/READ)
      // ou está EM VOO (QUEUED/SENDING/WAITING_INSTANCE) por outra linha desta
      // mesma campanha: reenviar esta FAILED duplicaria a entrega.
      if (message.contactId) {
        const alreadyReached = await this.repo.hasReachedOrInFlightSibling(
          campaignId,
          message.contactId,
        );
        if (alreadyReached) {
          throw new MessageContactAlreadyReachedError();
        }

        // ★ C2/N3 (auditoria 2026-08-19) — e nem quem já recebeu o MESMO
        // TEMPLATE por uma campanha IRMÃ. Este caminho só olhava a própria
        // campanha: a campanha B falha para K, a campanha A (mesmo template)
        // entrega a K depois, e o "Reenviar" de B mandava o mesmo texto de
        // novo. É a mesma regra que o funil de audiência já aplica — aqui ela
        // faltava.
        //
        // A régua inclui `SENT` de campanha CANCELADA (C14). O risco disso — um
        // `SENT` que nunca chega, incidente do 9º dígito — e as DUAS saídas do
        // operador estão documentados em `CANCELLED_CAMPAIGN_BLOCKING_STATUSES`
        // (batch-audience.ts): `redispatchMessage` (uma linha, não consulta
        // esta rede de propósito) e, para o caso de canal banido, a liberação
        // EM MASSA das não confirmadas daquela campanha cancelada.
        const campaign = await this.repo.findById(campaignId);
        const bloqueio = campaign
          ? await this.sameTemplateExclusion(
              campaignId,
              campaign.templateId,
              campaign.excludeAnyPreviousCampaign,
            )
          : null;
        if (
          bloqueio &&
          (await this.repo.hasBlockingSibling(bloqueio, message.contactId))
        ) {
          throw new MessageContactAlreadyReachedError();
        }
      }

      // I8 — a escrita é condicional e devolve POR QUE não pegou. As perguntas
      // acima continuam sendo TOCTOU contra qualquer ator fora deste lock; a
      // recusa do BANCO tem de chegar ao operador como a MESMA conversa ("este
      // contato já recebeu"), nunca como erro inesperado.
      const pegou = await this.repo.resetForRetry(messageId);
      if (pegou === 'contact_already_live') {
        throw new MessageContactAlreadyReachedError();
      }
      if (pegou !== 'ok') {
        throw new MessageNotRetryableError(message.status);
      }

      const correlationId = this.readCorrelationId();
      // Distinct jobId so BullMQ doesn't dedupe with the original failed job.
      const jobId = createHash('sha256')
        .update(`${campaignId}:${message.contactId}:retry:${Date.now()}`)
        .digest('hex');

      await this.enqueueOrFail({
        messageId,
        campaignId,
        correlationId,
        jobId,
      });

      await this.audit.log('message.retry', 'Message', messageId, {
        campaignId,
      });

      return { queued: 1 };
    });
  }

  /**
   * Redispatch the campaign. Unlike run() (which requires DRAFT) and
   * retryFailedMessages() (which only retries the messages that ended in
   * FAILED), this creates a brand new batch — useful for "send it again"
   * flows while the campaign is still RUNNING or after it has terminated.
   * Filters are re-evaluated, so contacts added after the original run get
   * the message too.
   *
   * Fase 0 §0.2 — default (`resendToAll: false`) is the UNREACHED cut: it does
   * NOT resend to whoever already received (SENT/DELIVERED/READ), only
   * reaches whoever the campaign hasn't reached yet — which includes
   * re-evaluating the consent gate for contacts it skipped before. That was
   * the bug review caught: this button used to reopen the WHOLE audience
   * unconditionally, resending to everyone every time. `resendToAll: true` is
   * the explicit, deliberate escape hatch back to the full audience.
   */
  async redispatchCampaign(id: string, resendToAll = false) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    if (campaign.status === 'DRAFT') {
      // DRAFT must go through the normal run() flow (atomic transition).
      throw new CampaignAlreadyDispatchedError(
        'campaign is DRAFT — use POST /run instead',
      );
    }

    // A4 — serialise per campaign. redispatch creates a WHOLE NEW batch of
    // Message rows; two concurrent redispatches = two batches = every contact
    // messaged twice (a ban signal). The A2 claim only dedupes a single row,
    // so this lock is the real defence here.
    return this.withCampaignLock(id, 'resend', async () => {
      // I10 — refuse to start a NEW batch while the previous one is still in
      // flight. The lock only prevents concurrent dispatches; with tier
      // batching a batch can drain over several days, and firing "Disparar
      // novamente" during that window would enqueue a second, fully overlapping
      // batch (every contact messaged twice → double cost + a ban signal).
      const inFlight = await this.repo.countInFlight(id);
      if (inFlight > 0) {
        throw new CampaignOperationInProgressError();
      }

      const { where } = await this.resolveAudience(
        campaign,
        resendToAll ? 'full' : 'unreached',
      );

      // Antes de dispatchAudience, se não há a quem reenviar, é erro de
      // operador, não conclusão silenciosa da campanha: com `unreached`,
      // "ninguém a alcançar" é o caso normal de uma campanha já 100%
      // entregue, não motivo para reavaliar/fechar o status sozinha. Isto
      // cobre SÓ count===0 — o caso residual (count>0 mas o gate de
      // consentimento barra 100% da página, ver `maybeCompleteCampaign` mais
      // abaixo) não é avaliado aqui.
      const count = await this.repo.countContactsByWhere(where);
      if (count === 0) throw new CampaignNoPendingRecipientsError();

      const variableMap = campaign.variableMap as unknown as VariableMap;
      const correlationId = this.readCorrelationId();

      const { queued, skippedAlreadyLive } = await this.dispatchAudience({
        campaignId: id,
        where,
        variableMap,
        templateId: campaign.templateId,
        defaultInstanceId: campaign.defaultInstanceId,
        correlationId,
        purposeKey: campaign.purposeKey ?? null,
        override: campaign.override ?? false,
        overrideJustification: campaign.overrideJustification ?? null,
        excludeAnyPreviousCampaign: campaign.excludeAnyPreviousCampaign ?? false,
        // ★ "Disparar novamente para TODOS" é o ÚNICO caminho que reenvia a
        // quem já recebeu — e, desde a trava de banco (uma linha viva por
        // campanha+contato), ele faz isso RESSUSCITANDO a linha existente em
        // vez de criar uma segunda. Para o operador nada muda; o que muda é que
        // a campanha continua com uma linha por pessoa.
        resendReached: resendToAll,
        // Distinct jobId so BullMQ never dedupes against earlier runs.
        makeJobId: (contactId, messageId) =>
          createHash('sha256')
            .update(`${id}:${contactId}:redispatch:${Date.now()}:${messageId}`)
            .digest('hex'),
      });

      // We just enqueued a fresh in-flight batch, so the campaign IS running —
      // set it unconditionally when anything was queued. Using `queued > 0`
      // rather than the PRE-LOCK `campaign.status` snapshot avoids a race where
      // the first batch's completion landed between the pre-lock read and here,
      // which would otherwise leave a hidden batch sending under a COMPLETED
      // campaign (updateStatus to RUNNING when already RUNNING is a no-op).
      if (queued > 0) {
        await this.repo.updateStatus(id, 'RUNNING');
      } else {
        // count>0 mas queued===0: a audiência remanescente foi 100% barrada
        // pelo gate (SKIPPED_*, que não passam pela fila) — nenhum worker
        // fecharia a campanha depois. Mesma rede de segurança de
        // run()/runScheduledLocked()/sendBatch().
        await this.maybeCompleteCampaign(id);
      }

      await this.audit.log('campaign.redispatch', 'Campaign', id, {
        recipients: queued,
        skippedAlreadyLive,
      });

      // `skippedAlreadyLive` acompanha `queued` porque "0 enviadas" sozinho não
      // é uma resposta: com um lote ainda drenando, ele significa "todo mundo
      // já está a caminho", e é isso que a tela precisa poder dizer.
      return { queued, skippedAlreadyLive };
    });
  }

  /** Retry all failed messages in a campaign (bulk). */
  async retryFailedMessages(campaignId: string) {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);

    // A4 — serialise per campaign (retry-scoped, shared with retryMessage).
    // Two concurrent bulk retries would both read the same FAILED set, both
    // resetForRetry → QUEUED and both enqueue jobs with distinct jobIds =
    // duplicate competing jobs. The lock makes the second caller bounce.
    return this.withCampaignLock(campaignId, 'resend', async () => {
      // ★ C2 (auditoria 2026-08-19) — o retry em massa era o único caminho de
      // reenvio que nunca consultava a regra "ninguém recebe o mesmo template
      // duas vezes". Calculado DENTRO do lock, para valer no instante do
      // reenvio (uma irmã pode ter nascido depois do clique).
      const bloqueio = await this.sameTemplateExclusion(
        campaignId,
        campaign.templateId,
        campaign.excludeAnyPreviousCampaign,
      );
      const failed = await this.repo.findFailedMessageIds(
        campaignId,
        bloqueio,
      );
      const correlationId = this.readCorrelationId();

      let queued = 0;
      // ★ I8 (revisão de integração) — O CONTADOR CONTA O QUE PEGOU.
      //
      // Antes somava `chunk.length` inteiro e ignorava o retorno do reset. Com
      // o reset condicional isso viraria duas mentiras: (a) uma linha que
      // DEIXOU de estar FAILED entre a leitura e a escrita — ou que a trava de
      // banco recusou porque o contato ganhou outra linha viva — não voltava
      // para QUEUED, mas ganhava um job mesmo assim, e o worker o descartava
      // em silêncio (`claimForSend` exige QUEUED); (b) o número devolvido ao
      // operador prometia mais do que saiu, que é exatamente a prévia mentindo
      // — o defeito que esta auditoria já consertou no outro lado.
      //
      // Antes desta correção o `P2002` também não era recusa: era um 500 no
      // MEIO do lote, abortando o reenvio das linhas seguintes.
      for (let i = 0; i < failed.length; i += DISPATCH_CHUNK_SIZE) {
        const chunk = failed.slice(i, i + DISPATCH_CHUNK_SIZE);
        const pegos = await Promise.all(
          chunk.map(async (m) => {
            const pegou = await this.repo.resetForRetry(m.id);
            if (pegou !== 'ok') return 0;
            const jobId = createHash('sha256')
              .update(
                `${campaignId}:${m.contactId}:retry:${Date.now()}:${m.id}`,
              )
              .digest('hex');
            await this.enqueueOrFail({
              messageId: m.id,
              campaignId,
              correlationId,
              jobId,
            });
            return 1;
          }),
        );
        queued += pegos.reduce<number>((a, b) => a + b, 0);
      }

      // Re-open campaign if it ended in any terminal status — we're sending
      // again. Without `CANCELLED` the messages would be enqueued behind the
      // scenes while the campaign appears "cancelled" to the operator.
      if (
        queued > 0 &&
        (campaign.status === 'COMPLETED' ||
          campaign.status === 'FAILED' ||
          campaign.status === 'CANCELLED')
      ) {
        await this.repo.updateStatus(campaignId, 'RUNNING');
      }

      await this.audit.log('campaign.retry_failed', 'Campaign', campaignId, {
        count: queued,
      });

      return { queued };
    });
  }

  async run(id: string) {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);

    // T7 — re-validate template×channel provider at dispatch time too: the
    // template or channel may have been edited (or the channel reassigned)
    // after the campaign was created in DRAFT. This early check is
    // INTENTIONALLY kept even though dispatchAudience() now runs the same
    // guard (covering runScheduledLocked()/redispatchCampaign(), which have
    // no equivalent checkpoint of their own): this one runs BEFORE the
    // resend lock and the atomic DRAFT->QUEUED/RUNNING transition below, so a
    // mismatch never claims those state changes — the campaign is left
    // cleanly in DRAFT to fix and re-run, instead of stuck RUNNING with zero
    // messages queued and a consumed one-shot schedule.
    await this.assertTemplateProviderMatchesChannel(
      campaign.templateId,
      campaign.defaultInstanceId,
    );

    // Bug 2 — hold the SAME per-campaign 'resend' lock the scheduler (runScheduled)
    // uses, so a manual "Disparar" and a scheduler tick can't both dispatch this
    // campaign concurrently (the DRAFT->QUEUED claim alone doesn't stop the
    // scheduler, which uses markRan). A concurrent holder bounces the caller with
    // CampaignOperationInProgressError.
    return this.withCampaignLock(id, 'resend', async () => {
      // FASE 0 §0.1 — o mesmo motivo do preflight acima: 'unreached' é
      // inócuo no caso comum (campanha DRAFT, sem Message ainda) e correto
      // quando "Disparar" é chamado numa campanha que já rodou.
      const { audience, where } = await this.resolveAudience(
        campaign,
        'unreached',
      );
      // A.4 — o denominador é o PÚBLICO (`audience`), não o recorte que este
      // disparo vai enfileirar (`where`). Reservado com um COUNT em vez de
      // materializar a lista inteira só para ler `.length`.
      const totalRecipients = await this.repo.countContactsByWhere(audience);

      // Atomic DRAFT -> QUEUED transition. If two requests race, only one
      // will see count=1; the other gets 0 and we throw the standard
      // already-dispatched error (using the freshly-read status for the
      // message, since the campaign in memory is now stale).
      //
      // A one-shot schedule (IMMEDIATE / ONCE_AT) is consumed by this manual
      // dispatch, so disarm it — otherwise the scheduler re-fires the whole
      // audience at the original nextRunAt (duplicate send). A recurring schedule
      // (DAILY_AT / WEEKLY / INTERVAL) keeps its cadence after a manual ad-hoc
      // fire and must stay armed.
      const isRecurring =
        campaign.scheduleType === 'DAILY_AT' ||
        campaign.scheduleType === 'WEEKLY' ||
        campaign.scheduleType === 'INTERVAL';
      const transitioned = await this.repo.transitionToQueued(
        id,
        totalRecipients,
        {
          disarmSchedule: !isRecurring,
        },
      );
      if (transitioned === 0) {
        const fresh = await this.repo.findById(id);
        throw new CampaignAlreadyDispatchedError(fresh?.status ?? 'UNKNOWN');
      }

      // Flip to RUNNING immediately. Previously this happened after the enqueue
      // loop, so a crash mid-loop left the campaign stuck in QUEUED forever
      // even though the worker was already processing the jobs that did land.
      // Workers don't gate on campaign status, so doing this up-front is safe.
      await this.repo.updateStatus(id, 'RUNNING');

      const variableMap = campaign.variableMap as unknown as VariableMap;

      // Pull correlationId from CLS so it propagates to the worker logger.
      const correlationId = this.readCorrelationId();

      const { queued } = await this.dispatchAudience({
        campaignId: id,
        where,
        variableMap,
        templateId: campaign.templateId,
        defaultInstanceId: campaign.defaultInstanceId,
        correlationId,
        purposeKey: campaign.purposeKey ?? null,
        override: campaign.override ?? false,
        overrideJustification: campaign.overrideJustification ?? null,
        excludeAnyPreviousCampaign: campaign.excludeAnyPreviousCampaign ?? false,
        // Include message.id so a contact appearing in multiple campaigns doesn't
        // produce colliding jobIds across campaigns (BullMQ silently dedupes by
        // jobId, which would leave the second campaign's Message stuck in QUEUED).
        makeJobId: (contactId, messageId) =>
          createHash('sha256')
            .update(`${id}:${contactId}:${messageId}`)
            .digest('hex'),
      });

      await this.audit.log('campaign.run', 'Campaign', id, {
        recipients: queued,
      });

      // GATE SILENCIOSO — quem fecha a campanha é o WORKER, depois de processar
      // a última mensagem. Se o gate pulou a audiência INTEIRA, `queued` é 0:
      // nenhum job entra no BullMQ, o worker nunca roda e ninguém nunca chama
      // maybeCompleteCampaign — a campanha fica "Em execução" para sempre (foi
      // exatamente o que o operador viu, e por isso ele achou que era o
      // horário/agendamento). Reavaliar aqui fecha o caso: sem nada em voo, a
      // campanha conclui, e os contadores explicam por que nada saiu.
      // (`sendBatch` já fazia isso; run() só não tinha replicado.)
      await this.maybeCompleteCampaign(id);

      return { queued };
    });
  }

  /**
   * Persist a job to BullMQ and, if the enqueue fails (Redis outage,
   * connection error, etc.), mark the corresponding `Message` as `FAILED`.
   * Without this guard, a Message row could be created in Postgres and never
   * have a job — leaving it stuck in `QUEUED` indefinitely with no worker
   * ever picking it up.
   */
  private async enqueueOrFail(args: {
    messageId: string;
    campaignId: string;
    correlationId: string | undefined;
    jobId: string;
  }): Promise<void> {
    try {
      await this.sendQueue.add(
        QUEUE_NAMES.WHATSAPP_SEND,
        {
          messageId: args.messageId,
          campaignId: args.campaignId,
          correlationId: args.correlationId,
        },
        { jobId: args.jobId },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const count = await this.repo.markMessageEnqueueFailed(
        args.messageId,
        errorMessage,
      );
      // count === 0 → a linha já não estava QUEUED quando o marcador rodou
      // (outro ator já a reivindicou: claimForSend, markWaitingForInstance,
      // etc.). Relançar aqui reabriria uma linha que já avançou — quem chamou
      // enqueueOrFail trataria isso como falha de enfileiramento e poderia
      // reverter estado/UX em cima de uma mensagem que já está em voo.
      if (count === 0) {
        this.logger.warn(
          `enqueueOrFail(${args.messageId}): enqueue falhou (${errorMessage}) mas a linha já não estava QUEUED — não relançando.`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Build the Prisma `select` for a dispatch read: always `id`, plus every
   * whitelisted Contact column referenced by a `field`-source variable mapping.
   * Keeping the projection narrow is what makes keyset pagination cheap (we read
   * a handful of columns per row instead of whole Contact rows).
   */
  private buildRecipientSelect(variableMap: VariableMap): Record<string, true> {
    const select: Record<string, true> = { id: true };
    for (const mapping of Object.values(variableMap)) {
      if (
        mapping.source === 'field' &&
        CONTACT_VARIABLE_COLUMNS.has(mapping.field)
      ) {
        select[mapping.field] = true;
      }
    }
    return select;
  }

  /**
   * T7 — shared template×channel provider guard. A template built for one
   * provider (e.g. a Twilio Content SID template) can't be sent through a
   * channel of a different provider (e.g. an Evolution/Baileys number) — the
   * send adapter is chosen from the CHANNEL's provider, so a mismatch would
   * either fail at the adapter or silently send the wrong content. A missing
   * template/channel is NOT flagged here — TemplateNotFoundError and the
   * INSTANCE_DELETED send-check own those cases respectively.
   *
   * Called from create() (early UX check), run() (early check, before the
   * DRAFT->QUEUED transition — see the comment there), and dispatchAudience()
   * (the authoritative, always-runs check: every path that actually sends
   * real messages — run(), runScheduledLocked(), redispatchCampaign() —
   * funnels through dispatchAudience, so checking there covers all three by
   * construction instead of relying on each caller to remember to check).
   */
  private async assertTemplateProviderMatchesChannel(
    templateId: string,
    defaultInstanceId: string,
  ): Promise<void> {
    const [template, channel] = await Promise.all([
      this.templatesRepo.findById(templateId),
      this.instancesRepo.findById(defaultInstanceId),
    ]);
    if (template && channel && template.provider !== channel.provider) {
      throw new CampaignTemplateProviderMismatchError(
        template.provider,
        channel.provider,
      );
    }

    // ZC6 — gate de campanha: SÓ APPROVED entra.
    //
    // O gate existia só no wizard do frontend, o que o tornava uma sugestão. E
    // no ZERNIO isso é perigoso de um jeito que não é nos outros provedores: lá
    // o status muda SOZINHO — a Meta pausa/desabilita um template já aprovado e
    // avisa por webhook (`template.status_updated`, ZC4). Uma campanha AGENDADA
    // em cima desse template dispararia depois da mudança, tomaria rejeição em
    // massa (132001/132015) e derrubaria o quality rating do número.
    //
    // Aqui é o lugar certo justamente porque este guard é chamado de create()
    // (UX), run() e dispatchAudience() — e TODA rota que envia de verdade
    // atravessa dispatchAudience. Reavaliar no disparo (e não só na criação) é o
    // ponto: o template pode ter sido aprovado quando a campanha foi criada e
    // não estar mais quando ela executa.
    //
    // EVOLUTION não passa por aprovação da Meta e nasce APPROVED (ver
    // TemplatesService.create), então a regra não o penaliza.
    if (template && template.status !== TemplateStatus.APPROVED) {
      throw new CampaignTemplateNotApprovedError(
        template.metaName,
        template.status,
      );
    }

    if (template) this.assertTemplateConsentButtonsUsable(template);
  }

  /**
   * ★ O GATE DO RÓTULO — a última porta antes dos 13.400.
   *
   * O Zernio não deixa definir o id/payload de um botão quick_reply: o que chega
   * quando a pessoa toca o botão é o RÓTULO, e o reconhecimento é uma LISTA
   * FECHADA. Um template de opt-in com o botão "Bora, quero!" é perfeitamente
   * APROVÁVEL pela Meta — e cada clique nele cairia no `isZernioOptInButton() →
   * false`, gravando ZERO consentimento, sem um único erro no log.
   *
   * O `POST /templates/zernio` já fecha esse loop na criação. Mas ele não é a
   * única porta: `syncFromZernio` importa TODO o catálogo da conta de hora em
   * hora, e um template criado direto no painel do Zernio (o caminho de sempre,
   * até ontem) entrava como uma row normal — aprovada e selecionável. Este gate é
   * o que torna a garantia da criação uma garantia do SISTEMA.
   *
   * A regra é a mesma dos dois lados (`auditZernioTemplateRow`, o dono do
   * reconhecedor):
   *  - rótulo que o reconhecedor lê (aceite/recusa) → o papel é o que ele lê;
   *  - rótulo que ele NÃO lê e cujo papel NINGUÉM declarou → BLOQUEIA. Do rótulo
   *    sozinho é indecidível se é o "sim" de um opt-in ou um "Ver mais"
   *    inofensivo, e a diferença entre os dois é a prova do consentimento de
   *    13.400 pessoas. Quem decide é o operador: recriando o template pelo orgamind
   *    (rótulo escolhido de lista) ou declarando os papéis em
   *    `PATCH /templates/:id/consent-buttons`.
   *
   * Só morde em ZERNIO: TWILIO e EVOLUTION transportam o id do botão que NÓS
   * escolhemos, então lá o clique não depende de rótulo nenhum.
   */
  private assertTemplateConsentButtonsUsable(template: {
    metaName: string;
    provider: string | null;
    components: unknown;
    consentButtonRoles: unknown;
  }): void {
    if (template.provider !== 'ZERNIO') return;
    const problems = auditZernioTemplateRow({
      components: template.components,
      consentButtonRoles: template.consentButtonRoles,
    });
    if (problems.length === 0) return;
    throw new CampaignTemplateConsentButtonsError(template.metaName, problems);
  }

  /**
   * Médio — stream the campaign audience with keyset pagination and enqueue
   * every recipient, instead of loading the whole audience into one array. We
   * page by `id` (cuid → stable cursor), `DISPATCH_CHUNK_SIZE` rows at a time,
   * createMessage + enqueue each page concurrently, then advance the cursor to
   * the last id. Memory stays bounded regardless of audience size, and every
   * recipient is still enqueued exactly once. Returns the number queued.
   *
   * `onPageDispatched` lets callers abort mid-stream (e.g. detect a concurrent
   * cancel) — return false to stop paging.
   */
  private async dispatchAudience(args: {
    campaignId: string;
    where: Prisma.ContactWhereInput;
    variableMap: VariableMap;
    templateId: string;
    defaultInstanceId: string;
    correlationId: string | undefined;
    /** C1 — finalidade declarada da campanha (Campaign.purposeKey). */
    purposeKey?: string | null;
    /** Campaign.override — só age como override de CONSENTIMENTO em EVOLUTION. */
    override?: boolean;
    overrideJustification?: string | null;
    /** ★ 2026-08-25 — Campaign.excludeAnyPreviousCampaign; ver `sameTemplateExclusion`. */
    excludeAnyPreviousCampaign?: boolean;
    /**
     * ZE — teto de mensagens ENFILEIRADAS nesta execução ("enviar 50 agora").
     * Undefined = a audiência inteira (comportamento clássico do "Disparar").
     *
     * O teto conta ENVIOS, não contatos varridos: um contato pulado pelo gate
     * (sem consentimento / suprimido) não consome cota do tier, então não pode
     * consumir a cota do lote — senão "enviar 50" entregaria 30.
     */
    limit?: number;
    /** ZE — o lote ao qual as mensagens desta execução pertencem. */
    campaignBatchId?: string | null;
    /**
     * "Disparar novamente para TODOS": autoriza REENVIAR a quem já recebeu,
     * ressuscitando a linha dele (nunca criando uma segunda). Só
     * `redispatchCampaign(resendToAll)` passa isto.
     */
    resendReached?: boolean;
    makeJobId: (contactId: string, messageId: string) => string;
  }): Promise<{
    queued: number;
    skipped: number;
    /**
     * Contatos que a trava de banco recusou porque já tinham mensagem VIVA
     * nesta campanha. Sai daqui porque "0 enviadas" precisa dizer POR QUÊ — ver
     * o comentário no fim do método.
     */
    skippedAlreadyLive: number;
  }> {
    // ★ A REDE da regra do mesmo template (spec 2026-08-12).
    //
    // `resolveAudience` já tirou essa gente do `where` — mas o `where` é
    // calculado UMA vez e a paginação keyset percorre a base por minutos. Um
    // contato pode ficar bloqueado NO MEIO do laço: é o caso de duas campanhas
    // irmãs do mesmo template disparadas em paralelo, exatamente o cenário
    // (500 + 500) que originou a regra. Sem checar de novo aqui, a janela entre
    // montar o `where` e gravar a Message é TOCTOU puro.
    //
    // NÃO grava linha de pulo, de propósito: o pedido do dono é que essa pessoa
    // "não apareça" na campanha, e uma linha SKIPPED a faria aparecer — só que
    // pulada. O rastro também não se perde: a prova de que ela recebeu está na
    // mensagem da OUTRA campanha, que é o que esta própria regra consulta.
    //
    // ★ C3 (auditoria 2026-08-19) — O FILTRO É RECALCULADO POR PÁGINA, dentro
    // do laço, e não uma vez antes dele. Calculá-lo uma vez fazia a rede
    // enxergar apenas as irmãs que já existiam em t0: um disparo que começa
    // sem irmã nenhuma nasce com o filtro `null` e fica com a rede DESLIGADA
    // pelos minutos inteiros da varredura — inclusive depois de a irmã ser
    // criada e já ter gravado mensagens. Era o caso 500+500 que originou a
    // regra, só que na ordem inversa. O custo é um SELECT id,status em
    // `Campaign` por 500 contatos, ao lado das três consultas de gate que já
    // rodam por página.
    let skippedSameTemplate = 0;
    // Contatos que a trava de banco recusou (já tinham linha viva nesta
    // campanha). Zero é o normal; qualquer coisa acima disso é sinal de que um
    // caminho de duplicação ainda existe e vale um log.
    let skippedDuplicate = 0;

    // T7 — centralised guard (see assertTemplateProviderMatchesChannel doc):
    // this is what makes runScheduledLocked() and redispatchCampaign() safe
    // by construction, since neither had its own pre-dispatch provider check
    // before this change. Runs before any Message row is created / any job
    // is enqueued, so a mismatch here queues nothing.
    await this.assertTemplateProviderMatchesChannel(
      args.templateId,
      args.defaultInstanceId,
    );

    // C1 — GATE DE CONSENTIMENTO POR FINALIDADE (spec §4).
    //
    // O gate do T8 era binário (`optInAt != null`), sem finalidade, e furável
    // por um booleano. Ele era, por construção, a autorização genérica que o
    // art. 8º §4º anula. Agora o gate exige consentimento ATIVO para A
    // FINALIDADE DESTA campanha, e vale para TODOS os provedores — o Evolution
    // não tem obrigação com a Meta a violar, mas tem com a lei brasileira,
    // igual.
    const channel = await this.instancesRepo.findById(args.defaultInstanceId);
    const consentOverride = await this.resolveConsentOverride(args, channel);

    // ★ ZB — ESTE CANAL MANDA POR BROADCAST?
    //
    // Se sim, as Messages continuam sendo criadas EXATAMENTE como antes (o gate
    // acima é o mesmo, as linhas SKIPPED_* são as mesmas, o recorte do lote é o
    // mesmo) — só o TRANSPORTE muda: em vez de um job de envio 1-a-1 por pessoa,
    // os ids são acumulados e viram UM job de broadcast por pedaço, no fim.
    //
    // É por isso que este é o único ponto tocado: tudo o que protege as 13.400
    // pessoas mora ACIMA desta linha e continua rodando igual.
    const useBroadcast =
      channel?.provider === 'ZERNIO' &&
      channel.zernioBroadcastEnabled === true &&
      this.broadcastDispatchQueue != null;
    const broadcastMessageIds: string[] = [];

    const select = this.buildRecipientSelect(args.variableMap);
    // O gate precisa do telefone: a supressão é chaveada por `phoneHash`,
    // derivado dele.
    //
    // ★ Decisão do cliente, 25/08/2026 — `optedOut` NÃO é mais pedido aqui.
    // O booleano `Contact.optedOut` deixou de barrar o envio (ver o comentário
    // do gate, logo abaixo), e uma coluna que ninguém lê não deve ser trazida
    // por 13k linhas paginadas.
    select.phoneE164 = true;

    let cursorId: string | undefined;
    let queued = 0;
    let skippedNoConsent = 0;
    let skippedSuppressed = 0;

    for (;;) {
      const page = await this.repo.findContactsPage(args.where, {
        select,
        take: DISPATCH_CHUNK_SIZE,
        cursorId,
      });
      if (page.length === 0) break;

      let allRows = page as unknown as Array<Record<string, unknown>>;
      const contactIds = allRows.map((c) => c.id as string);
      const phones = allRows
        .map((c) => c.phoneE164 as string | null)
        .filter((p): p is string => Boolean(p));

      // Três consultas por PÁGINA, não por contato — o gate roda dentro de um
      // loop paginado que pode varrer 13k destinatários.
      const [suppressed, granted, openWindows] = await Promise.all([
        this.consent.suppressedPhones(phones),
        this.consent.grantedContactIds(contactIds, args.purposeKey),
        // A janela só autoriza `servico_projeto` (utility). Ela permite
        // CONVERSAR, nunca fazer campanha de marketing — então só consultamos
        // quando a finalidade é a que a janela pode cobrir.
        args.purposeKey === WINDOW_ELIGIBLE_PURPOSE
          ? this.repo.findContactsWithOpenWindow(
              contactIds,
              args.defaultInstanceId,
              new Date(Date.now() - SERVICE_WINDOW_MS),
            )
          : Promise.resolve(new Set<string>()),
      ]);

      // ── ZE: recorte exato do lote ────────────────────────────────────────
      //
      // As decisões do gate (suprimido / sem consentimento / envia) são PURAS
      // dadas os três Sets acima, então dá para classificar a página inteira em
      // memória ANTES de escrever qualquer linha — e é isso que permite parar no
      // 50º ENVIO com precisão, sem sequenciar o loop (que continua concorrente).
      //
      // O corte respeita a ordem da página (keyset por `id`): tudo ANTES do
      // corte é processado (inclusive as linhas SKIPPED, que registram a decisão
      // do gate); tudo DEPOIS fica intocado e continua PENDENTE para o próximo
      // lote. Sem esse corte, "enviar 50" varreria a audiência inteira criando
      // linhas SKIPPED para 13k pessoas na primeira execução.
      const decide = (
        c: Record<string, unknown>,
      ): 'suppressed' | 'no_consent' | 'send' => {
        const contactId = c.id as string;
        const phone = c.phoneE164 as string | null;
        if (phone !== null && suppressed.has(phone)) {
          return 'suppressed';
        }
        const mayReceive =
          granted.has(contactId) ||
          openWindows.has(contactId) ||
          consentOverride;
        return mayReceive ? 'send' : 'no_consent';
      };

      // Uma query POR PÁGINA (não por contato): quem, entre estes ids, já está
      // numa campanha irmã do mesmo template. `distinct` porque um contato pode
      // ter várias mensagens bloqueadoras. A LISTA DE IRMÃS também é relida
      // aqui (C3): ela pode ter mudado desde a página anterior.
      const sameTemplateBlock = await this.sameTemplateExclusion(
        args.campaignId,
        args.templateId,
        args.excludeAnyPreviousCampaign,
      );
      let blockedHere: Set<string> = new Set();
      if (sameTemplateBlock && allRows.length > 0) {
        const bloqueadas = await this.prisma.message.findMany({
          where: {
            ...sameTemplateBlock,
            contactId: { in: allRows.map((r) => r.id as string) },
          },
          select: { contactId: true },
          distinct: ['contactId'],
        });
        // `contactId` é anulável (mensagem de inbox não tem contato de
        // campanha). Um null não bloqueia ninguém — e deixá-lo entrar no Set
        // faria o `has` de um id legítimo continuar falso, só com o tipo errado.
        blockedHere = new Set(
          bloqueadas
            .map((m) => m.contactId)
            .filter((id): id is string => id !== null),
        );
      }
      if (blockedHere.size > 0) {
        skippedSameTemplate += blockedHere.size;
        allRows = allRows.filter((r) => !blockedHere.has(r.id as string));
      }

      let rows = allRows;
      if (args.limit !== undefined) {
        let budget = args.limit - queued;
        let cut = allRows.length;
        for (let i = 0; i < allRows.length; i++) {
          if (decide(allRows[i]) !== 'send') continue;
          if (budget === 0) {
            cut = i;
            break;
          }
          budget -= 1;
        }
        rows = allRows.slice(0, cut);
      }

      await Promise.all(
        rows.map(async (c) => {
          const contactId = c.id as string;
          const phone = c.phoneE164 as string | null;

          // Ordem da spec §4.3. A supressão vem PRIMEIRO e é absoluta: nem
          // override de ADMIN a fura (art. 8º §5º — a revogação não admite
          // carência).
          //
          // ★ Decisão do cliente, 25/08/2026 — a fonte é APENAS a
          // `SuppressionList` (chave durável por `phoneHash`). O cache
          // `Contact.optedOut` saiu daqui: o cliente pediu, com o risco de
          // LGPD/política do WhatsApp apresentado e aceito por escrito, que o
          // booleano deixasse de excluir alguém do envio. Quem tem o booleano
          // ligado mas nenhuma entrada durável VOLTA A RECEBER; quem está na
          // `SuppressionList` continua pulado como sempre esteve.
          const isSuppressed = phone !== null && suppressed.has(phone);
          if (isSuppressed) {
            await this.repo.createSkippedMessage({
              campaignId: args.campaignId,
              contactId,
              instanceId: args.defaultInstanceId,
              reason: 'suppressed',
              campaignBatchId: args.campaignBatchId,
            });
            skippedSuppressed += 1;
            return;
          }

          const mayReceive =
            granted.has(contactId) ||
            openWindows.has(contactId) ||
            consentOverride;
          if (!mayReceive) {
            await this.repo.createSkippedMessage({
              campaignId: args.campaignId,
              contactId,
              instanceId: args.defaultInstanceId,
              reason: 'no_consent',
              campaignBatchId: args.campaignBatchId,
            });
            skippedNoConsent += 1;
            return;
          }

          const variables: Record<string, string> = {};
          for (const [key, mapping] of Object.entries(args.variableMap)) {
            if (mapping.source === 'literal') variables[key] = mapping.value;
            else variables[key] = String(c[mapping.field] ?? '');
          }
          const message = await this.repo.createMessage({
            campaignId: args.campaignId,
            contactId,
            instanceId: args.defaultInstanceId,
            variables: variables as Prisma.InputJsonValue,
            campaignBatchId: args.campaignBatchId,
            ...(args.resendReached ? { resendReached: true } : {}),
          });
          // ★ `null` = a trava "uma linha viva por (campanha, contato)" disse
          // que este contato já tem mensagem viva nesta campanha: ela está a
          // caminho (ou já chegou) e não há nada a enfileirar. Enfileirar assim
          // mesmo publicaria um job sem linha para reivindicar — e contar como
          // enviada mentiria no número da tela.
          if (!message) {
            skippedDuplicate += 1;
            return;
          }
          if (useBroadcast) {
            // ZB — o job NÃO é enfileirado por pessoa. A Message já está QUEUED
            // (é ela que garante o "não repete" do próximo lote); o disparo sai
            // em bloco, no fim do laço.
            broadcastMessageIds.push(message.id);
          } else {
            await this.enqueueOrFail({
              messageId: message.id,
              campaignId: args.campaignId,
              correlationId: args.correlationId,
              jobId: args.makeJobId(contactId, message.id),
            });
          }
          queued += 1;
        }),
      );

      // ZE — o teto do lote foi atingido: pare. O que ficou depois do corte
      // segue PENDENTE, intocado, esperando o próximo lote.
      if (args.limit !== undefined && queued >= args.limit) break;

      cursorId = (page[page.length - 1] as unknown as { id: string }).id;
      // A short final page means we've exhausted the audience.
      if (page.length < DISPATCH_CHUNK_SIZE) break;
    }

    // ★ ZB — O DISPARO EM BLOCO.
    //
    // A campanha do orgamind continua sendo UMA — e vira UM job (pedido de
    // 13/07: o fatiamento fixo por `zernioBroadcastChunk` espalhava a mesma
    // campanha em N broadcasts de 50 no painel do Zernio, sem proteger nada).
    // Quem dita o tamanho REAL do disparo é o dispatchBatch: ele corta no
    // saldo da janela rolante de 24h (GLOBAL por número, teto sincronizado do
    // tier do Zernio) e re-enfileira o excedente até a janela abrir. O
    // `zernioBroadcastChunk` continua vivo DENTRO do broadcast, como tamanho
    // de cada requisição do addRecipients (ver effectiveChunkSize).
    //
    // O gate JÁ RODOU (acima, por contato) e as linhas SKIPPED_* já estão
    // gravadas; o que vai daqui são apenas os aprovados. O serviço do
    // broadcast REAVALIA o gate mesmo assim, porque entre a montagem e o
    // disparo pode haver uma revogação — é a mesma razão pela qual o envio
    // 1-a-1 reavalia no worker.
    if (useBroadcast && broadcastMessageIds.length > 0) {
      await this.broadcastDispatchQueue
        ?.add(
          'dispatch',
          {
            campaignId: args.campaignId,
            channelId: args.defaultInstanceId,
            messageIds: broadcastMessageIds,
            correlationId: args.correlationId,
          },
          {
            // O id inclui o PRIMEIRO messageId do lote: dois disparos da mesma
            // campanha nunca colidem, e um re-enqueue acidental do mesmo lote
            // é deduplicado pelo BullMQ.
            jobId: `zernio-bc:${args.campaignId}:${broadcastMessageIds[0]}`,
          },
        )
        .catch(async (e) => {
          // A Message existe e está QUEUED, mas NÃO tem job. Sem isto ela
          // ficaria pendente para sempre, e a campanha "Em execução" eternamente
          // — o mesmo bug que `enqueueOrFail` existe para evitar no 1-a-1.
          this.logger.error(
            { err: e, campaignId: args.campaignId },
            'falha ao enfileirar o broadcast do Zernio — marcando o lote como FAILED',
          );
          for (const messageId of broadcastMessageIds) {
            await this.repo
              .markMessageEnqueueFailed(
                messageId,
                'Falha ao enfileirar o broadcast do Zernio (Redis fora?). A mensagem NÃO foi enviada.',
                'zernio.broadcast_enqueue_failed',
              )
              .catch(() => undefined);
          }
        });
      this.logger.log(
        `dispatchAudience(${args.campaignId}): ${broadcastMessageIds.length} mensagens ` +
          `enfileiradas como UM broadcast do Zernio (o teto da janela de 24h corta no envio).`,
      );
    }

    const skipped = skippedNoConsent + skippedSuppressed;
    if (skipped > 0) {
      // Contabilização agregada (as linhas SKIPPED_* carregam o detalhe por
      // contato). Actor null — decisão automática do gate.
      await this.audit.log(
        'campaign.consent_skipped',
        'Campaign',
        args.campaignId,
        {
          skippedNoConsent,
          skippedSuppressed,
          queued,
          purposeKey: args.purposeKey ?? null,
        },
      );
      this.logger.warn(
        `dispatchAudience(${args.campaignId}): ${skippedNoConsent} sem consentimento para ` +
          `'${args.purposeKey ?? '(campanha sem finalidade)'}' + ${skippedSuppressed} suprimido(s) pulados.`,
      );
    }

    if (consentOverride && queued > 0) {
      // Uso de override aparece em VERMELHO no painel (§7): "o operador assumiu
      // o risco" não é hipótese legal do art. 7º, e o campo persistido é prova,
      // produzida pelo próprio controlador, de que a decisão foi consciente.
      await this.audit.log(
        'campaign.consent_override',
        'Campaign',
        args.campaignId,
        {
          purposeKey: args.purposeKey ?? null,
          recipients: queued,
          justification: args.overrideJustification ?? null,
          provider: channel?.provider ?? null,
        },
      );
    }

    // O contador da regra do mesmo template. Não vira linha no banco (ver o
    // comentário no topo), então o log é o ÚNICO rastro de que a rede pegou
    // alguém — e é o que distingue "a audiência já vinha filtrada" de "duas
    // campanhas irmãs colidiram no meio do laço".
    if (skippedSameTemplate > 0) {
      this.logger.log(
        `dispatchAudience(${args.campaignId}): ${skippedSameTemplate} contato(s) ` +
          `não receberam — já estão em outra campanha do mesmo template ` +
          `(corrida entre o WHERE e a gravação).`,
      );
    }

    // ★ A trava de banco pegou alguém. Diferente do contador acima, isto é um
    // ALERTA: significa que a audiência entregou a este laço um contato que já
    // tinha mensagem viva NESTA campanha — ou seja, sobrou um caminho de
    // duplicação em algum lugar. A trava impediu a entrega dupla; o log é o que
    // permite achar o caminho.
    if (skippedDuplicate > 0) {
      // O NÍVEL DEPENDE DE QUEM PERGUNTOU. No "Disparar novamente para TODOS"
      // (`resendReached`) encontrar linha viva é o comportamento ESPERADO — um
      // lote anterior ainda drenando —, e gritar ALERTA ali só produz alarme
      // falso toda vez. Fora dele, a audiência entregou a este laço alguém que
      // não deveria ter chegado: aí é sinal de que sobrou um caminho de
      // duplicação em algum lugar, e o alerta é o que permite achá-lo.
      const texto =
        `dispatchAudience(${args.campaignId}): ${skippedDuplicate} contato(s) já ` +
        `tinham mensagem VIVA nesta campanha — a trava de banco impediu a ` +
        `segunda linha. Nenhuma entrega duplicada.`;
      if (args.resendReached) {
        this.logger.log(
          `${texto} Esperado no reenvio total: são as pessoas cuja mensagem ` +
            `ainda está em voo.`,
        );
      } else {
        this.logger.warn(
          `${texto} Investigue o recorte de audiência que os trouxe até aqui.`,
        );
      }
    }

    // ★ `skippedAlreadyLive` SOBE PARA A TELA, não morre num log.
    //
    // Enquanto este número era só um `logger.warn`, a API devolvia `{queued: 0}`
    // sem explicação nenhuma: o operador clicava com um lote drenando, via "0
    // enviadas" e não tinha como saber por quê — a única pista estava num log
    // que ele não lê. É a mesma doença que este pacote consertou no botão
    // "Reenviar falhas": o número tem de dizer o que o clique fez.
    return { queued, skipped, skippedAlreadyLive: skippedDuplicate };
  }

  /**
   * O `override` só age como override de CONSENTIMENTO se TODAS as invariantes
   * valerem (spec §4). Em canal oficial ele é INEXPRIMÍVEL — não desencorajado:
   * o campo é simplesmente ignorado, porque ali a violação não é só da lei, é do
   * contrato que mantém o canal vivo.
   *
   * (A invariante de role ADMIN é estrutural: POST /campaigns, /run, /redispatch
   * já são @Roles('ADMIN') no controller.)
   */
  private async resolveConsentOverride(
    args: {
      campaignId: string;
      where: Prisma.ContactWhereInput;
      purposeKey?: string | null;
      override?: boolean;
      overrideJustification?: string | null;
    },
    channel: { provider?: string } | null,
  ): Promise<boolean> {
    if (!args.override) return false;

    const provider = channel?.provider ?? 'EVOLUTION';
    if (isOfficialProvider(provider)) {
      this.logger.warn(
        `dispatchAudience(${args.campaignId}): override IGNORADO — canal ${provider} é oficial ` +
          `(o consentimento é exigência do BSP, não uma preferência do operador).`,
      );
      return false;
    }

    const justification = args.overrideJustification?.trim() ?? '';
    if (!justification) {
      this.logger.warn(
        `dispatchAudience(${args.campaignId}): override IGNORADO — sem justificativa persistida.`,
      );
      return false;
    }

    // art. 11: para dado sensível o legítimo interesse não existe. Recusa do
    // gate, não aviso de UI.
    if (await this.consent.isSensitivePurpose(args.purposeKey)) {
      this.logger.warn(
        `dispatchAudience(${args.campaignId}): override IGNORADO — finalidade sensível (art. 11).`,
      );
      return false;
    }

    const recipients = await this.repo.countContactsByWhere(args.where);
    if (recipients > CONSENT_OVERRIDE_MAX_RECIPIENTS) {
      this.logger.warn(
        `dispatchAudience(${args.campaignId}): override IGNORADO — ${recipients} destinatários ` +
          `excedem o teto de ${CONSENT_OVERRIDE_MAX_RECIPIENTS}.`,
      );
      return false;
    }

    return true;
  }

  waitingByCampaign(campaignId: string) {
    return this.repo.waitingByCampaign(campaignId);
  }

  private readCorrelationId(): string | undefined {
    try {
      return this.cls.get<AuditContext>(AUDIT_CLS_KEY)?.correlationId;
    } catch {
      return undefined;
    }
  }

  private readActorId(): string | undefined {
    try {
      return this.cls.get<AuditContext>(AUDIT_CLS_KEY)?.actorId;
    } catch {
      return undefined;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ZE — CAMPANHA EM LOTES (retomável)
  //
  // O pedido do cliente, literal: "Quero enviar 50 agora... Aí depois eu quero,
  // naquela mesma campanha, enviar para mais 100. Só que eu não vou ter a dor de
  // cabeça de saber pra quem eu não enviei — o sistema só vai me listar, só vou
  // poder enviar para as pessoas que eu ainda não enviei naquela campanha."
  //
  // Os lotes são construídos POR CIMA do envio 1-a-1 que já existe — e não sobre
  // o `POST /broadcasts` do Zernio, deliberadamente. Ver a nota em
  // batch-audience.ts: o broadcast devolve só contadores agregados (não diz
  // QUEM), enquanto o 1-a-1 dá status por contato, gate de consentimento por
  // contato e supressão individual (`SuppressionList` por `phoneHash`) —
  // exatamente o controle que este pedido exige.
  // ══════════════════════════════════════════════════════════════════════════

  /** Campanhas terminais não recebem novos lotes. */
  private static readonly TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]);

  /**
   * FASE 0 — o ÚNICO resolvedor de audiência. Substitui o par
   * resolveAudienceWhere + resolvePendingAudience, cuja bifurcação era o bug: os
   * caminhos que usavam o primeiro (run, redispatch, scheduler, prévia) reenviavam
   * para quem já recebeu, porque ele não tem cláusula sobre Message.
   *
   * `mode` é obrigatório — ninguém herda 'full' por descuido:
   *   pending   — exclui já TRATADO (lote: não repete nem quem está em voo)
   *   unreached — exclui só quem RECEBEU (redispatch/tick: reavalia os pulados)
   *   full      — audiência inteira, ignorando histórico (só por intenção explícita)
   */
  private async resolveAudience(
    campaign: {
      id: string;
      templateId: string;
      filters: Prisma.JsonValue;
      segmentId?: string | null;
      limit?: number | null;
      /** ★ 2026-08-25 — ver `sameTemplateExclusion`. */
      excludeAnyPreviousCampaign?: boolean | null;
    },
    mode: AudienceMode,
  ): Promise<{
    audience: Prisma.ContactWhereInput;
    where: Prisma.ContactWhereInput;
    isMarketing: boolean;
  }> {
    const base = await this.resolveAudienceWhere(campaign);
    const template = await this.templatesRepo.findById(campaign.templateId);
    // A exclusão dos inalcançáveis é condicionada à CATEGORIA: a Meta diz, no
    // 130472, que "UTILITY TEMPLATES ARE NOT AFFECTED". Uma campanha de serviço
    // continua alcançando quem desligou marketing.
    const isMarketing = template?.category === TemplateCategory.MARKETING;

    // ★ Ninguém recebe o MESMO template duas vezes (spec 2026-08-12).
    //
    // Aplicado AQUI, e ANTES do switch de modo, por dois motivos:
    //
    // 1. Este é o funil. Os quatro caminhos que materializam audiência —
    //    `run`, lotes, `redispatch` e o tick do agendador — passam todos por
    //    `resolveAudience`, e todos RE-RESOLVEM o filtro contra a base atual.
    //    A mesma checagem feita no `create` seria uma foto de t0: o `create`
    //    não envia nada, e o lote 5 sai dias depois, com gente que nem existia.
    //
    // 2. Fora do switch porque o modo `full` ("disparar novamente para todos")
    //    descarta o histórico por construção. Dentro do switch, esse botão
    //    anularia a regra — que é exatamente o que ela existe para impedir.
    const bloqueio = await this.sameTemplateExclusion(
      campaign.id,
      campaign.templateId,
      campaign.excludeAnyPreviousCampaign ?? false,
    );
    const audience: Prisma.ContactWhereInput = bloqueio
      ? { AND: [base, { messages: { none: bloqueio } }] }
      : base;

    if (mode === 'full') {
      return { audience, where: audience, isMarketing };
    }
    const build =
      mode === 'pending'
        ? pendingAudienceWhere
        : mode === 'unreached-idle'
          ? unreachedIdleAudienceWhere
          : unreachedAudienceWhere;
    return {
      audience,
      where: build({
        campaignId: campaign.id,
        audience,
        excludeMarketingUndeliverable: isMarketing,
      }),
      isMarketing,
    };
  }

  /**
   * As campanhas IRMÃS — separadas pela régua que cada uma merece, e já
   * viradas em predicado.
   *
   * Por padrão (`anyPreviousCampaign` falso/ausente) as irmãs são só as do
   * MESMO template — a regra original (spec 2026-08-12): "ninguém recebe o
   * mesmo template duas vezes".
   *
   * ★ Pedido do cliente 2026-08-25 — `anyPreviousCampaign: true`
   * (`Campaign.excludeAnyPreviousCampaign`) amplia as irmãs para QUALQUER
   * OUTRA campanha, de QUALQUER template: era a exclusão restrita ao mesmo
   * template que o operador via como "excluir quem já recebeu não funciona"
   * — uma campanha nova com um template diferente de uma anterior não
   * excluía ninguém.
   *
   * A campanha corrente sai da lista de propósito: a deduplicação DENTRO dela
   * é papel dos modos `pending`/`unreached`, e o modo `full` existe justamente
   * para reenviar dentro dela. Incluí-la aqui quebraria os dois.
   *
   * `select` enxuto (id + status) porque a lista é ilimitada: um template
   * usado em 50 campanhas (ou, no modo amplo, a base de campanhas inteira)
   * devolve todas as linhas a cada resolução de audiência.
   */
  private async sameTemplateExclusion(
    /** `null` na PRÉVIA: a campanha ainda não existe, então não há o que ignorar. */
    campaignId: string | null,
    templateId: string,
    anyPreviousCampaign = false,
  ): Promise<Prisma.MessageWhereInput | null> {
    const irmas = await this.prisma.campaign.findMany({
      where: {
        ...(anyPreviousCampaign ? {} : { templateId }),
        ...(campaignId ? { id: { not: campaignId } } : {}),
      },
      select: { id: true, status: true },
    });
    const activeCampaignIds: string[] = [];
    const cancelledCampaignIds: string[] = [];
    for (const c of irmas) {
      if (c.status === 'CANCELLED') cancelledCampaignIds.push(c.id);
      else activeCampaignIds.push(c.id);
    }
    return sameTemplateBlockFilter({ activeCampaignIds, cancelledCampaignIds });
  }

  /**
   * Os três números que o operador vê na tela, mais o histórico dos lotes.
   *
   * `enviados` conta CONTATOS (distintos), não mensagens: um contato que teve uma
   * falha transitória e foi reenviado num lote seguinte tem duas Messages e uma
   * pessoa só — contar mensagens infliria o número que o cliente usa para decidir
   * quanto ainda falta mandar.
   */
  async batchSummary(campaignId: string): Promise<CampaignBatchSummary> {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);

    const { audience, where, isMarketing } = await this.resolveAudience(
      campaign,
      'pending',
    );

    const [total, sent, pending, unreachable, grouped] = await Promise.all([
      this.repo.countContactsByWhere(audience),
      // Distinto por construção: contamos CONTATOS que têm ao menos uma mensagem
      // entregue nesta campanha.
      this.repo.countContactsByWhere({
        AND: [
          audience,
          {
            messages: {
              some: {
                campaignId,
                status: { in: ['SENT', 'DELIVERED', 'READ'] },
              },
            },
          },
        ],
      }),
      this.repo.countContactsByWhere(where),
      this.repo.countContactsByWhere({
        AND: [audience, { marketingUndeliverableAt: { not: null } }],
      }),
      this.repo.groupMessagesByStatus(campaignId),
    ]);

    const countOf = (status: string) =>
      grouped.find((g) => g.status === status)?._count ?? 0;

    return {
      total,
      sent,
      pending,
      // A.5 — "Em fila": tudo que está a caminho. Conta MENSAGENS, o mesmo
      // denominador de `failed`/`skipped`, que já saem deste `groupBy`.
      inFlight:
        countOf('QUEUED') + countOf('SENDING') + countOf('WAITING_INSTANCE'),
      // ★ Isolado de propósito: WAITING_INSTANCE é a única parcela com CULPADO
      // (o canal caiu) e com conserto (reconectar). Somada às outras, ela vira
      // "a campanha está andando" — e não está.
      waiting: countOf('WAITING_INSTANCE'),
      // Só faz sentido como "inalcançável" numa campanha de MARKETING — numa
      // UTILITY essas pessoas são alcançadas normalmente.
      unreachable: isMarketing ? unreachable : 0,
      failed: countOf('FAILED'),
      skipped: countOf('SKIPPED_NO_CONSENT') + countOf('SKIPPED_SUPPRESSED'),
      isMarketing,
      status: campaign.status,
    };
  }

  listBatches(campaignId: string) {
    return this.repo.listBatches(campaignId);
  }

  /**
   * ZE — a aba "enviados × não enviados" que o cliente pediu.
   *
   * Os PENDENTES não têm `Message` nenhuma (é o que os define), então são
   * invisíveis para o `/messages` — só existem como CONTATOS que a audiência
   * ainda alcança. Por isso a listagem é de contatos; e por isso o grupo
   * `pending` usa EXATAMENTE o mesmo recorte que o próximo lote enviaria: a tela
   * mostra a lista real de quem vai receber, não uma aproximação dela.
   */
  async listRecipients(
    campaignId: string,
    query: {
      group: 'sent' | 'pending' | 'unreachable' | 'skipped' | 'failed';
      page: number;
      pageSize: number;
    },
  ) {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);

    // Alias local `pendingWhere`: o `where` já é o nome do recorte por GRUPO
    // logo abaixo — o recorte PENDENTE é só um dos casos dele.
    const { audience, where: pendingWhere } = await this.resolveAudience(
      campaign,
      'pending',
    );

    // GATE SILENCIOSO — a 4ª aba. Quem o gate pulou não aparecia em NENHUM dos
    // três grupos: não tem mensagem enviada, não é inalcançável de marketing e
    // sai de `pending` porque já foi "tratado" nesta campanha. O contato
    // simplesmente sumia da tela. Aqui ele volta — com o MOTIVO do pulo.
    if (query.group === 'skipped') {
      const { items, total } = await this.repo.listSkippedContactsPaged(
        { AND: [audience] },
        campaignId,
        { page: query.page, pageSize: query.pageSize },
      );
      return { items, total, page: query.page, pageSize: query.pageSize };
    }

    // F2 T7 — a 5ª aba: quem tem Message FAILED nesta campanha, com o MOTIVO
    // da falha (failureReason/errorCode) embutido no mesmo molde do 'skipped'
    // acima.
    if (query.group === 'failed') {
      const { items, total } = await this.repo.listFailedContactsPaged(
        { AND: [audience] },
        campaignId,
        { page: query.page, pageSize: query.pageSize },
      );
      return { items, total, page: query.page, pageSize: query.pageSize };
    }

    const where: Prisma.ContactWhereInput =
      query.group === 'pending'
        ? pendingWhere
        : query.group === 'sent'
          ? {
              AND: [
                audience,
                {
                  messages: {
                    some: {
                      campaignId,
                      status: { in: ['SENT', 'DELIVERED', 'READ'] },
                    },
                  },
                },
              ],
            }
          : { AND: [audience, { marketingUndeliverableAt: { not: null } }] };

    const { items, total } = await this.repo.listContactsPaged(where, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * F2 T7 — GET /campaigns/:id/failure-reasons: agregação [{failureReason,
   * count}] das Messages FAILED desta campanha, com o rótulo PT-BR de cada
   * motivo — alimenta o painel "por que falhou" na tela da campanha, em vez
   * de o operador ter que abrir mensagem por mensagem.
   */
  async getFailureReasons(campaignId: string): Promise<
    Array<{
      failureReason: FailureReason | null;
      count: number;
      label: string | null;
    }>
  > {
    const campaign = await this.repo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);

    const rows = await this.repo.groupFailuresByReason(campaignId);
    return rows.map((row) => ({
      ...row,
      label: row.failureReason
        ? FAILURE_REASON_LABELS[row.failureReason]
        : null,
    }));
  }

  /**
   * ENVIA UM LOTE: "enviar agora para N contatos".
   *
   * O operador escolhe QUANTOS; o sistema decide PARA QUEM — os N primeiros
   * pendentes, na ordem do keyset. Tudo que já existe continua valendo, porque o
   * lote reusa `dispatchAudience`: gate de consentimento por finalidade,
   * supressão absoluta, tier batching, janela rolante de 24h, throttle e
   * kill-switch são do WORKER e do gate, não do disparo — um lote de 50 que
   * esbarra no tier é ADIADO pelo worker (job.moveToDelayed), não falha.
   */
  async sendBatch(
    id: string,
    size: number,
  ): Promise<{
    batchId: string;
    seq: number;
    requested: number;
    queued: number;
    skipped: number;
    skippedAlreadyLive: number;
    remaining: number;
    summary: CampaignBatchSummary;
  }> {
    const campaign = await this.repo.findById(id);
    if (!campaign) throw new CampaignNotFoundError(id);
    if (CampaignsService.TERMINAL_STATUSES.has(campaign.status)) {
      throw new CampaignBatchNotAllowedError(campaign.status);
    }

    // Mesmo guard do run(): template×canal (provedor + APPROVED) ANTES de
    // reivindicar qualquer transição de estado.
    await this.assertTemplateProviderMatchesChannel(
      campaign.templateId,
      campaign.defaultInstanceId,
    );

    // O MESMO lock 'resend' do run()/scheduler/redispatch: dois lotes
    // concorrentes (ou um lote e um disparo) nunca resolvem a audiência
    // pendente ao mesmo tempo — o que os faria enviar para as MESMAS pessoas,
    // já que ambos leriam "ainda não tem Message" antes de qualquer escrita.
    return this.withCampaignLock(id, 'resend', async () => {
      const { audience, where } = await this.resolveAudience(
        campaign,
        'pending',
      );

      const pending = await this.repo.countContactsByWhere(where);
      if (pending === 0) throw new CampaignNoPendingRecipientsError();

      // A.4 — o tamanho do lote é validado contra o que RESTA, não só contra o
      // teto de 5000 do contrato. Pedir mais do que resta só acontece quando o
      // número na tela ficou velho (outra aba, o lote anterior drenando), e
      // mandar "o que houver" calado é o silêncio que treina o operador a
      // clicar de novo. A tela reclampa o campo a cada refresh do resumo, então
      // isto aqui é a rede — não o caminho comum.
      if (size > pending) {
        throw new CampaignBatchSizeExceedsPendingError(size, pending);
      }

      // Primeiro lote: a campanha sai de DRAFT. O agendamento one-shot é
      // DESARMADO — senão o scheduler dispararia a audiência INTEIRA no
      // nextRunAt original, que é o oposto de enviar em lotes.
      // A.4 — medido em TODO lote, não só no primeiro: a base cresce entre um
      // lote e o outro (importação nova, opt-in novo), e um denominador de t0
      // faz "Restam" e a barra discordarem uma da outra na mesma tela.
      const total = await this.repo.countContactsByWhere(audience);
      if (campaign.status === 'DRAFT') {
        const isRecurring =
          campaign.scheduleType === 'DAILY_AT' ||
          campaign.scheduleType === 'WEEKLY' ||
          campaign.scheduleType === 'INTERVAL';
        const transitioned = await this.repo.transitionToQueued(id, total, {
          disarmSchedule: !isRecurring,
        });
        if (transitioned === 0) {
          const fresh = await this.repo.findById(id);
          throw new CampaignAlreadyDispatchedError(fresh?.status ?? 'UNKNOWN');
        }
      }
      // A campanha fica EM ANDAMENTO enquanto houver pendente — quem a conclui é
      // maybeCompleteCampaign, e só quando não sobra ninguém.
      await this.repo.updateStatus(id, 'RUNNING', { totalRecipients: total });

      const batch = await this.repo.createBatch({
        campaignId: id,
        requested: size,
        createdByUserId: this.readActorId() ?? null,
      });

      const { queued, skipped, skippedAlreadyLive } = await this.dispatchAudience({
        campaignId: id,
        where,
        variableMap: campaign.variableMap as unknown as VariableMap,
        templateId: campaign.templateId,
        defaultInstanceId: campaign.defaultInstanceId,
        correlationId: this.readCorrelationId(),
        purposeKey: campaign.purposeKey ?? null,
        override: campaign.override ?? false,
        overrideJustification: campaign.overrideJustification ?? null,
        excludeAnyPreviousCampaign: campaign.excludeAnyPreviousCampaign ?? false,
        limit: size,
        campaignBatchId: batch.id,
        makeJobId: (contactId, messageId) =>
          createHash('sha256')
            .update(`${id}:${contactId}:${messageId}`)
            .digest('hex'),
      });

      await this.repo.finishBatch(batch.id, { queued, skipped });
      await this.audit.log('campaign.batch_sent', 'Campaign', id, {
        batchId: batch.id,
        seq: batch.seq,
        requested: size,
        queued,
        skipped,
      });

      // O lote pode ter esvaziado a audiência sem enfileirar nada (todos pulados
      // pelo gate) — nesse caso a campanha já pode fechar aqui.
      await this.maybeCompleteCampaign(id);

      const remaining = await this.repo.countContactsByWhere(where);
      // A.4 — o resumo volta NA MESMA IDA. A tela desenha o cabeçalho novo com
      // este objeto; sem ele ela mostraria os números de antes do lote até a
      // próxima ronda do polling.
      const summary = await this.batchSummary(id);
      return {
        batchId: batch.id,
        seq: batch.seq,
        requested: size,
        queued,
        skipped,
        summary,
        // Fora de `skipped` de propósito: `skipped` conta LINHAS de pulo
        // gravadas pelo gate (elas existem no banco e aparecem nos contadores
        // da campanha); estas não geram linha nenhuma. Somá-las ali faria o
        // histórico do lote contar pulos que não existem.
        skippedAlreadyLive,
        remaining,
      };
    });
  }
}
