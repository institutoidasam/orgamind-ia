import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type { ClsService } from 'nestjs-cls';
import { CampaignsService } from './campaigns.service';
import { CampaignsRepository } from './campaigns.repository';
import { SegmentsRepository } from '../segments/segments.repository';
import { TemplatesRepository } from '../templates/templates.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { TemplateNotFoundError } from '../templates/errors/templates.errors';
import {
  CampaignNotFoundError,
  CampaignInFlightError,
  CampaignAlreadyDispatchedError,
  CampaignOperationInProgressError,
  CampaignBlockedError,
  CampaignBatchNotAllowedError,
  CampaignNoPendingRecipientsError,
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
import { isHandledInCampaign } from './batch-audience';
import { INDETERMINATE_DELIVERY_CODES } from './marketing-reachability';
import type { MessageStatus } from '@prisma/client';
import type { SendMessageJob } from '../queue/queue.constants';
import type { FilterGroup } from '../../schemas/contracts/filter.schema';
import type { CreateCampaign } from '../../schemas/contracts/campaign.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { ValidationError } from '../../shared/errors/domain.error';
import { CAMPAIGN_LOCK_TTL_MS } from './campaign-lock.helper';
import { ConsentService } from '../consent/consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { invalidContactWhere } from '../../shared/contact-validity';

describe('CampaignsService', () => {
  let service: CampaignsService;
  let repo: MockProxy<CampaignsRepository>;
  let segmentsRepo: MockProxy<SegmentsRepository>;
  let templatesRepo: MockProxy<TemplatesRepository>;
  let instancesRepo: MockProxy<WhatsappInstancesRepository>;
  let sendQueue: MockProxy<Queue<SendMessageJob>>;
  let audit: MockProxy<AuditService>;
  let cls: MockProxy<ClsService>;
  let consent: MockProxy<ConsentService>;
  let prisma: MockProxy<PrismaService>;
  let redis: {
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repo = mockDeep<CampaignsRepository>();
    segmentsRepo = mockDeep<SegmentsRepository>();
    templatesRepo = mockDeep<TemplatesRepository>();
    instancesRepo = mockDeep<WhatsappInstancesRepository>();
    sendQueue = mockDeep<Queue<SendMessageJob>>();
    audit = mockDeep<AuditService>();
    cls = mockDeep<ClsService>();
    // A4 per-campaign lock: SET NX returns 'OK' (lock free) by default.
    // release/refresh are owner-checked compare-and-delete/extend Lua evals.
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      eval: vi.fn().mockResolvedValue(1),
    };
    consent = mockDeep<ConsentService>();
    prisma = mockDeep<PrismaService>();
    // F1 T4 — resolveHistoryTargets só bate no banco quando a árvore do filtro
    // tem um nó history com templateIds; a maioria dos testes aqui usa filtros
    // escalares, então o default vazio nunca é lido.
    prisma.campaign.findMany.mockResolvedValue([]);
    service = new CampaignsService(
      repo,
      segmentsRepo,
      templatesRepo,
      instancesRepo,
      sendQueue,
      audit,
      cls,
      redis as never,
      consent,
      prisma,
    );

    // C1 gate defaults. Os testes que NÃO são sobre o gate (paginação, lock,
    // correlationId…) assumem uma audiência que consentiu — senão o gate,
    // corretamente, não passaria ninguém e eles testariam o vazio. Os testes DO
    // gate sobrescrevem `grantedContactIds` com um Set explícito.
    consent.suppressedPhones.mockResolvedValue(new Set());
    consent.grantedContactIds.mockImplementation(
      async (ids: string[]) => new Set(ids),
    );
    consent.isSensitivePurpose.mockResolvedValue(false);
    // C1b — por padrão, toda purposeKey passada existe e está ativa. Os testes de
    // finalidade desconhecida sobrescrevem com null.
    consent.findActivePurpose.mockImplementation((async (key: string | null) =>
      key ? { key, label: key, description: '', isSensitive: false } : null) as any);
    repo.findContactsWithOpenWindow.mockResolvedValue(new Set());
    // Sem limite, a audiência passa intacta — é o caso de TODA campanha que não
    // usa "os N primeiros" (e de todas as que já existiam). Os testes do limite
    // sobrescrevem com a audiência recortada.
    repo.applyAudienceLimit.mockImplementation((async (where: unknown) => where) as any);
    // Prod: o groupBy do Prisma SEMPRE devolve um array. Os fluxos de dispatch
    // agora reavaliam a conclusão da campanha no fim (gate silencioso), então o
    // mock precisa do mesmo contrato — vazio por padrão ("nenhuma Message
    // materializada" ⇒ maybeCompleteCampaign é no-op).
    repo.groupMessagesByStatus.mockResolvedValue([]);
    // C12 — `resetForRedispatch` devolve POR QUE não pegou a linha
    // ('ok' | 'not_redispatchable' | 'contact_already_live'). O default é o
    // caminho feliz; os testes das duas recusas sobrescrevem.
    repo.resetForRedispatch.mockResolvedValue('ok' as never);
    // I8 — `resetForRetry` ganhou o MESMO contrato do gêmeo
    // ('ok' | 'not_retryable' | 'contact_already_live'). Default feliz; os
    // testes das duas recusas sobrescrevem.
    repo.resetForRetry.mockResolvedValue('ok' as never);

    // Keyset-pagination defaults: an empty audience unless a test wires pages.
    repo.findContactsPage.mockResolvedValue([] as any);
    repo.countContactsByWhere.mockResolvedValue(0);

    // runChecks defaults (used by create() and the runChecks suite): a calm,
    // non-blocking baseline so existing create tests don't trip the send-checks
    // gate added in Task 5.
    repo.hasRunningCampaignOnInstance.mockResolvedValue(false);
    segmentsRepo.countContactsByWhere.mockResolvedValue(0);
    segmentsRepo.preflightSummary.mockResolvedValue({
      total: 0,
      reachable: 0,
      invalid: 0,
      unknown: 0,
    });
    instancesRepo.findById.mockResolvedValue({
      isActive: true,
      sentToday: 0,
      dailySendLimit: 500,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sendWindowEnabled: true,
    } as any);
  });

  /**
   * Wire repo.findContactsPage to serve `all` as keyset pages (paging by the
   * requested `take`, advancing via cursorId on `id`). Mirrors the production
   * keyset contract so tests exercise the real multi-page loop.
   */
  function wireRecipientPages(all: Array<{ id: string; [k: string]: unknown }>) {
    repo.countContactsByWhere.mockResolvedValue(all.length);
    repo.findContactsPage.mockImplementation((async (
      _where: unknown,
      opts: { take: number; cursorId?: string },
    ) => {
      const start = opts.cursorId
        ? all.findIndex((c) => c.id === opts.cursorId) + 1
        : 0;
      return all.slice(start, start + opts.take) as any;
    }) as any);
  }

  // `excludedSameTemplate` entrou no contrato em 2026-08-12 junto com a regra
  // "ninguém recebe o mesmo template duas vezes": é o número que a tela mostra
  // para o operador entender por que a audiência encolheu. Sem `templateId` ele
  // é 0 e o resto da resposta não muda — chamadas antigas seguem idênticas.
  it('preview returns { count, sample } from repo', async () => {
    const filters: FilterGroup = { combinator: 'and', rules: [] };
    repo.countContactsByWhere.mockResolvedValue(7);
    repo.findContactsByWhere.mockResolvedValue([{ id: 'c1' } as any]);
    const result = await service.preview(filters);
    expect(result).toEqual({
      count: 7,
      sample: [{ id: 'c1' }],
      excludedSameTemplate: 0,
      excludedInvalid: 0,
    });
    expect(repo.countContactsByWhere).toHaveBeenCalledTimes(1);
    expect(repo.findContactsByWhere).toHaveBeenCalledWith(
      expect.any(Object),
      10,
    );
  });

  /**
   * F1 T4 — o CHOKE POINT: um filtro com nó history+templateIds tem de ser
   * resolvido (templateId → campaignIds, via 1 query) ANTES do toPrismaWhere,
   * senão o nó não expande e a query final não casa NADA (campaignId nunca
   * é o templateId).
   */
  it('preview com filtro history+templateIds resolve para campaignIds antes de montar o where (F1 T4)', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'campA', templateId: 'tpl1' },
      { id: 'campB', templateId: 'tpl1' },
    ] as never);
    const filters: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          templateIds: ['tpl1'],
        },
      ],
    };
    repo.countContactsByWhere.mockResolvedValue(3);
    repo.findContactsByWhere.mockResolvedValue([]);

    await service.preview(filters);

    expect(prisma.campaign.findMany).toHaveBeenCalledWith({
      where: { templateId: { in: ['tpl1'] } },
      select: { id: true, templateId: true },
    });
    // O where que chega ao repo já usa os campaignIds EXPANDIDOS — nunca o
    // templateId cru, que o Prisma não sabe interpretar em `messages.campaignId`.
    expect(repo.countContactsByWhere).toHaveBeenCalledWith({
      AND: [
        {
          messages: {
            some: {
              campaignId: { in: ['campA', 'campB'] },
              direction: 'OUTBOUND',
              status: { in: ['SENT', 'DELIVERED', 'READ'] },
            },
          },
        },
      ],
    });
  });

  /**
   * "Limitar aos N primeiros contatos" — o recorte com que o cliente dimensiona
   * o disparo de teste.
   *
   * O limite tem de valer nos DOIS lados. Se valesse só na prévia, a tela diria
   * "200" e a campanha materializaria os 13.400 — o oposto do que o operador
   * pediu, e irreversível.
   */
  describe('limite "os N primeiros"', () => {
    it('a prévia CONTA e AMOSTRA a audiência já RECORTADA — não a lista inteira', async () => {
      const filters: FilterGroup = { combinator: 'and', rules: [] };
      const recortada = { AND: [{}, { id: { lte: 'c200' } }] };
      repo.applyAudienceLimit.mockResolvedValue(recortada as any);
      repo.countContactsByWhere.mockResolvedValue(200);
      repo.findContactsByWhere.mockResolvedValue([{ id: 'c1' } as any]);

      const result = await service.preview(filters, 200);

      expect(repo.applyAudienceLimit).toHaveBeenCalledWith(expect.any(Object), 200);
      // A amostra que o operador VÊ sai da audiência recortada — as pessoas que
      // realmente vão receber, e não as 10 do outro extremo da lista.
      expect(repo.countContactsByWhere).toHaveBeenCalledWith(recortada);
      expect(repo.findContactsByWhere).toHaveBeenCalledWith(recortada, 10);
      expect(result.count).toBe(200);
    });

    /**
     * O TESTE QUE IMPORTA. O limite é lido do BANCO no disparo (Campaign.limit),
     * não recebido da tela: quem materializa a audiência é o disparo, e ele roda
     * também no agendador, horas depois, sem ninguém olhando.
     */
    it('o DISPARO recorta a audiência pelo Campaign.limit persistido', async () => {
      const recortada = { AND: [{}, { id: { lte: 'contact2' } }] };
      repo.findById.mockResolvedValue({
        id: 'c2',
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        limit: 2,
      } as any);
      repo.applyAudienceLimit.mockResolvedValue(recortada as any);
      wireRecipientPages([{ id: 'contact1' }, { id: 'contact2' }]);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );

      await service.run('c2');

      expect(repo.applyAudienceLimit).toHaveBeenCalledWith(expect.any(Object), 2);
      // FASE 0 §0.1 — run() agora resolve 'unreached': o `where` não é mais a
      // audiência RECORTADA crua, é a recortada ENVOLVIDA pela exclusão de
      // quem já recebeu (SENT/DELIVERED/READ). Endurecido para exigir a
      // cláusula `messages:{none:...}` também, não afrouxado para um match
      // parcial.
      const unreached = {
        AND: [
          recortada,
          {
            messages: {
              none: {
                campaignId: 'c2',
                direction: 'OUTBOUND',
                status: { in: ['SENT', 'DELIVERED', 'READ'] },
              },
            },
          },
          // C11 — e quem tem falha de entrega INDETERMINADA nesta campanha
          // (pode já ter recebido) também sai da audiência.
          {
            messages: {
              none: {
                campaignId: 'c2',
                direction: 'OUTBOUND',
                status: 'FAILED',
                errorCode: { in: INDETERMINATE_DELIVERY_CODES },
              },
            },
          },
        ],
      };
      // A audiência que o disparo pagina é a RECORTADA + NÃO-ALCANÇADA.
      expect(repo.findContactsPage).toHaveBeenCalledWith(
        unreached,
        expect.any(Object),
      );
      // A.4 — o total gravado na campanha é o PÚBLICO recortado pelo limite
      // (`audience`), não a fatia ainda mais estreita que também exclui quem
      // já foi alcançado (`unreached`/`where` acima) — senão a barra de
      // progresso nasce contra 13.400 e nunca fecha.
      expect(repo.countContactsByWhere).toHaveBeenCalledWith(recortada);
    });

    it('sem limite → audiência intacta (o comportamento de sempre)', async () => {
      const filters: FilterGroup = { combinator: 'and', rules: [] };
      repo.countContactsByWhere.mockResolvedValue(13400);
      repo.findContactsByWhere.mockResolvedValue([]);

      await service.preview(filters);

      expect(repo.applyAudienceLimit).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('runChecks', () => {
    it('assembles input from repos and returns computed checks (incl. always VOLUME + OPT_OUT)', async () => {
      repo.hasRunningCampaignOnInstance.mockResolvedValue(false);
      segmentsRepo.countContactsByWhere.mockResolvedValue(5);
      segmentsRepo.preflightSummary.mockResolvedValue({
        total: 5,
        reachable: 5,
        invalid: 0,
        unknown: 0,
      });
      instancesRepo.findById.mockResolvedValue({
        isActive: true,
        sentToday: 0,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
      } as any);

      const checks = await service.runChecks({
        filters: { combinator: 'and', rules: [] },
        defaultInstanceId: 'inst-1',
        schedule: { type: 'IMMEDIATE' },
        timezone: 'America/Sao_Paulo',
      });

      expect(checks.map((c) => c.code)).toEqual(
        expect.arrayContaining(['VOLUME', 'OPT_OUT']),
      );
    });

    it('uses defensive instance defaults when the instance is missing', async () => {
      repo.hasRunningCampaignOnInstance.mockResolvedValue(false);
      segmentsRepo.countContactsByWhere.mockResolvedValue(0);
      segmentsRepo.preflightSummary.mockResolvedValue({
        total: 0,
        reachable: 0,
        invalid: 0,
        unknown: 0,
      });
      instancesRepo.findById.mockResolvedValue(null as any);
      const checks = await service.runChecks({
        filters: { combinator: 'and', rules: [] },
        defaultInstanceId: 'missing',
        schedule: { type: 'IMMEDIATE' },
        timezone: 'America/Sao_Paulo',
      });
      expect(Array.isArray(checks)).toBe(true);
    });
  });

  it('create throws TemplateNotFoundError when template missing', async () => {
    templatesRepo.findById.mockResolvedValue(null);
    const input: CreateCampaign = {
      name: 'C1',
      templateId: 'missing',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    };
    await expect(service.create(input)).rejects.toThrow(TemplateNotFoundError);
  });

  it('create calls repo.create with totalRecipients from countContactsByWhere', async () => {
    templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
    repo.countContactsByWhere.mockResolvedValue(42);
    repo.create.mockResolvedValue({ id: 'camp1' } as any);
    const input: CreateCampaign = {
      name: 'C1',
      templateId: 't1',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
      schedule: { type: 'IMMEDIATE' as const },
      timezone: 'America/Sao_Paulo',
      // C2 — a finalidade é obrigatória em QUALQUER provedor.
      purposeKey: 'convite_atividades',
    };
    await service.create(input);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'C1',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        totalRecipients: 42,
      }),
    );
  });

  it('cancel throws CampaignNotFoundError when not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.cancel('missing')).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  it('run throws CampaignNotFoundError when not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.run('missing')).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  it('run throws CampaignAlreadyDispatchedError when transitionToQueued returns 0 (race)', async () => {
    repo.findById
      .mockResolvedValueOnce({
        id: 'c1',
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any)
      // After race, fresh read shows the rival caller advanced status to QUEUED
      .mockResolvedValueOnce({
        id: 'c1',
        status: 'QUEUED',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
    repo.findContactsByWhere.mockResolvedValue([]);
    repo.transitionToQueued.mockResolvedValue(0);
    await expect(service.run('c1')).rejects.toThrow(
      CampaignAlreadyDispatchedError,
    );
  });

  it('run succeeds when transitionToQueued claims the DRAFT (count=1)', async () => {
    repo.findById.mockResolvedValue({
      id: 'c2',
      status: 'DRAFT',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([
      { id: 'contact1', name: 'A' },
      { id: 'contact2', name: 'B' },
    ]);
    repo.transitionToQueued.mockResolvedValue(1);
    repo.createMessage.mockImplementation(
      async ({ contactId }: { contactId: string }) =>
        ({ id: `msg-${contactId}` }) as any,
    );
    const result = await service.run('c2');
    expect(result).toEqual({ queued: 2 });
    expect(repo.transitionToQueued).toHaveBeenCalledWith('c2', 2, {
      disarmSchedule: true,
    });
    expect(sendQueue.add).toHaveBeenCalledTimes(2);
  });

  it('run acquires the shared per-campaign resend lock (mutual exclusion with the scheduler)', async () => {
    // Bug 2 — run() must hold the same 'resend' lock runScheduled uses, so a
    // manual dispatch and a scheduler tick can't both send the same campaign.
    repo.findById.mockResolvedValue({
      id: 'c2',
      status: 'DRAFT',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([{ id: 'k1' }]);
    repo.transitionToQueued.mockResolvedValue(1);
    repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

    await service.run('c2');

    expect(redis.set).toHaveBeenCalledWith(
      'campaign:lock:resend:c2',
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('run bounces with CampaignOperationInProgressError when the resend lock is held', async () => {
    redis.set.mockResolvedValue(null); // held by a concurrent scheduler tick
    repo.findById.mockResolvedValue({
      id: 'c2',
      status: 'DRAFT',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([{ id: 'k1' }]);

    await expect(service.run('c2')).rejects.toThrow(
      CampaignOperationInProgressError,
    );
    expect(repo.transitionToQueued).not.toHaveBeenCalled();
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('run disarms the schedule for a one-shot ONCE_AT campaign fired manually', async () => {
    repo.findById.mockResolvedValue({
      id: 'cOnce',
      status: 'DRAFT',
      scheduleType: 'ONCE_AT',
      scheduleEnabled: true,
      nextRunAt: new Date(Date.now() + 3_600_000),
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([{ id: 'k1' }]);
    repo.transitionToQueued.mockResolvedValue(1);
    repo.createMessage.mockResolvedValue({ id: 'msg-1' } as any);

    await service.run('cOnce');

    // ONCE_AT is consumed by the manual fire -> schedule must be disarmed so the
    // scheduler does not re-fire the whole audience at the original nextRunAt.
    expect(repo.transitionToQueued).toHaveBeenCalledWith('cOnce', 1, {
      disarmSchedule: true,
    });
  });

  it('run keeps the schedule armed for a recurring DAILY_AT campaign fired manually', async () => {
    repo.findById.mockResolvedValue({
      id: 'cDaily',
      status: 'DRAFT',
      scheduleType: 'DAILY_AT',
      scheduleEnabled: true,
      nextRunAt: new Date(Date.now() + 3_600_000),
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([{ id: 'k1' }]);
    repo.transitionToQueued.mockResolvedValue(1);
    repo.createMessage.mockResolvedValue({ id: 'msg-1' } as any);

    await service.run('cDaily');

    // Recurring schedule must stay armed so the daily cadence continues after a
    // manual ad-hoc fire (no silent loss of the recurrence).
    expect(repo.transitionToQueued).toHaveBeenCalledWith('cDaily', 1, {
      disarmSchedule: false,
    });
  });

  it('run propagates correlationId from CLS into job payload', async () => {
    repo.findById.mockResolvedValue({
      id: 'c3',
      status: 'DRAFT',
      defaultInstanceId: 'inst-1',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
    } as any);
    wireRecipientPages([{ id: 'contact1' }]);
    repo.transitionToQueued.mockResolvedValue(1);
    repo.createMessage.mockResolvedValue({ id: 'msg-1' } as any);
    cls.get.mockReturnValue({ correlationId: 'req-abc-123' } as any);

    await service.run('c3');

    expect(sendQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messageId: 'msg-1',
        campaignId: 'c3',
        correlationId: 'req-abc-123',
      }),
      expect.any(Object),
    );
  });

  // ── Médio: keyset pagination on dispatch (no giant in-memory array) ───────
  describe('run — keyset-paginated audience (no full-array load)', () => {
    it('pages through the whole audience and enqueues EVERY recipient', async () => {
      repo.findById.mockResolvedValue({
        id: 'cP',
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: { name: { source: 'field', field: 'name' } },
      } as any);
      // 1200 recipients → > 2 pages at DISPATCH_CHUNK_SIZE (500)
      const all = Array.from({ length: 1200 }, (_, i) => ({
        id: `k${i.toString().padStart(4, '0')}`,
        name: `N${i}`,
      }));
      wireRecipientPages(all);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );

      const result = await service.run('cP');

      expect(result).toEqual({ queued: 1200 });
      expect(repo.createMessage).toHaveBeenCalledTimes(1200);
      expect(sendQueue.add).toHaveBeenCalledTimes(1200);
      // Never loaded the whole audience in one array.
      expect(repo.findContactsByWhere).not.toHaveBeenCalled();
      // transitionToQueued is reserved with the COUNT, not an array length.
      expect(repo.transitionToQueued).toHaveBeenCalledWith('cP', 1200, {
        disarmSchedule: true,
      });
    });

    it('selects only id + the variableMap field columns', async () => {
      repo.findById.mockResolvedValue({
        id: 'cS',
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {
          nome: { source: 'field', field: 'name' },
          saud: { source: 'literal', value: 'Olá' },
        },
      } as any);
      repo.countContactsByWhere.mockResolvedValue(0);
      repo.findContactsPage.mockResolvedValue([] as any);
      repo.transitionToQueued.mockResolvedValue(1);

      await service.run('cS');

      const opts = repo.findContactsPage.mock.calls[0][1] as {
        select: Record<string, boolean>;
      };
      // id is always selected; the literal mapping contributes no column.
      // C1: `phoneE164` é do GATE, não do variableMap — a supressão é chaveada
      // por phoneHash (derivado do telefone). `optedOut` NÃO é mais pedido: a
      // decisão do cliente de 25/08/2026 tirou o cache do caminho de envio, e
      // uma coluna que ninguém lê não deve ser trazida por 13k linhas.
      expect(opts.select).toEqual({
        id: true,
        name: true,
        phoneE164: true,
      });
      expect(opts.select).not.toHaveProperty('optedOut');
    });
  });

  /**
   * A REDE do `resolveAudience`: o `where` é calculado UMA vez e a paginação
   * keyset percorre a base por minutos. Um contato pode ficar bloqueado NO MEIO
   * do laço — é o caso de duas campanhas irmãs do mesmo template disparadas em
   * paralelo, que foi justamente o cenário que originou a regra (500 + 500).
   *
   * Sem esta checagem no momento de gravar, a janela entre calcular o `where` e
   * criar a Message é TOCTOU puro, e a segunda campanha duplica a entrega.
   */
  describe('dispatchAudience — trava do mesmo template na gravação', () => {
    function campanhaComTemplate(id: string) {
      repo.findById.mockResolvedValue({
        id,
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        templateId: 'tpl-T',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as never);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as never,
      );
    }

    it('não grava para quem passou pelo WHERE mas já está em campanha do mesmo template', async () => {
      campanhaComTemplate('cRace');
      wireRecipientPages([{ id: 'k0' }, { id: 'k1' }] as never);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'irma-viva', status: 'RUNNING' },
      ] as never);
      // k0 ganhou uma mensagem bloqueadora DEPOIS que o `where` foi montado.
      prisma.message.findMany.mockResolvedValue([
        { contactId: 'k0' },
      ] as never);

      await service.run('cRace');

      const gravados = repo.createMessage.mock.calls.map(
        (c) => (c[0] as { contactId: string }).contactId,
      );
      expect(gravados).toEqual(['k1']);
    });

    it('sem campanha irmã do template, ninguém é barrado e nem se consulta mensagem', async () => {
      campanhaComTemplate('cLivre');
      wireRecipientPages([{ id: 'k0' }, { id: 'k1' }] as never);
      prisma.campaign.findMany.mockResolvedValue([] as never);
      prisma.message.findMany.mockResolvedValue([] as never);

      await service.run('cLivre');

      const gravados = repo.createMessage.mock.calls.map(
        (c) => (c[0] as { contactId: string }).contactId,
      );
      expect(gravados).toEqual(['k0', 'k1']);
      // Sem irmãs não há o que perguntar — a query por página não roda.
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    /**
     * C3 (auditoria 2026-08-19) — A REDE CONGELADA.
     *
     * `sameTemplateBlock` era calculado UMA vez, antes do laço de paginação.
     * Quando o disparo começa sem nenhuma campanha irmã, o filtro nasce `null`
     * e a rede fica DESLIGADA o disparo inteiro — inclusive para as páginas
     * varridas minutos depois, quando a irmã já existe e já gravou mensagens.
     * É o caso 500+500 que originou a regra, na ordem inversa.
     */
    it('enxerga a campanha irmã CRIADA NO MEIO do disparo (a rede é recalculada por página)', async () => {
      campanhaComTemplate('cLento');
      // Duas páginas cheias: a irmã nasce entre a primeira e a segunda.
      const pagina1 = Array.from({ length: 500 }, (_, i) => ({ id: `a${i}` }));
      wireRecipientPages([...pagina1, { id: 'b0' }] as never);

      let paginasVarridas = 0;
      repo.findContactsPage.mockImplementation((async (
        _where: unknown,
        opts: { take: number; cursorId?: string },
      ) => {
        paginasVarridas += 1;
        return (opts.cursorId ? [{ id: 'b0' }] : pagina1) as never;
      }) as never);

      // t0: nenhuma irmã. A partir da 2ª página, a irmã existe.
      prisma.campaign.findMany.mockImplementation((async () =>
        (paginasVarridas >= 2
          ? [{ id: 'irma-nova', status: 'RUNNING' }]
          : []) as never) as never);
      // b0 já tem mensagem na irmã recém-criada.
      prisma.message.findMany.mockResolvedValue([{ contactId: 'b0' }] as never);

      await service.run('cLento');

      const gravados = repo.createMessage.mock.calls.map(
        (c) => (c[0] as { contactId: string }).contactId,
      );
      expect(gravados).not.toContain('b0');
      expect(gravados).toHaveLength(500);
    });
  });

  // ── C1: gate de consentimento POR FINALIDADE ──────────────────────────────
  // O gate do T8 era binário (`optInAt != null`), sem finalidade, e furável por
  // um booleano — era, por construção, a autorização genérica que o art. 8º §4º
  // anula. Agora: consentimento ATIVO para A FINALIDADE DESTA campanha, em
  // TODOS os provedores (o Evolution não tem obrigação com a Meta a violar, mas
  // tem com a lei brasileira, igual).
  describe('C1 — gate de consentimento por finalidade', () => {
    function wireCampaign(over: Record<string, unknown> = {}) {
      repo.findById.mockResolvedValue({
        id: 'cOpt',
        status: 'DRAFT',
        defaultInstanceId: 'inst-tw',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        purposeKey: 'convite_atividades',
        override: false,
        overrideJustification: null,
        ...over,
      } as any);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );
      repo.createSkippedMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `skip-${contactId}` }) as any,
      );
    }

    const twilio = { id: 'inst-tw', provider: 'TWILIO', isActive: true };
    const evolution = { id: 'inst-tw', provider: 'EVOLUTION', isActive: true };

    it('quem consentiu para a finalidade A NÃO recebe a campanha de finalidade B', async () => {
      // A campanha é de `captacao_recursos`; o contato só consentiu para
      // `convite_atividades` — logo, grantedContactIds (que consulta a
      // finalidade DA CAMPANHA) devolve vazio.
      wireCampaign({ purposeKey: 'captacao_recursos' });
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([{ id: 'ct-outra-finalidade', phoneE164: '+5592991110001' }]);
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(consent.grantedContactIds).toHaveBeenCalledWith(
        ['ct-outra-finalidade'],
        'captacao_recursos',
      );
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'ct-outra-finalidade',
          reason: 'no_consent',
        }),
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('quem consentiu para a finalidade DA campanha é enfileirado', async () => {
      wireCampaign();
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([
        { id: 'ct-sim', phoneE164: '+5592991110001' },
        { id: 'ct-nao', phoneE164: '+5592991110002' },
      ]);
      consent.grantedContactIds.mockResolvedValue(new Set(['ct-sim']));

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 1 });
      expect(repo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-sim' }),
      );
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-nao', reason: 'no_consent' }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.consent_skipped',
        'Campaign',
        'cOpt',
        expect.objectContaining({ skippedNoConsent: 1, purposeKey: 'convite_atividades' }),
      );
    });

    it('SUPRIMIDO nunca recebe — nem tendo consentido a finalidade', async () => {
      wireCampaign();
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([{ id: 'ct-supr', phoneE164: '+5592991110003' }]);
      // Estado contraditório de propósito: consentimento ativo E supressão. A
      // revogação é ABSOLUTA (art. 8º §5º) e vem primeiro na ordem do gate.
      consent.grantedContactIds.mockResolvedValue(new Set(['ct-supr']));
      consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110003']));

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-supr', reason: 'suppressed' }),
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * ★ Decisão do cliente, 25/08/2026 — a SEGUNDA camada do opt-out (as
     * barreiras de ENVIO) foi removida, com o risco de LGPD/WhatsApp
     * apresentado e aceito por escrito. O cache `Contact.optedOut` NÃO barra
     * mais ninguém: quem só tem o booleano, e nenhuma entrada durável na
     * `SuppressionList`, volta a receber.
     *
     * RED antes desta mudança: `{ queued: 0 }` + linha `SKIPPED_SUPPRESSED`.
     */
    it('optedOut sozinho NÃO barra mais — sem SuppressionList o contato RECEBE', async () => {
      wireCampaign();
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([
        { id: 'ct-cache', phoneE164: '+5592991110004', optedOut: true },
      ]);
      consent.grantedContactIds.mockResolvedValue(new Set(['ct-cache']));
      consent.suppressedPhones.mockResolvedValue(new Set()); // SuppressionList "não viu"

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 1 });
      expect(repo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-cache' }),
      );
      expect(repo.createSkippedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'suppressed' }),
      );
    });

    /**
     * A CHAVE DURÁVEL continua absoluta. O `optedOut = true` aqui é ruído: o
     * que pula é a `SuppressionList` por `phoneHash` — e ela não foi tocada
     * pela decisão de 25/08/2026.
     */
    it('optedOut + SuppressionList: quem está na lista durável continua pulado', async () => {
      wireCampaign();
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([
        { id: 'ct-durav', phoneE164: '+5592991110044', optedOut: true },
      ]);
      consent.grantedContactIds.mockResolvedValue(new Set(['ct-durav']));
      consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110044']));

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-durav', reason: 'suppressed' }),
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * O gate de consentimento por finalidade é OUTRA regra e continua de pé:
     * `optedOut = true` não o transforma em "pode enviar".
     */
    it('optedOut liberado NÃO fura o gate de consentimento — sem finalidade ativa, SKIPPED_NO_CONSENT', async () => {
      wireCampaign();
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([
        { id: 'ct-semcons', phoneE164: '+5592991110045', optedOut: true },
      ]);
      consent.grantedContactIds.mockResolvedValue(new Set());
      consent.suppressedPhones.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-semcons', reason: 'no_consent' }),
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('override NÃO fura o gate em canal oficial (TWILIO) — é inexprimível, não desencorajado', async () => {
      wireCampaign({
        override: true,
        overrideJustification: 'base histórica do projeto X, risco assumido',
      });
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([{ id: 'ct-sem', phoneE164: '+5592991110005' }]);
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'ct-sem', reason: 'no_consent' }),
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('override em EVOLUTION, com justificativa e dentro do teto, envia (+ audit vermelho)', async () => {
      wireCampaign({
        override: true,
        overrideJustification: 'base histórica do projeto X, risco assumido',
      });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-sem', phoneE164: '+5592991110006' }]);
      repo.countContactsByWhere.mockResolvedValue(50); // dentro do teto de 100
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 1 });
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.consent_override',
        'Campaign',
        'cOpt',
        expect.objectContaining({
          recipients: 1,
          justification: 'base histórica do projeto X, risco assumido',
        }),
      );
    });

    it('override em EVOLUTION SEM justificativa é ignorado', async () => {
      wireCampaign({ override: true, overrideJustification: '   ' });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-sem', phoneE164: '+5592991110007' }]);
      repo.countContactsByWhere.mockResolvedValue(10);
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
    });

    it('override em EVOLUTION acima do teto de 100 destinatários é ignorado', async () => {
      wireCampaign({
        override: true,
        overrideJustification: 'justificativa suficientemente longa',
      });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-sem', phoneE164: '+5592991110008' }]);
      repo.countContactsByWhere.mockResolvedValue(101); // estourou o teto
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
    });

    it('override NUNCA fura a supressão, nem em EVOLUTION (art. 8º §5º)', async () => {
      wireCampaign({
        override: true,
        overrideJustification: 'justificativa suficientemente longa',
      });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-supr', phoneE164: '+5592991110009' }]);
      repo.countContactsByWhere.mockResolvedValue(10);
      consent.suppressedPhones.mockResolvedValue(new Set(['+5592991110009']));

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'suppressed' }),
      );
    });

    it('override em finalidade SENSÍVEL é ignorado, mesmo em EVOLUTION (art. 11)', async () => {
      wireCampaign({
        purposeKey: 'saude_indigena',
        override: true,
        overrideJustification: 'justificativa suficientemente longa',
      });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-sens', phoneE164: '+5592991110010' }]);
      repo.countContactsByWhere.mockResolvedValue(10);
      consent.grantedContactIds.mockResolvedValue(new Set());
      consent.isSensitivePurpose.mockResolvedValue(true);

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
    });

    it('campanha SEM finalidade não passa ninguém (sem finalidade não há consentimento válido)', async () => {
      wireCampaign({ purposeKey: null });
      instancesRepo.findById.mockResolvedValue(evolution as any);
      wireRecipientPages([{ id: 'ct-x', phoneE164: '+5592991110011' }]);
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createSkippedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no_consent' }),
      );
    });

    it('finalidade utility (servico_projeto): a janela de 24h aberta autoriza o envio', async () => {
      wireCampaign({ purposeKey: 'servico_projeto' });
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([{ id: 'ct-janela', phoneE164: '+5592991110012' }]);
      consent.grantedContactIds.mockResolvedValue(new Set()); // não consentiu…
      repo.findContactsWithOpenWindow.mockResolvedValue(new Set(['ct-janela'])); // …mas falou com a gente

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 1 });
    });

    it('a janela NÃO é consultada para finalidade de marketing (ela autoriza conversar, não fazer campanha)', async () => {
      wireCampaign({ purposeKey: 'captacao_recursos' });
      instancesRepo.findById.mockResolvedValue(twilio as any);
      wireRecipientPages([{ id: 'ct-janela', phoneE164: '+5592991110013' }]);
      consent.grantedContactIds.mockResolvedValue(new Set());

      const result = await service.run('cOpt');

      expect(result).toEqual({ queued: 0 });
      expect(repo.findContactsWithOpenWindow).not.toHaveBeenCalled();
    });
  });

  /**
   * C1b — a finalidade tem de ser DECLARADA na criação, não descoberta no
   * dispatch.
   *
   * Sem esta validação o C1 é uma armadilha: o wizard cria a campanha sem
   * `purposeKey`, o gate (corretamente) não passa ninguém, e o operador vê 13k
   * destinatários virarem 13k SKIPPED_NO_CONSENT sem uma linha de erro. Falhar
   * na criação é a única forma de o erro ser legível.
   */
  describe('C1b/C2 — finalidade obrigatória em TODOS os provedores', () => {
    function officialChannel(provider: string) {
      return {
        id: 'inst-1',
        isActive: true,
        provider,
        sentToday: 0,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
      } as any;
    }

    function createInput(overrides: Record<string, unknown> = {}) {
      return {
        name: 'C1',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' as const },
        timezone: 'America/Sao_Paulo',
        ...overrides,
      } as any;
    }

    beforeEach(() => {
      repo.create.mockResolvedValue({ id: 'camp1' } as any);
      consent.findActivePurpose.mockImplementation((async (key: string | null) =>
        key ? { key, label: key, description: '', isSensitive: false } : null) as any);
    });

    // C2 — EVOLUTION entra na lista. Antes ela era opcional lá (spec §4.5), o
    // que produzia FALHA SILENCIOSA: o gate de dispatch exige consentimento POR
    // FINALIDADE em todo provedor, então uma campanha EVOLUTION sem finalidade
    // era criada com sucesso e não enviava NADA — 100% SKIPPED_NO_CONSENT, sem
    // uma linha de erro para o operador.
    for (const provider of ['TWILIO', 'META', 'ZERNIO', 'EVOLUTION']) {
      it(`recusa a criação SEM finalidade em canal ${provider}`, async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider,
          status: 'APPROVED',
        } as any);
        instancesRepo.findById.mockResolvedValue(officialChannel(provider));

        const err = await service
          .create(createInput())
          .then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe('campaign.purpose_required');
        expect((err as ValidationError).message).toBe(
          'Selecione a finalidade da campanha — o consentimento é registrado por finalidade.',
        );
        expect(repo.create).not.toHaveBeenCalled();
      });
    }

    it('cria normalmente em canal oficial COM finalidade, e persiste a purposeKey', async () => {
      templatesRepo.findById.mockResolvedValue({ id: 't1', provider: 'TWILIO', status: 'APPROVED' } as any);
      instancesRepo.findById.mockResolvedValue(officialChannel('TWILIO'));

      await service.create(createInput({ purposeKey: 'convite_atividades' }));

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ purposeKey: 'convite_atividades' }),
      );
    });

    it('recusa finalidade INEXISTENTE (ou inativa) — no gate ela é indistinguível de campanha sem finalidade', async () => {
      templatesRepo.findById.mockResolvedValue({ id: 't1', provider: 'TWILIO', status: 'APPROVED' } as any);
      instancesRepo.findById.mockResolvedValue(officialChannel('TWILIO'));
      consent.findActivePurpose.mockResolvedValue(null as any);

      const err = await service
        .create(createInput({ purposeKey: 'finalidade_fantasma' }))
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('campaign.purpose_unknown');
      expect(repo.create).not.toHaveBeenCalled();
    });

    /**
     * C2 — EVOLUTION com finalidade cria normalmente: o que morreu foi a campanha
     * SEM finalidade, não o canal. O override (justificativa + teto de 100)
     * continua exclusivo do Evolution — mas agora ele fura a falta de
     * CONSENTIMENTO, nunca a falta de FINALIDADE (sem finalidade não há sequer o
     * que consentir).
     */
    it('EVOLUTION cria normalmente COM finalidade declarada', async () => {
      templatesRepo.findById.mockResolvedValue({ id: 't1', provider: 'EVOLUTION', status: 'APPROVED' } as any);
      instancesRepo.findById.mockResolvedValue(officialChannel('EVOLUTION'));

      await service.create(createInput({ purposeKey: 'convite_atividades' }));

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ purposeKey: 'convite_atividades' }),
      );
    });

    it('em EVOLUTION uma finalidade INVÁLIDA também é recusada', async () => {
      templatesRepo.findById.mockResolvedValue({ id: 't1', provider: 'EVOLUTION', status: 'APPROVED' } as any);
      instancesRepo.findById.mockResolvedValue(officialChannel('EVOLUTION'));
      consent.findActivePurpose.mockResolvedValue(null as any);

      const err = await service
        .create(createInput({ purposeKey: 'finalidade_fantasma' }))
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('campaign.purpose_unknown');
    });
  });

  /**
   * C1b — o wizard precisa mostrar, ANTES do disparo, quantos da audiência
   * filtrada consentiram para a finalidade escolhida. O `preflightChecks` já
   * resolve a audiência; ele só não sabia perguntar pelo consentimento.
   */
  describe('C1b — preflightChecks conta o consentimento por finalidade', () => {
    const preflightInput = {
      filters: { combinator: 'and', rules: [] },
      defaultInstanceId: 'inst-1',
      schedule: { type: 'IMMEDIATE' as const },
      timezone: 'America/Sao_Paulo',
    } as any;

    it('devolve consentiram/serão pulados quando a finalidade é informada', async () => {
      segmentsRepo.countContactsByWhere.mockResolvedValue(120);
      consent.countGrantedInAudience.mockResolvedValue(42);
      consent.countEligibleInAudience.mockResolvedValue(42);

      const result = await service.preflightChecks({
        ...preflightInput,
        purposeKey: 'convite_atividades',
      });

      expect(result.consent).toEqual({
        purposeKey: 'convite_atividades',
        withConsent: 42,
        viaOpenWindow: 0,
        eligible: 42,
        withoutConsent: 78,
      });
      expect(consent.countGrantedInAudience).toHaveBeenCalledWith(
        expect.anything(),
        'convite_atividades',
      );
    });

    it('sem finalidade não inventa número: consent = null (e não consulta)', async () => {
      segmentsRepo.countContactsByWhere.mockResolvedValue(120);

      const result = await service.preflightChecks(preflightInput);

      expect(result.consent).toBeNull();
      expect(consent.countGrantedInAudience).not.toHaveBeenCalled();
      expect(consent.countEligibleInAudience).not.toHaveBeenCalled();
    });

    /*
      O preflight virou GATE DE UI (ele trava o botão de disparo). No instante em
      que passou a travar, ele precisou contar EXATAMENTE o que o gate real conta
      — senão a tela BLOQUEIA um envio que o backend autorizaria: o bug do
      ticket, de cabeça para baixo.
    */
    it('finalidade de SERVIÇO: a janela de 24h conta como elegível (o gate envia)', async () => {
      segmentsRepo.countContactsByWhere.mockResolvedValue(200);
      // Ninguém deu opt-in explícito…
      consent.countGrantedInAudience.mockResolvedValue(0);
      // …mas os 200 responderam nas últimas 24h: o gate (decide()) manda enviar.
      consent.countEligibleInAudience.mockResolvedValue(200);

      const result = await service.preflightChecks({
        ...preflightInput,
        purposeKey: 'servico_projeto',
      });

      expect(result.consent).toEqual({
        purposeKey: 'servico_projeto',
        withConsent: 0,
        viaOpenWindow: 200,
        eligible: 200,
        withoutConsent: 0,
      });
      // A janela é consultada NO CANAL da campanha e com o mesmo recorte de 24h.
      const [, purposeKey, window] =
        consent.countEligibleInAudience.mock.calls[0];
      expect(purposeKey).toBe('servico_projeto');
      expect(window?.instanceId).toBe('inst-1');
      const ageMs = Date.now() - (window as { since: Date }).since.getTime();
      expect(ageMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5_000);
      expect(ageMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
    });

    it('finalidade de MARKETING: a janela NÃO é consultada (ela não autoriza campanha)', async () => {
      segmentsRepo.countContactsByWhere.mockResolvedValue(10);
      consent.countGrantedInAudience.mockResolvedValue(3);
      consent.countEligibleInAudience.mockResolvedValue(3);

      await service.preflightChecks({
        ...preflightInput,
        purposeKey: 'captacao_recursos',
      });

      expect(consent.countEligibleInAudience).toHaveBeenCalledWith(
        expect.anything(),
        'captacao_recursos',
        null,
      );
    });
  });

  describe('create — ONCE_AT validation', () => {
    it('rejects ONCE_AT scheduled in the past with ValidationError', async () => {
      templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
      repo.countContactsByWhere.mockResolvedValue(0);
      const past = new Date(Date.now() - 60_000).toISOString();
      const input: CreateCampaign = {
        name: 'C1',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'ONCE_AT' as const, runAt: new Date(past) as any },
        timezone: 'America/Sao_Paulo',
        presenceDelayMs: 0,
        // C2 — finalidade obrigatória em qualquer provedor.
        purposeKey: 'convite_atividades',
      } as any;
      const err = await service
        .create(input)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('campaign.schedule_in_past');
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('create — blocking send-checks enforcement', () => {
    // A blocking VOLUME check: a large audience (>=100) overflowing the
    // instance's remaining daily budget.
    function wireBlockingCheck() {
      templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
      repo.countContactsByWhere.mockResolvedValue(1000);
      segmentsRepo.countContactsByWhere.mockResolvedValue(1000);
      segmentsRepo.preflightSummary.mockResolvedValue({
        total: 1000,
        reachable: 1000,
        invalid: 0,
        unknown: 0,
      });
      instancesRepo.findById.mockResolvedValue({
        isActive: true,
        sentToday: 495,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
      } as any);
      repo.hasRunningCampaignOnInstance.mockResolvedValue(false);
    }

    /**
     * DECISÃO DO DONO (2026-08-12): volume alto ALERTA, não bloqueia — o risco
     * de ban é do número do cliente, que foi informado e assumiu. Este teste
     * garantia o oposto e foi INVERTIDO de propósito, não apagado: ele agora
     * trava a decisão nova.
     *
     * Por que a antiga saiu: para furar o bloqueio o operador tinha de marcar
     * "entendo o risco", e essa MESMA flag vira override de CONSENTIMENTO em
     * provedor não-oficial — recusado sem justificativa escrita. A campanha
     * não salvava de jeito nenhum (4 tentativas reais em produção).
     *
     * `CampaignBlockedError` CONTINUA no serviço de propósito: é o ponto de
     * aplicação para qualquer checagem `block` futura. Hoje só o
     * INSTANCE_DELETED tem essa severidade, e ele é barrado antes, com
     * mensagem própria — enviar por canal removido é impossível, não é risco.
     */
    it('volume estourado NÃO impede mais a criação — ele vira alerta', async () => {
      wireBlockingCheck();
      repo.create.mockResolvedValue({ id: 'c1' } as any);

      await service.create({
        name: 'X',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' },
        timezone: 'America/Sao_Paulo',
        purposeKey: 'convite_atividades',
        override: false,
      } as any);

      expect(repo.create).toHaveBeenCalled();
    });

    /**
     * O corolário que IMPORTA: sem bloqueio, ninguém precisa marcar "entendo o
     * risco" — e portanto ninguém tropeça no override de consentimento. Uma
     * campanha comum se cria com `override: false` e NÃO leva
     * `campaign.override_justification_required`.
     */
    it('criação comum não exige justificativa de override', async () => {
      wireBlockingCheck();
      repo.create.mockResolvedValue({ id: 'c1' } as any);

      await expect(
        service.create({
          name: 'X',
          templateId: 't1',
          defaultInstanceId: 'i1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          schedule: { type: 'IMMEDIATE' },
          timezone: 'America/Sao_Paulo',
          purposeKey: 'convite_atividades',
          override: false,
        } as any),
      ).resolves.toBeDefined();
    });

    it('succeeds past a block check when override is true', async () => {
      wireBlockingCheck();
      repo.create.mockResolvedValue({ id: 'c1' } as any);

      await service.create({
        name: 'X',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' },
        timezone: 'America/Sao_Paulo',
        purposeKey: 'convite_atividades',
        override: true,
      } as any);

      expect(repo.create).toHaveBeenCalled();
    });

    // ── Regressão Task 2 (F0 — modelo de capacidades), constatação Important ──
    // `channel != null && !isOfficialProvider(channel.provider)` (o snippet
    // literal do brief) muda a tabela-verdade do código antigo
    // (`channel?.provider === 'EVOLUTION'`) no caso degenerado em que o canal
    // existe mas `provider` está ausente/undefined: o antigo tratava esse caso
    // como "não é EVOLUTION" (invariantes NÃO se aplicam, igual a um provider
    // oficial); `isOfficialProvider(undefined)` retorna `false`, então
    // `!isOfficialProvider(undefined)` é `true` — o oposto. Inalcançável por
    // dados reais (Channel.provider é coluna Prisma não-nula), mas a Global
    // Constraint do plano exige tabela-verdade idêntica mesmo nos degenerados.
    // Corrigido com `channel?.provider != null && ...`. Os dois testes abaixo
    // travam essa correção: o provider ausente deve se comportar EXATAMENTE
    // como um canal oficial (invariantes ignoradas), NUNCA como EVOLUTION.
    it('provider ausente/undefined não exige justificativa — mesma tabela-verdade de um canal oficial (regressão)', async () => {
      wireBlockingCheck(); // instancesRepo.findById devolve canal SEM `provider`
      repo.create.mockResolvedValue({ id: 'c1' } as any);

      await service.create({
        name: 'X',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' },
        timezone: 'America/Sao_Paulo',
        purposeKey: 'convite_atividades',
        override: true,
        // Propositalmente SEM overrideJustification: se as invariantes do C1
        // (que só valem em canal NÃO-oficial) fossem erroneamente aplicadas ao
        // provider ausente, isto lançaria ValidationError.
      } as any);

      expect(repo.create).toHaveBeenCalled();
    });

    it('provider EVOLUTION explícito EXIGE justificativa (contraste: undefined não deve se comportar como EVOLUTION)', async () => {
      wireBlockingCheck();
      // provider igual ao do canal, para não disparar o gate T7 (mismatch
      // template×canal) antes de chegar nas invariantes de override do C1.
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        status: 'APPROVED',
        provider: 'EVOLUTION',
      } as any);
      instancesRepo.findById.mockResolvedValue({
        isActive: true,
        sentToday: 495,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
        provider: 'EVOLUTION',
      } as any);

      await expect(
        service.create({
          name: 'X',
          templateId: 't1',
          defaultInstanceId: 'i1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          schedule: { type: 'IMMEDIATE' },
          timezone: 'America/Sao_Paulo',
          purposeKey: 'convite_atividades',
          override: true,
        } as any),
      ).rejects.toThrow(ValidationError);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // ── U2 — a deleted/inactive default instance must be rejected ──────────────
  // Prod incident: a campaign was created with defaultInstanceId pointing to a
  // soft-deleted instance (isActive=false); creation succeeded and every send
  // then failed at the router. The instance must be validated at create time
  // (hard, NOT overridable) and surfaced as a block-severity preflight check.
  describe('U2 — deleted/inactive default instance', () => {
    const CHECK_MESSAGE =
      'A conexão selecionada foi removida ou não existe. Selecione outra conexão para a campanha.';
    const CREATE_MESSAGE =
      'A conexão selecionada foi removida ou não existe. Selecione outra conexão.';

    function activeInstance(overrides: Record<string, unknown> = {}) {
      return {
        id: 'inst-1',
        isActive: true,
        sentToday: 0,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
        ...overrides,
      } as any;
    }

    function baseCreateInput(overrides: Record<string, unknown> = {}) {
      return {
        name: 'C1',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' as const },
        timezone: 'America/Sao_Paulo',
        // C2 — finalidade obrigatória em QUALQUER provedor.
        purposeKey: 'convite_atividades',
        ...overrides,
      } as any;
    }

    describe('runChecks', () => {
      it('appends a block INSTANCE_DELETED check when the instance row is missing', async () => {
        instancesRepo.findById.mockResolvedValue(null as any);

        const checks = await service.runChecks({
          filters: { combinator: 'and', rules: [] },
          defaultInstanceId: 'gone',
          schedule: { type: 'IMMEDIATE' },
          timezone: 'America/Sao_Paulo',
        });

        expect(checks).toContainEqual({
          code: 'INSTANCE_DELETED',
          severity: 'block',
          message: CHECK_MESSAGE,
        });
      });

      it('appends a block INSTANCE_DELETED check when the instance is soft-deleted (isActive=false)', async () => {
        instancesRepo.findById.mockResolvedValue(
          activeInstance({ isActive: false }),
        );

        const checks = await service.runChecks({
          filters: { combinator: 'and', rules: [] },
          defaultInstanceId: 'inst-1',
          schedule: { type: 'IMMEDIATE' },
          timezone: 'America/Sao_Paulo',
        });

        expect(checks).toContainEqual({
          code: 'INSTANCE_DELETED',
          severity: 'block',
          message: CHECK_MESSAGE,
        });
      });

      it('does NOT append INSTANCE_DELETED for an active instance', async () => {
        instancesRepo.findById.mockResolvedValue(activeInstance());

        const checks = await service.runChecks({
          filters: { combinator: 'and', rules: [] },
          defaultInstanceId: 'inst-1',
          schedule: { type: 'IMMEDIATE' },
          timezone: 'America/Sao_Paulo',
        });

        expect(checks.map((c) => c.code)).not.toContain('INSTANCE_DELETED');
      });
    });

    describe('create', () => {
      it('throws ValidationError (campaign.instance_deleted) when the instance row is missing', async () => {
        templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
        instancesRepo.findById.mockResolvedValue(null as any);

        const err = await service
          .create(baseCreateInput({ defaultInstanceId: 'gone' }))
          .then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe('campaign.instance_deleted');
        expect((err as ValidationError).message).toBe(CREATE_MESSAGE);
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('throws ValidationError (campaign.instance_deleted) when the instance is inactive', async () => {
        templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
        instancesRepo.findById.mockResolvedValue(
          activeInstance({ isActive: false }),
        );

        const err = await service
          .create(baseCreateInput())
          .then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe('campaign.instance_deleted');
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('throws even with override=true — a deleted instance is NOT an overridable risk', async () => {
        templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
        instancesRepo.findById.mockResolvedValue(
          activeInstance({ isActive: false }),
        );

        const err = await service
          .create(baseCreateInput({ override: true }))
          .then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe('campaign.instance_deleted');
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('still creates normally when the instance is active', async () => {
        templatesRepo.findById.mockResolvedValue({ id: 't1', status: 'APPROVED' } as any);
        instancesRepo.findById.mockResolvedValue(activeInstance());
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });
    });
  });

  // ── T7 — template.provider must match the default channel's provider ──────
  // A template built for one provider (e.g. a Twilio Content SID template)
  // can't be sent through a channel of a different provider (e.g. an
  // Evolution/Baileys number) — checked at create() AND run() so a template
  // or channel edited after creation can't silently drift apart.
  describe('T7 — template×channel provider mismatch', () => {
    function baseCreateInput(overrides: Record<string, unknown> = {}) {
      return {
        name: 'C1',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        schedule: { type: 'IMMEDIATE' as const },
        timezone: 'America/Sao_Paulo',
        // C2 — finalidade obrigatória em QUALQUER provedor.
        purposeKey: 'convite_atividades',
        ...overrides,
      } as any;
    }

    function activeChannel(overrides: Record<string, unknown> = {}) {
      return {
        id: 'inst-1',
        isActive: true,
        provider: 'EVOLUTION',
        sentToday: 0,
        dailySendLimit: 500,
        sendWindowStartHour: 8,
        sendWindowEndHour: 20,
        sendWindowEnabled: true,
        ...overrides,
      } as any;
    }

    // ZC6 — gate de campanha: SÓ APPROVED entra. O gate existia só no wizard do
    // frontend, o que o tornava uma sugestão e não uma garantia. E no ZERNIO isso
    // é perigoso de um jeito que não é nos outros provedores: lá o status muda
    // SOZINHO — a Meta pausa/desabilita um template já aprovado e avisa por
    // webhook (ZC4). Uma campanha AGENDADA em cima dele dispararia depois da
    // mudança, tomaria rejeição em massa e derrubaria o quality rating.
    describe('gate de template APPROVED (ZC6)', () => {
      it.each(['PENDING', 'REJECTED', 'PAUSED'])(
        'create recusa template %s',
        async (status) => {
          templatesRepo.findById.mockResolvedValue({
            id: 't1',
            metaName: 'bem_vindo_mg',
            provider: 'ZERNIO',
            status,
          } as any);
          instancesRepo.findById.mockResolvedValue(
            activeChannel({ provider: 'ZERNIO' }),
          );

          const err = await service
            .create(baseCreateInput())
            .then(
              () => null,
              (e: unknown) => e,
            );

          expect(err).toBeInstanceOf(CampaignTemplateNotApprovedError);
          expect((err as CampaignTemplateNotApprovedError).code).toBe(
            'campaign.template_not_approved',
          );
          expect(repo.create).not.toHaveBeenCalled();
        },
      );

      it('create aceita template APPROVED', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'bem_vindo_mg',
          provider: 'ZERNIO',
          status: 'APPROVED',
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });

      // O ponto que a checagem de criação NÃO cobre: entre criar e disparar, a
      // Meta pode pausar o template. O guard do DISPARO é o autoritativo.
      it('run recusa um template que foi PAUSADO depois da criação', async () => {
        repo.findById.mockResolvedValue({
          id: 'camp1',
          status: 'DRAFT',
          templateId: 't1',
          defaultInstanceId: 'i1',
          filters: { combinator: 'and', rules: [] },
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'bem_vindo_mg',
          provider: 'ZERNIO',
          status: 'PAUSED',
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );

        const err = await service.run('camp1').then(
          () => null,
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(CampaignTemplateNotApprovedError);
      });
    });

    /**
     * ★ O GATE DO RÓTULO — a última porta antes dos 13.400.
     *
     * O Zernio não transporta payload de quick_reply: o clique chega como o
     * RÓTULO, e o reconhecimento é uma lista fechada. Um template de opt-in
     * criado no painel do Zernio com o botão "Bora, quero!" é aprovado pela Meta,
     * importado pelo sync como row normal e — sem este gate — selecionável na
     * campanha: cada clique no "sim" cairia no lixo, sem um único erro no log.
     */
    describe('gate dos botões de consentimento (ZERNIO)', () => {
      const buttons = (labels: string[]) => [
        { type: 'BODY', text: 'Olá' },
        {
          type: 'BUTTONS',
          buttons: labels.map((text) => ({ type: 'QUICK_REPLY', text })),
        },
      ];

      it('★ recusa um template APROVADO cujos botões o sistema não sabe ler', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'reapresentacao_optin',
          provider: 'ZERNIO',
          status: 'APPROVED',
          components: buttons(['Bora, quero!', 'Agora não']),
          consentButtonRoles: null,
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );

        const err = await service.create(baseCreateInput()).then(
          () => null,
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(CampaignTemplateConsentButtonsError);
        expect((err as CampaignTemplateConsentButtonsError).code).toBe(
          'campaign.template_consent_buttons_unrecognized',
        );
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('aceita o par canônico do opt-in (rótulos reconhecidos + papéis declarados)', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'reapresentacao_optin',
          provider: 'ZERNIO',
          status: 'APPROVED',
          components: buttons(['Sim, quero receber', 'Não quero receber']),
          consentButtonRoles: [
            { text: 'Sim, quero receber', role: 'OPT_IN' },
            { text: 'Não quero receber', role: 'OPT_OUT' },
          ],
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });

      it('aceita botões comuns DEPOIS que o operador declarou que não são consentimento', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'convite',
          provider: 'ZERNIO',
          status: 'APPROVED',
          components: buttons(['Ver proposta', 'Falar com a equipe']),
          consentButtonRoles: [
            { text: 'Ver proposta', role: 'NONE' },
            { text: 'Falar com a equipe', role: 'NONE' },
          ],
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });

      it('template ZERNIO sem botões não é afetado (o caso comum)', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'bem_vindo_mg',
          provider: 'ZERNIO',
          status: 'APPROVED',
          components: [{ type: 'BODY', text: 'Olá' }],
          consentButtonRoles: null,
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });

      it('o DISPARO também recusa — o template pode ter sido reescrito depois da criação', async () => {
        repo.findById.mockResolvedValue({
          id: 'camp1',
          status: 'DRAFT',
          templateId: 't1',
          defaultInstanceId: 'i1',
          filters: { combinator: 'and', rules: [] },
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'reapresentacao_optin',
          provider: 'ZERNIO',
          status: 'APPROVED',
          components: buttons(['Bora, quero!', 'Agora não']),
          consentButtonRoles: null,
        } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'ZERNIO' }),
        );

        const err = await service.run('camp1').then(
          () => null,
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(CampaignTemplateConsentButtonsError);
      });

      it('não morde em EVOLUTION/TWILIO — lá o clique volta com o id que nós escolhemos', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          metaName: 'convite',
          provider: 'EVOLUTION',
          status: 'APPROVED',
          components: buttons(['Bora, quero!']),
          consentButtonRoles: null,
        } as any);
        instancesRepo.findById.mockResolvedValue(activeChannel());
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });
    });

    describe('create', () => {
      it('throws CampaignTemplateProviderMismatchError (PT-BR) when providers differ', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'EVOLUTION' }),
        );

        const err = await service
          .create(baseCreateInput())
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(CampaignTemplateProviderMismatchError);
        expect((err as CampaignTemplateProviderMismatchError).code).toBe(
          'campaign.template_provider_mismatch',
        );
        expect((err as CampaignTemplateProviderMismatchError).message).toMatch(
          /provedor/i,
        );
        expect(repo.create).not.toHaveBeenCalled();
      });

      it('succeeds when template.provider === channel.provider (TWILIO/TWILIO)', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'TWILIO' }),
        );
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        // C1b — canal oficial exige finalidade declarada.
        await service.create(baseCreateInput({ purposeKey: 'convite_atividades' }));

        expect(repo.create).toHaveBeenCalled();
      });

      it('succeeds when template.provider === channel.provider (EVOLUTION/EVOLUTION default)', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'EVOLUTION',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(activeChannel());
        repo.create.mockResolvedValue({ id: 'camp1' } as any);

        await service.create(baseCreateInput());

        expect(repo.create).toHaveBeenCalled();
      });

      it('does not throw the mismatch error when the channel is missing — falls through to the instance-deleted guard', async () => {
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(null as any);

        const err = await service
          .create(baseCreateInput())
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err).not.toBeInstanceOf(CampaignTemplateProviderMismatchError);
        expect((err as ValidationError).code).toBe('campaign.instance_deleted');
      });
    });

    describe('run', () => {
      it('throws CampaignTemplateProviderMismatchError when providers differ and never claims the DRAFT', async () => {
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'DRAFT',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(
          activeChannel({ provider: 'EVOLUTION' }),
        );

        const err = await service
          .run('c1')
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(CampaignTemplateProviderMismatchError);
        expect((err as CampaignTemplateProviderMismatchError).code).toBe(
          'campaign.template_provider_mismatch',
        );
        expect(repo.transitionToQueued).not.toHaveBeenCalled();
      });

      it('succeeds when template.provider === channel.provider', async () => {
        repo.findById.mockResolvedValue({
          id: 'c2',
          status: 'DRAFT',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'EVOLUTION',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue(activeChannel());
        wireRecipientPages([]);
        repo.transitionToQueued.mockResolvedValue(1);

        const result = await service.run('c2');

        expect(result).toEqual({ queued: 0 });
        expect(repo.transitionToQueued).toHaveBeenCalled();
      });

      it('does not throw the mismatch error when the template or channel row is missing', async () => {
        repo.findById.mockResolvedValue({
          id: 'c3',
          status: 'DRAFT',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        templatesRepo.findById.mockResolvedValue(null);
        instancesRepo.findById.mockResolvedValue(activeChannel());
        wireRecipientPages([]);
        repo.transitionToQueued.mockResolvedValue(1);

        const result = await service.run('c3');

        expect(result).toEqual({ queued: 0 });
      });
    });
  });

  describe('runScheduled', () => {
    it('returns { queued: 0 } early when schedule disabled', async () => {
      repo.findById.mockResolvedValue({
        id: 'sc1',
        scheduleEnabled: false,
      } as any);
      const result = await service.runScheduled('sc1');
      expect(result).toEqual({ queued: 0 });
      expect(repo.findContactsByWhere).not.toHaveBeenCalled();
      expect(repo.markRan).not.toHaveBeenCalled();
    });

    it('returns { queued: 0 } when campaign missing', async () => {
      repo.findById.mockResolvedValue(null);
      const result = await service.runScheduled('missing');
      expect(result).toEqual({ queued: 0 });
    });

    it('dispatches contacts in chunks, computes nextRun, calls markRan, audit logs', async () => {
      repo.findById.mockResolvedValue({
        id: 'sc1',
        scheduleEnabled: true,
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: { name: { source: 'field', field: 'name' } },
        scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
        timezone: 'America/Sao_Paulo',
        runCount: 2,
      } as any);
      // Three contacts, well under DISPATCH_CHUNK_SIZE (500) — single page
      wireRecipientPages([
        { id: 'k1', name: 'A' },
        { id: 'k2', name: 'B' },
        { id: 'k3', name: 'C' },
      ]);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );
      repo.markRan.mockResolvedValue({} as any);

      const result = await service.runScheduled('sc1');

      expect(result).toEqual({ queued: 3 });
      expect(repo.createMessage).toHaveBeenCalledTimes(3);
      expect(sendQueue.add).toHaveBeenCalledTimes(3);
      expect(repo.markRan).toHaveBeenCalledTimes(1);
      const markArgs = repo.markRan.mock.calls[0];
      expect(markArgs[0]).toBe('sc1'); // id
      expect(markArgs[3]).toBe(3); // totalRecipients
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.scheduled_run',
        'Campaign',
        'sc1',
        expect.objectContaining({ recipients: 3, runCount: 3 }),
      );
    });

    /**
     * C2 — o fuso é gravado POR CAMPANHA (`Campaign.timezone`). Trocar o default
     * (America/Sao_Paulo → America/Manaus) muda apenas campanhas NOVAS: uma
     * campanha já persistida com o fuso antigo continua sendo recalculada nele,
     * senão o próximo disparo dela pularia uma hora sem ninguém pedir.
     */
    it('campanha já persistida com America/Sao_Paulo recalcula o próximo disparo NAQUELE fuso (o novo default não a reescreve)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
      try {
        repo.findById.mockResolvedValue({
          id: 'sc1',
          scheduleEnabled: true,
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'DAILY_AT', time: '09:00' },
          // Fuso ANTIGO, já no banco.
          timezone: 'America/Sao_Paulo',
          runCount: 0,
        } as any);
        wireRecipientPages([{ id: 'k1', name: 'A' }]);
        repo.createMessage.mockResolvedValue({ id: 'msg-k1' } as any);
        repo.markRan.mockResolvedValue({} as any);

        await service.runScheduled('sc1');

        const nextRunAt = repo.markRan.mock.calls[0][2] as Date;
        // São 10:00Z = 07:00 em São Paulo → o próximo 09:00 SP é hoje, 12:00Z.
        // Se o default de Manaus (UTC-4) tivesse vazado para esta campanha, o
        // mesmo "09:00" cairia às 13:00Z.
        expect(nextRunAt.toISOString()).toBe('2026-07-11T12:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    // A3 — cancel() landing in the dispatch window must NOT be undone by the
    // markRan at the end of runScheduled. We re-read the campaign right before
    // markRan; if it was cancelled mid-flight we abort markRan entirely (no
    // RUNNING flip, no schedule re-enable, no scheduled_run audit).
    it('aborts markRan when the campaign was CANCELLED during the dispatch window', async () => {
      repo.findById
        // initial read at the top of runScheduled — schedule enabled
        .mockResolvedValueOnce({
          id: 'sc1',
          status: 'RUNNING',
          scheduleEnabled: true,
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
          timezone: 'America/Sao_Paulo',
          runCount: 1,
        } as any)
        // re-read right before markRan — cancel() landed in the meantime
        .mockResolvedValueOnce({
          id: 'sc1',
          status: 'CANCELLED',
          scheduleEnabled: false,
        } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

      await service.runScheduled('sc1');

      expect(repo.markRan).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalledWith(
        'campaign.scheduled_run',
        'Campaign',
        'sc1',
        expect.anything(),
      );
    });

    // Belt-and-braces: even if the re-read missed the cancel (TOCTOU between
    // re-read and markRan), the conditional markRan returns 0 and we must not
    // emit the scheduled_run audit as if it ran.
    it('does not emit scheduled_run audit when markRan reports 0 rows updated', async () => {
      repo.findById.mockResolvedValue({
        id: 'sc1',
        status: 'RUNNING',
        scheduleEnabled: true,
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
        timezone: 'America/Sao_Paulo',
        runCount: 1,
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);
      repo.markRan.mockResolvedValue(0 as any);

      await service.runScheduled('sc1');

      expect(audit.log).not.toHaveBeenCalledWith(
        'campaign.scheduled_run',
        'Campaign',
        'sc1',
        expect.anything(),
      );
    });

    // Bug 2 — runScheduled and manual run() must be mutually exclusive so they
    // can't both dispatch the same (DRAFT scheduled) campaign. runScheduled
    // takes the shared per-campaign 'resend' lock; if a concurrent run()/
    // redispatch already holds it, the scheduler tick skips this dispatch
    // rather than double-sending the whole audience.
    it('skips dispatch when the per-campaign resend lock is already held (no double-send with run())', async () => {
      redis.set.mockResolvedValue(null); // lock held by a concurrent run()
      repo.findById.mockResolvedValue({
        id: 'sc1',
        status: 'DRAFT',
        scheduleEnabled: true,
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        scheduleConfig: { type: 'ONCE_AT', runAt: '2999-01-01T00:00:00Z' },
        timezone: 'America/Sao_Paulo',
        runCount: 0,
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

      const result = await service.runScheduled('sc1');

      expect(result).toEqual({ queued: 0 });
      expect(repo.createMessage).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
      expect(repo.markRan).not.toHaveBeenCalled();
    });

    it('acquires the shared resend lock before dispatching (mutual exclusion with run())', async () => {
      repo.findById.mockResolvedValue({
        id: 'sc1',
        status: 'RUNNING',
        scheduleEnabled: true,
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
        timezone: 'America/Sao_Paulo',
        runCount: 1,
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);
      repo.markRan.mockResolvedValue(1 as any);

      await service.runScheduled('sc1');

      expect(redis.set).toHaveBeenCalledWith(
        'campaign:lock:resend:sc1',
        expect.any(String),
        'PX',
        expect.any(Number),
        'NX',
      );
    });

    // T7 (post-review fix) — runScheduledLocked() funnels through
    // dispatchAudience() same as run()/redispatchCampaign(), so a template
    // edited (or a channel reassigned) after the campaign was created must be
    // caught on every scheduler tick, not just at create()/run() time.
    describe('T7 — template×channel provider mismatch', () => {
      it('throws CampaignTemplateProviderMismatchError and queues/markRan nothing', async () => {
        repo.findById.mockResolvedValue({
          id: 'sc1',
          scheduleEnabled: true,
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
          timezone: 'America/Sao_Paulo',
          runCount: 2,
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue({
          id: 'inst-1',
          isActive: true,
          provider: 'EVOLUTION',
          sentToday: 0,
          dailySendLimit: 500,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sendWindowEnabled: true,
        } as any);
        wireRecipientPages([{ id: 'k1' }]);

        const err = await service
          .runScheduled('sc1')
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(CampaignTemplateProviderMismatchError);
        expect((err as CampaignTemplateProviderMismatchError).code).toBe(
          'campaign.template_provider_mismatch',
        );
        expect(repo.createMessage).not.toHaveBeenCalled();
        expect(sendQueue.add).not.toHaveBeenCalled();
        expect(repo.markRan).not.toHaveBeenCalled();
      });

      it('succeeds (dispatches normally) when template.provider === channel.provider', async () => {
        repo.findById.mockResolvedValue({
          id: 'sc1',
          scheduleEnabled: true,
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
          timezone: 'America/Sao_Paulo',
          runCount: 2,
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'EVOLUTION',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue({
          id: 'inst-1',
          isActive: true,
          provider: 'EVOLUTION',
          sentToday: 0,
          dailySendLimit: 500,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sendWindowEnabled: true,
        } as any);
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);
        repo.markRan.mockResolvedValue(1 as any);

        const result = await service.runScheduled('sc1');

        expect(result).toEqual({ queued: 1 });
        expect(repo.markRan).toHaveBeenCalledTimes(1);
      });
    });

    // FASE 0 §0.3 — o tick recorrente (DAILY_AT/WEEKLY/INTERVAL) é o ponto mais
    // delicado do plano: antes ele materializava a audiência INTEIRA a cada
    // execução, reenviando para quem já tinha recebido. Agora usa
    // resolveAudience(campaign, 'unreached') — o mesmo recorte do "Disparar
    // novamente": exclui só quem RECEBEU (SENT/DELIVERED/READ), e os pulados
    // pelo gate VOLTAM a ser avaliados a cada tick.
    describe('§0.3 — tick recorrente (unreached) não reenvia quem já recebeu', () => {
      it('tick recorrente (DAILY_AT) NÃO reenfileira quem já recebeu, mas alcança contato novo', async () => {
        repo.findById.mockResolvedValue({
          id: 'sc-daily',
          scheduleEnabled: true,
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'DAILY_AT', time: '09:00' },
          timezone: 'America/Sao_Paulo',
          runCount: 5,
        } as any);
        // Contato A já tem Message SENT nesta campanha — a query real (o
        // `where` abaixo) o excluiria; o mock simula isso devolvendo só o
        // contato B, que é novo (nunca recebeu).
        wireRecipientPages([{ id: 'contactB' }]);
        repo.createMessage.mockResolvedValue({ id: 'msg-b' } as any);
        repo.markRan.mockResolvedValue({} as any);

        const result = await service.runScheduled('sc-daily');

        // Alcançou o contato novo.
        expect(result).toEqual({ queued: 1 });
        expect(repo.createMessage).toHaveBeenCalledWith(
          expect.objectContaining({ contactId: 'contactB' }),
        );

        // E o `where` que paginou a audiência é o recorte UNREACHED: exclui só
        // quem RECEBEU de fato (SENT/DELIVERED/READ, OUTBOUND) — não o recorte
        // de "tratado" (11 status, que inclui os pulados pelo gate). Os
        // pulados pelo gate VOLTAM a ser elegíveis a cada tick.
        const where = repo.findContactsPage.mock.calls[0][0] as {
          AND: Array<Record<string, any>>;
        };
        const none = where.AND.find((c) => c.messages);
        expect(none?.messages.none).toEqual({
          campaignId: 'sc-daily',
          direction: 'OUTBOUND',
          status: {
            in: [
              'SENT',
              'DELIVERED',
              'READ',
              'QUEUED',
              'SENDING',
              'WAITING_INSTANCE',
            ],
          },
        });
      });

      /**
       * C1/C4 — O DEFEITO MAIS GRAVE DA AUDITORIA.
       *
       * Campanha recorrente de 13.000 eleitores: o tick das 10:00 cria 13.000
       * linhas QUEUED, o worker drena algumas centenas por hora (pacing +
       * teto de 24h do tier), e às 11:00 o tick seguinte encontra ~12.500
       * contatos ainda QUEUED. Com o recorte 'unreached' (que só exclui
       * SENT/DELIVERED/READ) esses 12.500 voltam para a audiência e ganham uma
       * SEGUNDA linha: propaganda eleitoral entregue duas vezes à mesma pessoa.
       */
      it('tick NÃO reenfileira quem ainda está EM VOO (QUEUED/SENDING/WAITING_INSTANCE) do tick anterior', async () => {
        repo.findById.mockResolvedValue({
          id: 'sc-daily',
          scheduleEnabled: true,
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          scheduleConfig: { type: 'INTERVAL', everyMinutes: 60 },
          timezone: 'America/Sao_Paulo',
          runCount: 1,
        } as any);
        wireRecipientPages([]);
        repo.markRan.mockResolvedValue({} as any);

        await service.runScheduled('sc-daily');

        const where = repo.findContactsPage.mock.calls[0][0] as {
          AND: Array<Record<string, any>>;
        };
        const statuses = where.AND.find((c) => c.messages)?.messages.none
          .status.in as string[];
        // O que o defeito deixava passar:
        expect(statuses).toContain('QUEUED');
        expect(statuses).toContain('SENDING');
        expect(statuses).toContain('WAITING_INSTANCE');
        // E o que a Fase 0 exige que continue voltando a cada tick:
        expect(statuses).not.toContain('SKIPPED_NO_CONSENT');
        expect(statuses).not.toContain('SKIPPED_SUPPRESSED');
      });
    });
  });

  describe('dynamic recipient resolution (segmentId)', () => {
    it('resolveRecipientFilters returns campaign.filters when segmentId is null', async () => {
      const inlineFilters = {
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
      };
      const filters = await service.resolveRecipientFilters({
        segmentId: null,
        filters: inlineFilters,
      } as any);
      expect(filters).toEqual(inlineFilters);
      expect(segmentsRepo.findById).not.toHaveBeenCalled();
    });

    it('resolveRecipientFilters re-reads the segment CURRENT filters when segmentId set', async () => {
      const segmentFilters = {
        combinator: 'or',
        rules: [{ field: 'tags', op: 'contains', value: 'vip' }],
      };
      segmentsRepo.findById.mockResolvedValue({
        id: 'seg-1',
        filters: segmentFilters,
      } as any);
      const filters = await service.resolveRecipientFilters({
        segmentId: 'seg-1',
        // stale snapshot on the campaign should be ignored in favour of the
        // segment's live filters
        filters: { combinator: 'and', rules: [] },
      } as any);
      expect(segmentsRepo.findById).toHaveBeenCalledWith('seg-1');
      expect(filters).toEqual(segmentFilters);
    });

    it('falls back to campaign.filters if the segment was deleted', async () => {
      segmentsRepo.findById.mockResolvedValue(null);
      const inline = { combinator: 'and', rules: [] };
      const filters = await service.resolveRecipientFilters({
        segmentId: 'gone',
        filters: inline,
      } as any);
      expect(filters).toEqual(inline);
    });

    // ── Médio: stored filter re-validation on dispatch ──────────────────────
    // The campaign/segment `filters` column is JSON read back with a bare `as`
    // cast. A row written before the op/value constraints existed (or by a
    // future bug) could carry e.g. { op:'in', value:'x' } which becomes an
    // invalid Prisma where and 500s the worker run. resolveRecipientFilters
    // must re-parse with filterGroupSchema and reject malformed stored filters.
    it('resolveRecipientFilters rejects a malformed stored inline filter', async () => {
      await expect(
        service.resolveRecipientFilters({
          segmentId: null,
          // op 'in' with a scalar value is invalid (must be an array)
          filters: {
            combinator: 'and',
            rules: [{ field: 'city', op: 'in', value: 'Manaus' }],
          },
        } as any),
      ).rejects.toThrow(ValidationError);
    });

    it('resolveRecipientFilters rejects a malformed stored SEGMENT filter', async () => {
      segmentsRepo.findById.mockResolvedValue({
        id: 'seg-bad',
        filters: {
          combinator: 'and',
          rules: [{ field: 'whatsappValid', op: 'contains', value: 'x' }],
        },
      } as any);
      await expect(
        service.resolveRecipientFilters({
          segmentId: 'seg-bad',
          filters: { combinator: 'and', rules: [] },
        } as any),
      ).rejects.toThrow(ValidationError);
    });

    it('resolveRecipientFilters returns a structurally-validated FilterGroup for a good stored filter', async () => {
      const good = {
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
      };
      const filters = await service.resolveRecipientFilters({
        segmentId: null,
        filters: good,
      } as any);
      expect(filters).toEqual(good);
    });

    it('runScheduled with segmentId resolves recipients from the segment members', async () => {
      const segmentFilters = {
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Belém' }],
      };
      repo.findById.mockResolvedValue({
        id: 'bc1',
        scheduleEnabled: true,
        segmentId: 'seg-9',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        scheduleConfig: { type: 'DAILY_AT', time: '09:00' },
        timezone: 'America/Sao_Paulo',
        runCount: 0,
      } as any);
      segmentsRepo.findById.mockResolvedValue({
        id: 'seg-9',
        filters: segmentFilters,
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);
      repo.markRan.mockResolvedValue({} as any);

      await service.runScheduled('bc1');

      // The segment was consulted and its (opt-out-guarded) filters drove the
      // keyset page read.
      expect(segmentsRepo.findById).toHaveBeenCalledWith('seg-9');
      // FASE 0 §0.3 — o tick recorrente agora resolve 'unreached-idle': o
      // `where` não é mais a audiência crua, é a audiência ENVOLVIDA pela
      // exclusão de quem já recebeu OU está EM VOO (C1/C4). O teste casava o
      // `where` completo contra a audiência sem essa cláusula — precisa
      // esperar a cláusula `messages:{none:...}` também, não afrouxar para um
      // match parcial.
      const where = repo.findContactsPage.mock.calls[0][0];
      expect(where).toEqual({
        AND: [
          { AND: [{ city: 'Belém' }] },
          {
            messages: {
              none: {
                campaignId: 'bc1',
                direction: 'OUTBOUND',
                status: {
                  in: [
                    'SENT',
                    'DELIVERED',
                    'READ',
                    'QUEUED',
                    'SENDING',
                    'WAITING_INSTANCE',
                  ],
                },
              },
            },
          },
          {
            messages: {
              none: {
                campaignId: 'bc1',
                direction: 'OUTBOUND',
                status: 'FAILED',
                errorCode: { in: INDETERMINATE_DELIVERY_CODES },
              },
            },
          },
        ],
      });
    });
  });

  describe('redispatchCampaign', () => {
    it('throws CampaignNotFoundError when campaign missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.redispatchCampaign('missing')).rejects.toThrow(
        CampaignNotFoundError,
      );
    });

    it('rejects DRAFT campaigns with CampaignAlreadyDispatchedError', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'DRAFT',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      await expect(service.redispatchCampaign('c1')).rejects.toThrow(
        CampaignAlreadyDispatchedError,
      );
    });

    it('creates new messages, transitions to RUNNING when terminal, audit logs', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: { name: { source: 'field', field: 'name' } },
      } as any);
      wireRecipientPages([
        { id: 'k1', name: 'A' },
        { id: 'k2', name: 'B' },
      ]);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );

      const result = await service.redispatchCampaign('c1');

      expect(result).toEqual({ queued: 2, skippedAlreadyLive: 0 });
      expect(repo.createMessage).toHaveBeenCalledTimes(2);
      expect(sendQueue.add).toHaveBeenCalledTimes(2);
      expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.redispatch',
        'Campaign',
        'c1',
        { recipients: 2, skippedAlreadyLive: 0 },
      );
    });

    it('sets RUNNING whenever a batch was queued (idempotent; avoids a stale-status race)', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'msg' } as any);

      await service.redispatchCampaign('c1');

      // queued > 0 → set RUNNING (a no-op when already RUNNING, but it closes the
      // race where the first batch COMPLETED between the pre-lock read and here).
      expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
    });

    it('I10 — refuses to redispatch while a previous batch is still in flight', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      // 42 messages still QUEUED/SENDING/WAITING_INSTANCE from the first batch.
      repo.countInFlight.mockResolvedValue(42);

      await expect(service.redispatchCampaign('c1')).rejects.toThrow(
        CampaignOperationInProgressError,
      );
      // No second batch created.
      expect(repo.createMessage).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    // T7 (post-review fix) — redispatchCampaign() ("Disparar novamente")
    // funnels through dispatchAudience() same as run()/runScheduledLocked(),
    // so a template/channel that drifted apart since the original run must
    // block a fresh batch instead of silently sending mismatched content.
    describe('T7 — template×channel provider mismatch', () => {
      it('throws CampaignTemplateProviderMismatchError and creates no new batch', async () => {
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'RUNNING',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'TWILIO',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue({
          id: 'inst-1',
          isActive: true,
          provider: 'EVOLUTION',
          sentToday: 0,
          dailySendLimit: 500,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sendWindowEnabled: true,
        } as any);
        // Há gente a alcançar — o teste é sobre o mismatch template×canal, não
        // sobre CampaignNoPendingRecipientsError (T7 continua valendo com o
        // pre-check de audiência do §0.2 na frente).
        wireRecipientPages([{ id: 'k1' }]);

        const err = await service
          .redispatchCampaign('c1')
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(CampaignTemplateProviderMismatchError);
        expect((err as CampaignTemplateProviderMismatchError).code).toBe(
          'campaign.template_provider_mismatch',
        );
        expect(repo.createMessage).not.toHaveBeenCalled();
        expect(sendQueue.add).not.toHaveBeenCalled();
        expect(repo.updateStatus).not.toHaveBeenCalled();
      });

      it('succeeds (redispatches normally) when template.provider === channel.provider', async () => {
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'COMPLETED',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        templatesRepo.findById.mockResolvedValue({
          id: 't1',
          provider: 'EVOLUTION',
          status: 'APPROVED',
                } as any);
        instancesRepo.findById.mockResolvedValue({
          id: 'inst-1',
          isActive: true,
          provider: 'EVOLUTION',
          sentToday: 0,
          dailySendLimit: 500,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sendWindowEnabled: true,
        } as any);
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

        const result = await service.redispatchCampaign('c1');

        expect(result).toEqual({ queued: 1, skippedAlreadyLive: 0 });
        expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
      });
    });

    // Fase 0 §0.2 — "Disparar novamente" default é UNREACHED, não a audiência
    // inteira: reenviar a quem já recebeu (SENT/DELIVERED/READ) era o bug que a
    // revisão pegou. `resendToAll:true` é a única porta para a audiência cheia.
    describe('§0.2 — unreached default × resendToAll', () => {
      beforeEach(() => {
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'RUNNING',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
      });

      it('redispatch default (unreached) NÃO reenvia a quem recebeu, mas reavalia os pulados', async () => {
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

        await service.redispatchCampaign('c1'); // resendToAll ausente

        const where = repo.findContactsPage.mock.calls[0][0] as {
          AND: Array<Record<string, any>>;
        };
        const none = where.AND.find((c) => c.messages);
        expect(none?.messages.none.status).toEqual({
          in: ['SENT', 'DELIVERED', 'READ'],
        });
      });

      it('redispatch resendToAll=true reabre a audiência inteira (sem cláusula de Message)', async () => {
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

        await service.redispatchCampaign('c1', true);

        const where = repo.findContactsPage.mock.calls[0][0];
        expect(JSON.stringify(where)).not.toContain('messages');
      });

      /**
       * ★ A TRAVA DE BANCO (auditoria 2026-08-19, item 7). O modo `full` era o
       * único caminho que criava DE PROPÓSITO uma segunda linha para o mesmo
       * par (campanha, contato) — e é justamente essa segunda linha que o
       * índice único parcial passa a proibir. O botão continua fazendo o que
       * promete ao operador (mandar de novo para todos), mas RESSUSCITANDO a
       * linha existente.
       */
      it('resendToAll=true manda RESSUSCITAR a linha existente, em vez de criar uma segunda', async () => {
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

        await service.redispatchCampaign('c1', true);

        expect(repo.createMessage).toHaveBeenCalledWith(
          expect.objectContaining({ contactId: 'k1', resendReached: true }),
        );
      });

      it('o disparo NORMAL não ressuscita nada (só o botão "para TODOS" reenvia a quem recebeu)', async () => {
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

        await service.redispatchCampaign('c1');

        expect(repo.createMessage).toHaveBeenCalledWith(
          expect.not.objectContaining({ resendReached: true }),
        );
      });

      /**
       * Quando a trava do banco (ou a leitura que a antecede) diz "já existe
       * linha viva para este contato", `createMessage` devolve `null`: não há
       * mensagem para enfileirar, e enfileirar assim mesmo publicaria um job
       * apontando para lugar nenhum.
       */
      it('createMessage devolvendo null não enfileira job nem conta como enviada', async () => {
        wireRecipientPages([{ id: 'k1' }]);
        repo.createMessage.mockResolvedValue(null as any);

        const r = await service.redispatchCampaign('c1');

        expect(sendQueue.add).not.toHaveBeenCalled();
        expect(r).toEqual({ queued: 0, skippedAlreadyLive: 1 });
      });

      it('redispatch sem ninguém a alcançar lança, não conclui a campanha', async () => {
        repo.countContactsByWhere.mockResolvedValue(0);

        await expect(service.redispatchCampaign('c1')).rejects.toBeInstanceOf(
          CampaignNoPendingRecipientsError,
        );
        // Erro de operador, não conclusão silenciosa: maybeCompleteCampaign não
        // deve ser chamado a partir daqui (não há updateStatus para COMPLETED).
        expect(repo.updateStatus).not.toHaveBeenCalled();
      });
    });

    // Review Task 3 — o mesmo GATE SILENCIOSO que run()/runScheduledLocked()/
    // sendBatch() já tratam, reaberto aqui: o pré-check de `count===0` (linha
    // acima) só cobre "audiência vazia". Com `count>0` mas o gate de
    // consentimento recusando TODA a página (SKIPPED_NO_CONSENT/SUPPRESSED, que
    // não passam pela fila BullMQ), `queued` volta 0 e — sem isto — a campanha
    // ficava presa em RUNNING para sempre, porque nenhum worker roda para
    // fechá-la.
    describe('gate silencioso — audiência não-vazia mas 100% barrada pelo gate', () => {
      it('queued=0 com count>0 CONCLUI a campanha via maybeCompleteCampaign (não fica RUNNING para sempre)', async () => {
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'RUNNING',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
          purposeKey: 'campanha_apoio',
        } as any);
        // Audiência NÃO vazia — o pré-check `count===0 → throw` não dispara.
        wireRecipientPages([
          { id: 'k1', phoneE164: '+5592991110001' },
          { id: 'k2', phoneE164: '+5592991110002' },
        ]);
        // O gate recusa 100% da página: ninguém tem consentimento ativo para a
        // finalidade — todo mundo vira SKIPPED_NO_CONSENT, `queued` fica 0.
        consent.grantedContactIds.mockResolvedValue(new Set());
        repo.countBatches.mockResolvedValue(0);
        repo.groupMessagesByStatus.mockResolvedValue([
          { status: 'SKIPPED_NO_CONSENT', _count: 2 } as any,
        ]);

        const result = await service.redispatchCampaign('c1');

        expect(result).toEqual({ queued: 0, skippedAlreadyLive: 0 });
        expect(sendQueue.add).not.toHaveBeenCalled();
        // O bug reaberto: NÃO pode ficar "Em execução" com nada em voo.
        expect(repo.updateStatus).not.toHaveBeenCalledWith('c1', 'RUNNING');
        expect(repo.updateStatus).toHaveBeenCalledWith(
          'c1',
          'COMPLETED',
          expect.objectContaining({ finishedAt: expect.any(Date) }),
        );
        expect(audit.log).toHaveBeenCalledWith(
          'campaign.completed',
          'Campaign',
          'c1',
          expect.objectContaining({ totalSucceeded: 0, skippedNoConsent: 2 }),
        );
      });
    });
  });

    /**
   * ★ 2ª rodada — "0 ENVIADAS" TEM DE DIZER POR QUÊ.
   *
   * Quando a trava de banco recusa uma linha, o contato não era contado nem em
   * `queued` nem em `skipped`: virava um contador privado que só existia num
   * `logger.warn` do servidor. O operador clicava em "Disparar novamente para
   * TODOS" com um lote ainda drenando, via "0 enviadas" e não tinha COMO saber
   * por quê — é a mesma doença que este pacote consertou no botão "Reenviar
   * falhas" (o número tem de dizer o que o clique fez).
   */
  describe('o número que a tela recebe explica o que a trava recusou', () => {
    it('redispatchCampaign devolve quantos contatos já tinham mensagem viva', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }, { id: 'k2' }]);
      // As duas linhas já estão vivas: a trava recusa as duas.
      repo.createMessage.mockResolvedValue(null as any);

      const r = await service.redispatchCampaign('c1', true);

      expect(r).toEqual(
        expect.objectContaining({ queued: 0, skippedAlreadyLive: 2 }),
      );
    });
  });

describe('redispatchMessage', () => {
    it('throws MessageNotFoundError when original missing', async () => {
      repo.findMessageById.mockResolvedValue(null);
      await expect(service.redispatchMessage('missing')).rejects.toThrow(
        MessageNotFoundError,
      );
    });

    /**
     * O BUG "3 DE 2".
     *
     * "Disparar novamente" no card de UMA mensagem criava uma linha Message NOVA
     * em vez de reaproveitar a existente. Em produção: campanha com 2
     * destinatários e 3 pulados — barra de distribuição em 150%.
     *
     * A mecânica: o denominador (`totalRecipients`) conta CONTATOS; o numerador
     * (pulados) conta LINHAS DE MENSAGEM. Um contato já pulado ganhava uma 2ª
     * linha QUEUED, o worker reavaliava o gate e a virava SKIPPED_NO_CONSENT de
     * novo → 3 linhas puladas para 2 contatos.
     *
     * A raiz: o operador clicou "disparar novamente" NAQUELA mensagem. É AQUELA
     * mensagem que tem de ser redisparada — não uma cópia dela. Reaproveitar a
     * linha mantém a invariante "uma linha por contato por campanha", que é o que
     * impede pulados (mensagens) e destinatários (contatos) de divergirem.
     */
    it('REAPROVEITA a linha existente — não cria uma segunda para o mesmo contato', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'SKIPPED_NO_CONSENT',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: { name: { source: 'literal', value: 'Bob' } },
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1', name: 'X' } as any);

      const result = await service.redispatchMessage('orig');

      // NENHUMA linha nova. É a linha clicada que volta para a fila.
      expect(repo.createMessage).not.toHaveBeenCalled();
      expect(repo.resetForRedispatch).toHaveBeenCalledWith('orig', {
        instanceId: 'inst-1',
        variables: { name: 'Bob' },
      });
      expect(result).toEqual({ queued: 1, messageId: 'orig' });
      expect(sendQueue.add).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        'message.redispatch',
        'Message',
        'orig',
        expect.objectContaining({ campaignId: 'c1', contactId: 'k1' }),
      );
    });

    /**
     * A invariante, dita como número: redisparar N vezes o mesmo contato não pode
     * fazer a contagem de mensagens da campanha crescer. Era exatamente esse
     * crescimento que produzia "3 de 2".
     */
    it('redisparar 3x o mesmo contato não cria 3 linhas (pulados não podem passar de destinatários)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'SKIPPED_NO_CONSENT',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1', name: 'X' } as any);

      await service.redispatchMessage('orig');
      await service.redispatchMessage('orig');
      await service.redispatchMessage('orig');

      expect(repo.createMessage).not.toHaveBeenCalled();
      expect(repo.resetForRedispatch).toHaveBeenCalledTimes(3);
    });

    it('throws CampaignNotFoundError when parent campaign missing', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c-gone',
        contactId: 'k1',
      } as any);
      repo.findById.mockResolvedValue(null);
      await expect(service.redispatchMessage('orig')).rejects.toThrow(
        CampaignNotFoundError,
      );
    });

    it('reopens terminal campaigns to RUNNING', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.createMessage.mockResolvedValue({ id: 'msg-new' } as any);

      await service.redispatchMessage('orig');

      expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
    });

    it('serializes concurrent invocations — um duplo-clique enfileira UMA vez só', async () => {
      // A4 — sem o lock de resend, os dois cliques enfileirariam → o contato
      // receberia a mensagem duas vezes. (Agora que o redisparo REAPROVEITA a
      // linha, o clone deixou de ser o risco; o envio duplicado continua sendo,
      // e é o lock que o barra.)
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      // Real-ish lock: first SET NX wins ('OK'), second loses (null).
      redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      const [a, b] = await Promise.allSettled([
        service.redispatchMessage('orig'),
        service.redispatchMessage('orig'),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      const rejected = [a, b].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        CampaignOperationInProgressError,
      );
      expect(repo.resetForRedispatch).toHaveBeenCalledTimes(1);
      expect(repo.createMessage).not.toHaveBeenCalled();
    });

    /**
     * C12 (auditoria 2026-08-19) — O REDISPARO RESSUSCITAVA UMA LINHA EM VOO.
     *
     * O worker faz claimForSend (QUEUED→SENDING) e entra no `wa.send`, janela
     * que dura minutos no broadcast do Zernio. A UI renderiza o botão
     * "Disparar novamente" para QUALQUER status. `resetForRedispatch` fazia um
     * `update` incondicional para QUEUED — a linha voltava a ser reivindicável,
     * um segundo worker a reivindicava e enviava, e o primeiro concluía o envio
     * dele: DUAS entregas a partir de UMA linha, que é exatamente o que o claim
     * atômico deveria impedir.
     */
    it.each(['SENDING', 'QUEUED', 'WAITING_INSTANCE'])(
      'recusa o redisparo de uma linha EM VOO (%s) — o worker pode estar enviando agora',
      async (status) => {
        repo.findMessageById.mockResolvedValue({
          id: 'orig',
          campaignId: 'c1',
          contactId: 'k1',
          status,
        } as any);
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'RUNNING',
          defaultInstanceId: 'inst-1',
          variableMap: {},
        } as any);
        repo.findContactById.mockResolvedValue({ id: 'k1' } as any);

        await expect(service.redispatchMessage('orig')).rejects.toThrow(
          MessageNotRetryableError,
        );
        expect(repo.resetForRedispatch).not.toHaveBeenCalled();
        expect(sendQueue.add).not.toHaveBeenCalled();
      },
    );

    /**
     * A guarda acima sozinha é TOCTOU: entre o `findMessageById` e o
     * `resetForRedispatch` o worker pode reivindicar a linha. A escrita tem de
     * ser condicional, e o serviço tem de acreditar no count que ela devolve.
     */
    it('não enfileira nada quando a escrita condicional não pega a linha (o worker a reivindicou no meio)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'FAILED',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.resetForRedispatch.mockResolvedValue('not_redispatchable' as never);

      await expect(service.redispatchMessage('orig')).rejects.toThrow(
        MessageNotRetryableError,
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * ★ C12 (2ª rodada) — O 500 QUE O REVISOR REPRODUZIU CONTRA O BANCO.
     *
     * Cenário mais comum que existe na retomada por lotes: o lote 1 falha por
     * queda transitória do canal, o lote 2 RECRIA a linha de propósito, e o
     * contato passa a ter uma FAILED antiga ao lado de uma viva. A tabela de
     * mensagens renderiza "Disparar novamente" em TODAS as linhas; o operador
     * clica na FAILED. `resetForRedispatch` a movia para QUEUED e o índice
     * único parcial recusava com P2002 — que não é DomainError e virava
     * "An unexpected error occurred" (500) + ruído no Sentry, numa campanha
     * eleitoral rodando.
     *
     * A recusa tem de ser LIMPA e explicada: 409, com a mesma mensagem que o
     * retry unitário já dava.
     */
    it('recusa em 409 (não em 500) quando o contato já tem OUTRA linha viva na campanha', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'FAILED',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(true);

      await expect(service.redispatchMessage('orig')).rejects.toThrow(
        MessageContactAlreadyReachedError,
      );
      // Nem tenta escrever: a trava do banco não chega a ser exercitada.
      expect(repo.resetForRedispatch).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * A pergunta acima tem de EXCLUIR A PRÓPRIA LINHA. "Disparar novamente"
     * numa mensagem ENTREGUE é um caso legítimo (é o botão do reenvio
     * individual, e é a válvula do incidente do 9º dígito): ela é a única linha
     * viva do contato, e perguntar "existe irmã viva?" sem tirá-la da conta
     * responderia "sim — eu mesma".
     */
    it('redisparar uma mensagem ENTREGUE não se auto-bloqueia (a própria linha sai da pergunta)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'DELIVERED',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);

      const r = await service.redispatchMessage('orig');

      expect(repo.hasReachedOrInFlightSibling).toHaveBeenCalledWith(
        'c1',
        'k1',
        'orig',
      );
      expect(r).toEqual({ queued: 1, messageId: 'orig' });
    });

    /**
     * Segunda tranca: entre a leitura e a escrita outro ator pode criar a linha
     * viva. Aí quem recusa é o BANCO, e o serviço tem de traduzir esse P2002
     * para a mesma recusa de 409 — nunca deixá-lo subir cru.
     */
    it('P2002 no meio do caminho (TOCTOU) também vira 409, não 500', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'FAILED',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      repo.resetForRedispatch.mockResolvedValue('contact_already_live' as never);

      await expect(service.redispatchMessage('orig')).rejects.toThrow(
        MessageContactAlreadyReachedError,
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * ★ C14 — A VÁLVULA DE ESCAPE, E ELA É DELIBERADA.
     *
     * A régua nova ("campanha CANCELADA ainda bloqueia o que está SENT")
     * fechou o reenvio em massa e o retry unitário para quem já tem o mesmo
     * template numa campanha irmã. O incidente do 9º dígito (2026-08-07) prova
     * que uma linha pode ficar SENT PARA SEMPRE sem nunca chegar — e sem uma
     * saída manual essas pessoas ficariam queimadas para aquele template.
     *
     * "Disparar novamente" NESTA mensagem é essa saída: é um ato individual,
     * explícito, auditado (`message.redispatch`) e sobre uma linha que o
     * operador está olhando. Ele NÃO consulta a rede do mesmo template — e
     * isso é uma decisão, não um esquecimento. Este teste tranca a decisão.
     */
    it('NÃO consulta a rede do mesmo template — é a saída manual do operador (9º dígito)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'orig',
        campaignId: 'c1',
        contactId: 'k1',
        status: 'SENT',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        variableMap: {},
      } as any);
      repo.findContactById.mockResolvedValue({ id: 'k1' } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      // Existe uma campanha IRMÃ cancelada do mesmo template com SENT para k1.
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'c2', status: 'CANCELLED' },
      ] as any);
      repo.hasBlockingSibling.mockResolvedValue(true);

      const r = await service.redispatchMessage('orig');

      expect(r).toEqual({ queued: 1, messageId: 'orig' });
      expect(repo.hasBlockingSibling).not.toHaveBeenCalled();
      expect(sendQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryMessage', () => {
    it('throws MessageNotFoundError when message missing', async () => {
      repo.findMessageById.mockResolvedValue(null);
      await expect(service.retryMessage('missing')).rejects.toThrow(
        MessageNotFoundError,
      );
    });

    it('throws MessageNotRetryableError when status not FAILED', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'SENT',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      await expect(service.retryMessage('m1')).rejects.toThrow(
        MessageNotRetryableError,
      );
    });

    it.each([
      'twilio.indeterminate',
      'sending_stuck',
      // Fix: mesmo buraco do bulk retryFailedMessages (findFailedMessageIds) —
      // sem isto, o operador podia clicar "reenviar" nesta única mensagem e
      // duplicar uma entrega que talvez já tenha acontecido via Zernio/GoZap.
      'zernio.indeterminate',
      'gozap.indeterminate',
      // Fix: os CRUS também — linhas LEGADAS gravadas pelo
      // @OnWorkerEvent('failed') sob o comportamento antigo (guarda B3
      // exclusiva da Twilio), quando um timeout do Zernio/GoZap era
      // relançado, retentado 5x pelo BullMQ, e a linha FINAL ficava com o
      // código cru — nunca com o terminal `<provider>.indeterminate`. Sem
      // isto, o operador clicando "reenviar" numa dessas linhas legadas
      // duplicava a entrega tão facilmente quanto nas linhas novas.
      'zernio.timeout',
      'gozap.timeout',
    ])(
      'refuses to auto-retry an INDETERMINATE FAILED message (%s) — may have been delivered',
      async (errorCode) => {
        repo.findMessageById.mockResolvedValue({
          id: 'm1',
          status: 'FAILED',
          errorCode,
          campaignId: 'c1',
          contactId: 'k1',
        } as any);
        await expect(service.retryMessage('m1')).rejects.toThrow(
          MessageDeliveryIndeterminateError,
        );
        expect(repo.resetForRetry).not.toHaveBeenCalled();
      },
    );

    it('resets and enqueues a FAILED message', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);

      const result = await service.retryMessage('m1');

      expect(result).toEqual({ queued: 1 });
      expect(repo.hasReachedOrInFlightSibling).toHaveBeenCalledWith(
        'c1',
        'k1',
      );
      expect(repo.resetForRetry).toHaveBeenCalledWith('m1');
      expect(sendQueue.add).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        'message.retry',
        'Message',
        'm1',
        { campaignId: 'c1' },
      );
    });

    it('throws MessageContactAlreadyReachedError se o contato já recebeu (ou está em voo) nesta campanha', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(true);

      await expect(service.retryMessage('m1')).rejects.toThrow(
        MessageContactAlreadyReachedError,
      );
      expect(repo.resetForRetry).not.toHaveBeenCalled();
    });

    // enqueueOrFail — o catch do BullMQ.add chama markMessageEnqueueFailed,
    // que agora devolve um count (updateMany escopado a QUEUED).
    it('relança o erro de enqueue quando markMessageEnqueueFailed confirma count>0 (a linha era mesmo QUEUED)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      const enqueueErr = new Error('Redis down');
      sendQueue.add.mockRejectedValue(enqueueErr as never);
      repo.markMessageEnqueueFailed.mockResolvedValue(1);

      await expect(service.retryMessage('m1')).rejects.toBe(enqueueErr);

      expect(repo.markMessageEnqueueFailed).toHaveBeenCalledWith(
        'm1',
        'Redis down',
      );
    });

    it('NÃO relança quando markMessageEnqueueFailed devolve count 0 (a linha já foi reivindicada por outro ator)', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      const enqueueErr = new Error('Redis down');
      sendQueue.add.mockRejectedValue(enqueueErr as never);
      repo.markMessageEnqueueFailed.mockResolvedValue(0);

      // Relançar reabriria uma linha que outro ator já reivindicou — não pode.
      await expect(service.retryMessage('m1')).resolves.toEqual({
        queued: 1,
      });
    });

    /**
     * C2/N3 (auditoria 2026-08-19) — o retry de UMA mensagem só olhava a
     * PRÓPRIA campanha. A campanha B falha para o contato K; a campanha A, do
     * MESMO template, entrega o texto a K depois; o operador volta em B e
     * clica "Reenviar" — K recebe a mesma propaganda duas vezes, e a regra
     * "ninguém recebe o mesmo template duas vezes" nunca é consultada.
     */
    it('recusa o retry quando uma campanha IRMÃ do mesmo template já alcançou o contato', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'B',
        contactId: 'k1',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'B',
        templateId: 'tpl-T',
      } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      // Existe a campanha A, viva, com o MESMO template.
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'A', status: 'COMPLETED' },
      ] as never);
      repo.hasBlockingSibling.mockResolvedValue(true);

      await expect(service.retryMessage('m1')).rejects.toThrow(
        MessageContactAlreadyReachedError,
      );
      expect(repo.resetForRetry).not.toHaveBeenCalled();
      // E perguntou com o predicado da regra, para o contato certo.
      expect(repo.hasBlockingSibling).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'OUTBOUND' }),
        'k1',
      );
    });

    /**
     * ★ I8 (revisão de integração) — A RECUSA DO BANCO CHEGA COMO CONVERSA, NÃO
     * COMO 500.
     *
     * "Reenviar" era o único caminho de reenvio que não tratava o P2002 do
     * índice único parcial. A janela é real e não é teórica: as perguntas
     * passam, o clique fica preso no lock enquanto um `dispatchAudience` roda,
     * o dispatch CRIA a linha viva daquele contato e solta o lock, e só então
     * o retry escreve. Contra Postgres real isso devolve `P2002 Unique
     * constraint failed on the fields: (campaignId, contactId)` — que subia cru
     * como "An unexpected error occurred" no meio de um disparo.
     *
     * A recusa do banco tem de virar a MESMA recusa que a pergunta prévia
     * produz, para o operador ler a mesma explicação nos dois caminhos.
     */
    it('I8 — a trava de banco ("contact_already_live") vira a recusa explicada, não um 500', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      repo.hasBlockingSibling.mockResolvedValue(false);
      repo.resetForRetry.mockResolvedValue('contact_already_live' as never);

      await expect(service.retryMessage('m1')).rejects.toThrow(
        MessageContactAlreadyReachedError,
      );
      // E nada foi enfileirado: um job sobre uma linha que não voltou para a
      // fila é um job que o worker descarta em silêncio.
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * I8 — a escrita é CONDICIONAL. Se a linha deixou de estar FAILED entre a
     * leitura e a escrita (outro operador já a reenviou, ou o worker a
     * reivindicou), o reset não pega — e enfileirar assim mesmo publicaria um
     * job sobre uma linha que outro ator está tratando.
     */
    it('I8 — quando a linha deixou de estar FAILED, recusa e NÃO enfileira', async () => {
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      repo.hasBlockingSibling.mockResolvedValue(false);
      repo.resetForRetry.mockResolvedValue('not_retryable' as never);

      await expect(service.retryMessage('m1')).rejects.toThrow(
        MessageNotRetryableError,
      );
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    /**
     * ★ I8 — AS PERGUNTAS ENTRARAM PARA DENTRO DO LOCK.
     *
     * Elas ficavam FORA e a escrita sempre foi DENTRO — a janela por onde o
     * P2002 entrava. Com o disparo já bloqueado, a resposta que a pergunta dá é
     * a mesma que valerá na hora de escrever.
     */
    it('I8 — pergunta pela irmã viva DEPOIS de adquirir o lock, não antes', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.hasReachedOrInFlightSibling.mockResolvedValue(false);
      repo.hasBlockingSibling.mockResolvedValue(false);
      repo.resetForRetry.mockResolvedValue('ok' as never);

      await service.retryMessage('m1');

      const aquisicaoDoLock = redis.set.mock.invocationCallOrder[0];
      const pergunta =
        repo.hasReachedOrInFlightSibling.mock.invocationCallOrder[0];
      expect(aquisicaoDoLock).toBeLessThan(pergunta);
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ I15 (revisão de integração) — A SAÍDA EM MASSA PARA O NÚMERO BANIDO.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Cancelar uma campanha bloqueia também o que ficou em `SENT`, e a régua está
   * certa (cancelar não cancela o que já está no provedor). Mas o caminho de
   * recuperação que este cliente mais usa é o oposto: o número é banido no meio
   * do disparo, o operador CANCELA e recria em outro canal — e nos canais sem
   * polling é justamente em `SENT` que a mensagem fica presa PARA SEMPRE. Sem
   * uma saída, 13.000 pessoas ficam inalcançáveis para aquele template, e a
   * única válvula era um clique POR LINHA.
   *
   * Os dois motivos de cancelamento são indistinguíveis pelo banco e opostos na
   * consequência, então o sistema pergunta em vez de adivinhar. Estes testes
   * prendem as travas que impedem o mecanismo de virar um "mandar de novo para
   * todo mundo". O efeito ponta a ponta foi provado contra Postgres real: a
   * audiência da campanha nova saiu de 0/3 para 3/3 e a guarda do instante do
   * envio parou de bloquear.
   */
  describe('liberar as não confirmadas de uma campanha cancelada (I15)', () => {
    it('a prévia diz QUANTAS são e se a porta está aberta', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 'tpl-T',
      } as any);
      repo.countUnconfirmedSent.mockResolvedValue(13400 as never);

      await expect(service.previewUnconfirmedSent('c1')).resolves.toEqual({
        campaignId: 'c1',
        campaignStatus: 'CANCELLED',
        releasable: true,
        unconfirmedSent: 13400,
      });
    });

    /**
     * Numa campanha que NÃO está cancelada o número existe, mas a porta está
     * fechada — e dizer isso é melhor do que sumir com a informação.
     */
    it('a prévia de uma campanha viva mostra o número e diz que NÃO é liberável', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        templateId: 'tpl-T',
      } as any);
      repo.countUnconfirmedSent.mockResolvedValue(7 as never);

      const r = await service.previewUnconfirmedSent('c1');
      expect(r.releasable).toBe(false);
      expect(r.unconfirmedSent).toBe(7);
    });

    /**
     * ★ TRAVA 1 — só campanha CANCELADA. Declarar não entregues as mensagens de
     * uma campanha VIVA seria devolver à fila gente que está recebendo agora.
     * Cancelar primeiro é um ato visível, anterior e independente — e garante
     * que nada mais sai por ali enquanto a liberação roda.
     */
    it('RECUSA numa campanha que não está cancelada', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        templateId: 'tpl-T',
      } as any);

      await expect(
        service.releaseUnconfirmedSent('c1', { confirm: true }),
      ).rejects.toThrow(CampaignNotCancelledError);
      expect(repo.releaseUnconfirmedSent).not.toHaveBeenCalled();
    });

    /**
     * ★ TRAVA 2 — confirmação explícita. O operador acabou de ver o NÚMERO de
     * pessoas afetadas; este campo é o "sim, são essas". Sem ele, um POST
     * acidental desfaria o bloqueio de milhares de eleitores.
     */
    it('RECUSA sem confirmação explícita — e nada é escrito', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 'tpl-T',
      } as any);

      await expect(
        service.releaseUnconfirmedSent('c1', { confirm: false }),
      ).rejects.toThrow(CampaignReleaseNotConfirmedError);
      expect(repo.releaseUnconfirmedSent).not.toHaveBeenCalled();
    });

    it('campanha inexistente é 404, não um no-op silencioso', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.releaseUnconfirmedSent('nope', { confirm: true }),
      ).rejects.toThrow(CampaignNotFoundError);
    });

    /**
     * O número que vai para a tela e para o audit é o REAL (o que a escrita
     * pegou), não o da prévia: entre uma e outra um webhook atrasado pode ter
     * confirmado algumas, e essas ficam de fora — como devem.
     */
    it('libera, devolve o número REAL e registra a declaração no audit', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 'tpl-T',
      } as any);
      repo.countUnconfirmedSent.mockResolvedValue(13400 as never);
      // A escrita pegou MENOS que a prévia: 3 viraram DELIVERED no meio.
      repo.releaseUnconfirmedSent.mockResolvedValue(13397 as never);

      const r = await service.releaseUnconfirmedSent('c1', {
        confirm: true,
        reason: 'número banido pela Meta em 19/08',
      });

      expect(r).toEqual({ released: 13397 });
      expect(repo.releaseUnconfirmedSent).toHaveBeenCalledWith('c1');
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.release_unconfirmed_sent',
        'Campaign',
        'c1',
        expect.objectContaining({
          released: 13397,
          templateId: 'tpl-T',
          reason: 'número banido pela Meta em 19/08',
        }),
      );
    });

    /**
     * A liberação NÃO enfileira nada. Ela só devolve aquelas pessoas à condição
     * de alcançáveis; quem decide o que enviar, por qual canal e quando continua
     * sendo o operador, no fluxo normal.
     */
    it('NÃO enfileira nada — não é um botão de "mandar de novo"', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 'tpl-T',
      } as any);
      repo.releaseUnconfirmedSent.mockResolvedValue(5 as never);

      await service.releaseUnconfirmedSent('c1', { confirm: true });

      expect(sendQueue.add).not.toHaveBeenCalled();
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    /**
     * ★ TRAVA 4 — sob o MESMO lock 'resend' dos outros caminhos de reenvio, para
     * não correr contra um disparo/retomada da mesma campanha.
     */
    it('roda sob o lock da campanha (não corre contra um disparo)', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'CANCELLED',
        templateId: 'tpl-T',
      } as any);
      repo.releaseUnconfirmedSent.mockResolvedValue(1 as never);

      await service.releaseUnconfirmedSent('c1', { confirm: true });

      expect(redis.set).toHaveBeenCalledWith(
        'campaign:lock:resend:c1',
        expect.any(String),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      const aquisicao = redis.set.mock.invocationCallOrder[0];
      const escrita = repo.releaseUnconfirmedSent.mock.invocationCallOrder[0];
      expect(aquisicao).toBeLessThan(escrita);
    });
  });

  describe('retryFailedMessages', () => {
    it('throws CampaignNotFoundError when campaign missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.retryFailedMessages('missing')).rejects.toThrow(
        CampaignNotFoundError,
      );
    });

    it('returns { queued: 0 } when no failed messages, no status update', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
      } as any);
      repo.findFailedMessageIds.mockResolvedValue([] as any);
      const result = await service.retryFailedMessages('c1');
      expect(result).toEqual({ queued: 0 });
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('bulk resets + enqueues all failed messages and reopens FAILED to RUNNING', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'FAILED',
      } as any);
      repo.findFailedMessageIds.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
        { id: 'm2', contactId: 'k2' },
      ] as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);

      const result = await service.retryFailedMessages('c1');

      expect(result).toEqual({ queued: 2 });
      expect(repo.resetForRetry).toHaveBeenCalledTimes(2);
      expect(sendQueue.add).toHaveBeenCalledTimes(2);
      expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
    });

    /**
     * ★ I8 (revisão de integração) — O LOTE CONTA O QUE PEGOU, E NÃO ABORTA NO
     * MEIO.
     *
     * Antes, o P2002 da trava de banco subia cru de dentro do laço: um 500 no
     * MEIO do "Reenviar falhas" que abortava as linhas seguintes. Agora o reset
     * devolve a recusa nomeada — e o lote precisa fazer duas coisas com ela:
     * PULAR aquela linha (enfileirar um job sobre uma linha que não voltou para
     * QUEUED só produz um job que o worker descarta em silêncio) e NÃO
     * contá-la, porque o número devolvido é o que o operador lê como "quantas
     * saíram".
     */
    it('I8 — pula a linha que a trava recusou, segue com as outras e conta só as que pegaram', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'FAILED',
      } as any);
      repo.findFailedMessageIds.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
        { id: 'm2', contactId: 'k2' },
        { id: 'm3', contactId: 'k3' },
      ] as any);
      repo.resetForRetry
        .mockResolvedValueOnce('ok' as never)
        .mockResolvedValueOnce('contact_already_live' as never)
        .mockResolvedValueOnce('ok' as never);

      const result = await service.retryFailedMessages('c1');

      expect(result).toEqual({ queued: 2 });
      // As três foram tentadas — nada abortou no meio do lote.
      expect(repo.resetForRetry).toHaveBeenCalledTimes(3);
      // Mas só as duas que pegaram viraram job.
      expect(sendQueue.add).toHaveBeenCalledTimes(2);
    });

    /**
     * C2 (auditoria 2026-08-19) — "Reenviar falhas" reenfileirava toda linha
     * FAILED sem nunca consultar a regra do mesmo template. O filtro de irmã
     * que ele tinha era escopado à PRÓPRIA campanha.
     */
    it('passa o bloqueio das campanhas IRMÃS do mesmo template para a consulta de falhas', async () => {
      repo.findById.mockResolvedValue({
        id: 'B',
        status: 'FAILED',
        templateId: 'tpl-T',
      } as any);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'A', status: 'RUNNING' },
      ] as never);
      repo.findFailedMessageIds.mockResolvedValue([] as any);

      await service.retryFailedMessages('B');

      expect(repo.findFailedMessageIds).toHaveBeenCalledWith('B', {
        direction: 'OUTBOUND',
        OR: [
          {
            campaignId: { in: ['A'] },
            status: {
              in: [
                'SENT',
                'DELIVERED',
                'READ',
                'QUEUED',
                'SENDING',
                'WAITING_INSTANCE',
              ],
            },
          },
        ],
      });
    });

    it('reopens COMPLETED to RUNNING when there are failures', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'COMPLETED' } as any);
      repo.findFailedMessageIds.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
      ] as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);

      await service.retryFailedMessages('c1');

      expect(repo.updateStatus).toHaveBeenCalledWith('c1', 'RUNNING');
    });
  });

  describe('listMessages', () => {
    it('throws CampaignNotFoundError when campaign missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.listMessages('missing', { page: 1, pageSize: 10 }),
      ).rejects.toThrow(CampaignNotFoundError);
    });

    it('forwards merged args to repo.listMessages', async () => {
      repo.findById.mockResolvedValue({ id: 'c1' } as any);
      repo.listMessages.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
      } as any);

      await service.listMessages('c1', {
        page: 2,
        pageSize: 25,
        status: 'FAILED',
        search: 'Maria',
      });

      expect(repo.listMessages).toHaveBeenCalledWith({
        campaignId: 'c1',
        page: 2,
        pageSize: 25,
        status: 'FAILED',
        search: 'Maria',
      });
    });
  });

  describe('getById', () => {
    it('returns campaign + statusCounts', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', name: 'X' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SENT', _count: 3 },
      ] as any);
      repo.countUnreachedFailedContacts.mockResolvedValue(0);
      const result = await service.getById('c1');
      expect(result).toEqual({
        id: 'c1',
        name: 'X',
        statusCounts: [{ status: 'SENT', _count: 3 }],
        skippedNoConsent: 0,
        skippedSuppressed: 0,
        skippedTotal: 0,
        retryableFailedCount: 0,
      });
    });

    it('throws CampaignNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toThrow(
        CampaignNotFoundError,
      );
    });

    /**
     * F2 T8 — o botão "Reenviar falhas (N)" contava LINHAS de Message FAILED
     * (`counts.FAILED`), não CONTATOS distintos não alcançados. Uma mesma
     * pessoa com 3 tentativas FAILED nesta campanha inflava o contador em 3x
     * e o operador lia "vou reenviar para 3 pessoas" quando era 1.
     * `countUnreachedFailedContacts` (repo, Fase 0) já faz a conta certa —
     * faltava expô-la aqui.
     */
    it('expõe retryableFailedCount = countUnreachedFailedContacts(campaignId), não counts.FAILED', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', name: 'X' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        // 3 linhas FAILED, mas só 1 contato distinto ainda não alcançado.
        { status: 'FAILED', _count: 3 },
      ] as any);
      repo.countUnreachedFailedContacts.mockResolvedValue(1);

      const result = await service.getById('c1');

      expect(result.retryableFailedCount).toBe(1);
      expect(repo.countUnreachedFailedContacts).toHaveBeenCalledWith(
        'c1',
        null,
      );
    });

    /**
     * C2 — depois que o reenvio passou a respeitar a regra do mesmo template, o
     * contador do botão tem de respeitá-la também: prometer N e enviar menos é
     * a prévia mentindo.
     */
    it('desconta do contador quem já foi alcançado por uma campanha IRMÃ do mesmo template', async () => {
      repo.findById.mockResolvedValue({
        id: 'B',
        name: 'X',
        templateId: 'tpl-T',
      } as any);
      repo.groupMessagesByStatus.mockResolvedValue([] as any);
      repo.countUnreachedFailedContacts.mockResolvedValue(0);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'A', status: 'RUNNING' },
      ] as never);

      await service.getById('B');

      expect(repo.countUnreachedFailedContacts).toHaveBeenCalledWith(
        'B',
        expect.objectContaining({ direction: 'OUTBOUND' }),
      );
    });
  });

  describe('cancel — happy path', () => {
    it('cancels, drains pending jobs, cancels queued messages, audit-logs the counts', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        scheduleEnabled: true,
      } as any);
      repo.cancelAndDisableSchedule.mockResolvedValue({ id: 'c1' } as any);
      repo.cancelQueuedMessages.mockResolvedValue(3);
      sendQueue.getJobs.mockResolvedValue([
        // 2 jobs targeting c1 + 1 unrelated
        { data: { campaignId: 'c1' }, remove: vi.fn().mockResolvedValue(undefined) },
        { data: { campaignId: 'c1' }, remove: vi.fn().mockResolvedValue(undefined) },
        { data: { campaignId: 'other' }, remove: vi.fn().mockResolvedValue(undefined) },
      ] as never);

      await service.cancel('c1');

      expect(repo.cancelAndDisableSchedule).toHaveBeenCalledWith('c1');
      expect(repo.cancelQueuedMessages).toHaveBeenCalledWith('c1');
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.cancel',
        'Campaign',
        'c1',
        { wasScheduled: true, drainedJobs: 2, cancelledMessages: 3 },
      );
    });

    it('records wasScheduled=false when schedule was already disabled', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        scheduleEnabled: false,
      } as any);
      repo.cancelAndDisableSchedule.mockResolvedValue({ id: 'c1' } as any);
      repo.cancelQueuedMessages.mockResolvedValue(0);
      sendQueue.getJobs.mockResolvedValue([] as never);
      await service.cancel('c1');
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.cancel',
        'Campaign',
        'c1',
        { wasScheduled: false, drainedJobs: 0, cancelledMessages: 0 },
      );
    });
  });

  describe('maybeCompleteCampaign', () => {
    it('no-ops on terminal campaigns', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
      } as any);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('does not transition while messages remain QUEUED', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'QUEUED', _count: 2 } as any,
        { status: 'SENT', _count: 5 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('does not complete while messages are WAITING_INSTANCE (parked for an offline instance)', async () => {
      // Bug 3 — WAITING_INSTANCE rows are non-terminal (parked until their
      // routed instance reconnects). Completing the campaign while any remain
      // would mark it done though a subset of recipients was never messaged,
      // and the terminal status blocks re-completion after reconnect-replay.
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'WAITING_INSTANCE', _count: 2 } as any,
        { status: 'SENT', _count: 5 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('does not complete while a message is still SENDING (in flight)', async () => {
      // Regression: SENDING is a non-terminal in-flight state. A concurrent
      // worker's markSent must not let the campaign complete while a sibling
      // message is mid-send (it could still fail).
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SENDING', _count: 1 } as any,
        { status: 'SENT', _count: 5 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('flips RUNNING → COMPLETED when queue drained with at least one success', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SENT', _count: 4 } as any,
        { status: 'FAILED', _count: 1 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        'c1',
        'COMPLETED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.completed',
        'Campaign',
        'c1',
        expect.objectContaining({ totalSucceeded: 4 }),
      );
    });

    it('flips RUNNING → FAILED when queue drained and 100% failed', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'FAILED', _count: 3 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        'c1',
        'FAILED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
    });

    it('treats DELIVERED and READ as success too (read-receipts may be disabled)', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'DELIVERED', _count: 2 } as any,
        { status: 'READ', _count: 1 } as any,
      ]);
      await service.maybeCompleteCampaign('c1');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        'c1',
        'COMPLETED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
    });
  });

  describe('list', () => {
    it('delegates to repo.listAll', async () => {
      repo.listAll.mockResolvedValue([{ id: 'c1' }] as any);
      const result = await service.list();
      expect(result).toEqual([{ id: 'c1' }]);
    });
  });

  describe('preflight', () => {
    it('throws CampaignNotFoundError when campaign missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.preflight('missing')).rejects.toThrow(
        CampaignNotFoundError,
      );
    });

    it('returns reachability summary from repo.preflightSummary', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        filters: { combinator: 'and', rules: [] },
      } as any);
      repo.preflightSummary.mockResolvedValue({
        total: 100,
        reachable: 60,
        invalid: 15,
        unknown: 25,
      });

      const result = await service.preflight('c1');

      expect(result).toEqual({ total: 100, reachable: 60, invalid: 15, unknown: 25 });
      expect(repo.preflightSummary).toHaveBeenCalledWith(expect.any(Object));
    });

    it('passes the audience where clause to preflightSummary', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        filters: { combinator: 'and', rules: [{ field: 'city', op: 'eq', value: 'Manaus' }] },
      } as any);
      repo.preflightSummary.mockResolvedValue({
        total: 10,
        reachable: 8,
        invalid: 1,
        unknown: 1,
      });

      await service.preflight('c1');

      // O `where` é o que `toPrismaWhere` produziu para os filtros da campanha.
      // (Não há mais guard de `optedOut` aqui: ele saiu do PÚBLICO em `ee55b98`
      // e do ENVIO na decisão do cliente de 25/08/2026.)
      expect(repo.preflightSummary).toHaveBeenCalledWith(
        expect.objectContaining({ AND: expect.any(Array) }),
      );
    });

    // FASE 0 §0.1 — preflight() agora resolve 'unreached' (o mesmo chokepoint
    // de run()): numa campanha JÁ EXECUTADA, quem RECEBEU (SENT/DELIVERED/READ)
    // não deve contar como "vai receber de novo" na prévia. Antes, o preflight
    // usava resolveAudienceWhere puro (sem cláusula de Message nenhuma) e
    // contaria a base inteira de novo, mesmo repetindo quem já recebeu.
    it('preview de campanha já executada reflete o recorte não-alcançado', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        templateId: 't1',
        filters: { combinator: 'and', rules: [] },
      } as any);
      repo.preflightSummary.mockResolvedValue({
        total: 10,
        reachable: 8,
        invalid: 1,
        unknown: 1,
      });

      await service.preflight('c1');

      const where = repo.preflightSummary.mock.calls[0][0] as {
        AND: Array<Record<string, any>>;
      };
      const none = where.AND.find((c) => c.messages);
      expect(none?.messages.none).toEqual({
        campaignId: 'c1',
        direction: 'OUTBOUND',
        status: { in: ['SENT', 'DELIVERED', 'READ'] },
      });
    });
  });

  describe('findDueScheduledCampaigns', () => {
    it('delegates to repo.findDueScheduled', async () => {
      const now = new Date();
      repo.findDueScheduled.mockResolvedValue([] as any);
      await service.findDueScheduledCampaigns(now);
      expect(repo.findDueScheduled).toHaveBeenCalledWith(now);
    });
  });

  // ── A4 — serialise retry/redispatch per campaign ───────────────────────────
  describe('A4 — per-campaign resend serialization', () => {
    it('redispatchCampaign rejects a concurrent invocation when the lock is held', async () => {
      // Simulate the lock already held by a first, in-flight invocation.
      redis.set.mockResolvedValue(null);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

      await expect(service.redispatchCampaign('c1')).rejects.toThrow(
        CampaignOperationInProgressError,
      );
      // The duplicate must NOT create any messages or enqueue any jobs.
      expect(repo.createMessage).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('two concurrent redispatchCampaign calls: only one creates a batch', async () => {
      // Real-ish lock: first SET NX wins ('OK'), second loses (null).
      redis.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null);
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }, { id: 'k2' }]);
      repo.createMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` }) as any,
      );

      const [a, b] = await Promise.allSettled([
        service.redispatchCampaign('c1'),
        service.redispatchCampaign('c1'),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      const rejected = [a, b].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        CampaignOperationInProgressError,
      );
      // Exactly ONE batch of 2 contacts was created (not two batches of 2).
      expect(repo.createMessage).toHaveBeenCalledTimes(2);
      expect(sendQueue.add).toHaveBeenCalledTimes(2);
    });

    it('redispatchCampaign releases the lock after a successful run', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as any);

      await service.redispatchCampaign('c1');

      // Release is an owner-checked compare-and-delete (Lua eval) on our key,
      // never an unconditional DEL that could clobber a re-acquiring caller.
      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'campaign:lock:resend:c1',
        expect.any(String),
      );
    });

    it('redispatchCampaign releases the lock even when dispatch throws', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'RUNNING',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);
      wireRecipientPages([{ id: 'k1' }]);
      repo.createMessage.mockRejectedValue(new Error('db down'));

      await expect(service.redispatchCampaign('c1')).rejects.toThrow('db down');
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'campaign:lock:resend:c1',
        expect.any(String),
      );
    });

    it('retryFailedMessages rejects a concurrent invocation when the lock is held', async () => {
      redis.set.mockResolvedValue(null);
      repo.findById.mockResolvedValue({ id: 'c1', status: 'FAILED' } as any);
      repo.findFailedMessageIds.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
      ] as any);

      await expect(service.retryFailedMessages('c1')).rejects.toThrow(
        CampaignOperationInProgressError,
      );
      expect(repo.resetForRetry).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('retryFailedMessages uses the shared resend lock key and releases it', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findById.mockResolvedValue({ id: 'c1', status: 'FAILED' } as any);
      repo.findFailedMessageIds.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
      ] as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);

      await service.retryFailedMessages('c1');

      expect(redis.set).toHaveBeenCalledWith(
        'campaign:lock:resend:c1',
        expect.any(String),
        'PX',
        expect.any(Number),
        'NX',
      );
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'campaign:lock:resend:c1',
        expect.any(String),
      );
    });

    it('retryMessage rejects a concurrent invocation on the same campaign', async () => {
      redis.set.mockResolvedValue(null);
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);

      await expect(service.retryMessage('m1')).rejects.toThrow(
        CampaignOperationInProgressError,
      );
      expect(repo.resetForRetry).not.toHaveBeenCalled();
      expect(sendQueue.add).not.toHaveBeenCalled();
    });

    it('retryMessage releases its campaign-scoped lock after success', async () => {
      redis.set.mockResolvedValue('OK');
      repo.findMessageById.mockResolvedValue({
        id: 'm1',
        status: 'FAILED',
        campaignId: 'c1',
        contactId: 'k1',
      } as any);
      repo.resetForRetry.mockResolvedValue('ok' as never);

      await service.retryMessage('m1');

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'campaign:lock:resend:c1',
        expect.any(String),
      );
    });

    // Bug 1 (TTL expiry mid-run): a dispatch that outlives CAMPAIGN_LOCK_TTL_MS
    // must REFRESH its own lock while paging so the mutex can't expire and admit
    // a concurrent second full dispatch (double-send of the whole audience).
    it('refreshes the resend lock while a long dispatch is in flight', async () => {
      vi.useFakeTimers();
      try {
        redis.set.mockResolvedValue('OK');
        repo.findById.mockResolvedValue({
          id: 'c1',
          status: 'RUNNING',
          defaultInstanceId: 'inst-1',
          filters: { combinator: 'and', rules: [] },
          variableMap: {},
        } as any);
        // Pre-check da audiência (§0.2): há gente a alcançar, senão o serviço
        // lançaria CampaignNoPendingRecipientsError antes mesmo de chegar à
        // página que este teste trava propositalmente no gate abaixo.
        repo.countContactsByWhere.mockResolvedValue(1);
        // Block the first page read on a gate we control so the lock is held
        // across at least one heartbeat interval.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        repo.findContactsPage.mockImplementation((async () => {
          await gate;
          return [] as any;
        }) as any);

        const p = service.redispatchCampaign('c1');
        // Advance past one full TTL so the heartbeat (fires each TTL/2) runs.
        await vi.advanceTimersByTimeAsync(CAMPAIGN_LOCK_TTL_MS);

        // A compare-and-extend (pexpire) keyed by our token was issued.
        expect(redis.eval).toHaveBeenCalledWith(
          expect.stringContaining('pexpire'),
          1,
          'campaign:lock:resend:c1',
          expect.any(String),
          String(CAMPAIGN_LOCK_TTL_MS),
        );

        release();
        await p;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ZE — CAMPANHA EM LOTES (retomável)
  //
  // Pedido do cliente, literal: "Quero enviar 50 agora... Aí depois eu quero,
  // naquela mesma campanha, enviar para mais 100. Só que eu não vou ter a dor de
  // cabeça de saber pra quem eu não enviei — o sistema só vai me listar, só vou
  // poder enviar para as pessoas que eu ainda não enviei naquela campanha."
  // ══════════════════════════════════════════════════════════════════════════
  describe('resolveAudience — o resolvedor único de três modos', () => {
    const campaign = {
      id: 'camp1',
      templateId: 't1',
      filters: { combinator: 'and', rules: [] },
      segmentId: null,
      limit: null,
    };

    beforeEach(() => {
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
    });

    it("mode 'pending' aplica o filtro de TRATADOS (handled — OR explícito)", async () => {
      const { where } = await (service as any).resolveAudience(
        campaign,
        'pending',
      );
      const none = (where.AND as any[]).find((c) => c.messages)?.messages?.none;
      // handledInCampaignFilter usa OR explícito, não REACHED_STATUSES.
      expect(none.OR).toBeDefined();
      expect(none.campaignId).toBe('camp1');
    });

    it("mode 'unreached' aplica o filtro de RECEBIDOS (SENT|DELIVERED|READ, OUTBOUND)", async () => {
      const { where } = await (service as any).resolveAudience(
        campaign,
        'unreached',
      );
      const none = (where.AND as any[]).find((c) => c.messages)?.messages?.none;
      expect(none.status).toEqual({ in: ['SENT', 'DELIVERED', 'READ'] });
      expect(none.direction).toBe('OUTBOUND');
      // NÃO é o predicado de handled (sem OR).
      expect(none.OR).toBeUndefined();
    });

    it("mode 'full' devolve where === audience (sem cláusula de Message)", async () => {
      const { audience, where } = await (service as any).resolveAudience(
        campaign,
        'full',
      );
      expect(where).toEqual(audience);
    });

    it('isMarketing reflete a categoria do template', async () => {
      const { isMarketing } = await (service as any).resolveAudience(
        campaign,
        'pending',
      );
      expect(isMarketing).toBe(true);
    });
  });

  describe('ZE — sendBatch (campanha retomável em lotes)', () => {
    type FakeContact = {
      id: string;
      phoneE164: string;
      optedOut: boolean;
      marketingUndeliverableAt: Date | null;
    };
    type FakeMessage = {
      contactId: string;
      status: MessageStatus;
      errorCode: string | null;
    };

    let contacts: FakeContact[];
    let messages: FakeMessage[];

    /** Um contato "cN" com id zero-padded — a ordem lexicográfica é a numérica,
     *  como o keyset por `id` (cuid) assume em produção. */
    const makeContacts = (n: number): FakeContact[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${String(i).padStart(3, '0')}`,
        phoneE164: `+5592${String(900000000 + i)}`,
        optedOut: false,
        marketingUndeliverableAt: null,
      }));

    /**
     * Simula o Postgres: `findContactsPage` aplica o MESMO recorte que o
     * `pendingAudienceWhere` empurra para o banco — cursor por id, exclui quem
     * já tem mensagem tratada na campanha e (quando a cláusula está presente no
     * `where`) exclui os inalcançáveis para marketing.
     */
    const wireFakeDb = () => {
      repo.findContactsPage.mockImplementation((async (
        where: any,
        opts: { take: number; cursorId?: string },
      ) => {
        const handled = new Set(
          messages.filter((m) => isHandledInCampaign(m)).map((m) => m.contactId),
        );
        const clauses: any[] = where?.AND ?? [];
        const excludesUnreachable = clauses.some(
          (c) => c && 'marketingUndeliverableAt' in c,
        );
        const pool = contacts
          .filter((c) => (opts.cursorId ? c.id > opts.cursorId : true))
          .filter((c) => !handled.has(c.id))
          .filter((c) => !(excludesUnreachable && c.marketingUndeliverableAt));
        return pool.slice(0, opts.take) as any;
      }) as any);

      repo.createMessage.mockImplementation((async (data: any) => {
        messages.push({
          contactId: data.contactId,
          status: 'QUEUED',
          errorCode: null,
        });
        return { id: `m-${data.contactId}` } as any;
      }) as any);

      repo.createSkippedMessage.mockImplementation((async (data: any) => {
        messages.push({
          contactId: data.contactId,
          status:
            data.reason === 'suppressed'
              ? 'SKIPPED_SUPPRESSED'
              : 'SKIPPED_NO_CONSENT',
          errorCode: data.reason,
        });
        return { id: `s-${data.contactId}` } as any;
      }) as any);

      repo.createBatch.mockImplementation((async (data: any) => ({
        id: 'batch-1',
        campaignId: data.campaignId,
        seq: 1,
        requested: data.requested,
        queued: 0,
        skipped: 0,
        startedAt: new Date(),
        finishedAt: null,
        createdByUserId: null,
      })) as any);
      repo.finishBatch.mockResolvedValue({} as any);
      repo.countBatches.mockResolvedValue(1);
      repo.groupMessagesByStatus.mockResolvedValue([] as any);
    };

    /** Contatos que receberam mensagem de verdade (não as linhas SKIPPED). */
    const queuedContactIds = () =>
      messages.filter((m) => m.status === 'QUEUED').map((m) => m.contactId);

    beforeEach(() => {
      contacts = makeContacts(120);
      messages = [];
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'DRAFT',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        purposeKey: 'marketing',
        override: false,
        overrideJustification: null,
        scheduleType: 'IMMEDIATE',
        segmentId: null,
        totalRecipients: 0,
      } as any);
      // Template de MARKETING, aprovado, do mesmo provedor do canal.
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      instancesRepo.findById.mockResolvedValue({
        id: 'i1',
        provider: 'ZERNIO',
        isActive: true,
        sentToday: 0,
        dailySendLimit: 500,
      } as any);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.countContactsByWhere.mockImplementation(
        (async () => contacts.length) as any,
      );
      wireFakeDb();
    });

    it('envia 50 de uma audiência de 120 — e para exatamente aí', async () => {
      const r = await service.sendBatch('camp1', 50);

      expect(r.queued).toBe(50);
      expect(queuedContactIds()).toHaveLength(50);
    });

    it('o 2º lote de 100 envia só os 70 restantes — e NÃO repete os 50 primeiros', async () => {
      const first = await service.sendBatch('camp1', 50);
      const firstIds = [...queuedContactIds()];

      // A campanha já não está mais em DRAFT no 2º lote.
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        purposeKey: 'marketing',
        override: false,
        overrideJustification: null,
        scheduleType: 'IMMEDIATE',
        segmentId: null,
        totalRecipients: 120,
      } as any);

      const second = await service.sendBatch('camp1', 100);

      expect(first.queued).toBe(50);
      // Pediu 100, mas só existiam 70 pendentes. Não é erro: é o fim da campanha.
      expect(second.queued).toBe(70);

      const allIds = queuedContactIds();
      expect(allIds).toHaveLength(120);
      // O invariante que o cliente pediu: ninguém recebe duas vezes.
      expect(new Set(allIds).size).toBe(120);
      // E os 50 do primeiro lote não voltaram.
      const secondIds = allIds.slice(50);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    });

    it('contato inalcançável para MARKETING nunca entra no lote', async () => {
      contacts[3].marketingUndeliverableAt = new Date();
      contacts[7].marketingUndeliverableAt = new Date();

      await service.sendBatch('camp1', 120);

      const sent = queuedContactIds();
      expect(sent).not.toContain('c003');
      expect(sent).not.toContain('c007');
      // Os outros 118 foram normalmente.
      expect(sent).toHaveLength(118);
    });

    it('numa campanha UTILITY os inalcançáveis CONTINUAM sendo enviados', async () => {
      // A Meta é explícita: "UTILITY TEMPLATES ARE NOT AFFECTED".
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'UTILITY',
      } as any);
      contacts[3].marketingUndeliverableAt = new Date();

      await service.sendBatch('camp1', 120);

      expect(queuedContactIds()).toContain('c003');
    });

    it('★ broadcast LIGADO: o lote INTEIRO vira UM job — sem o fatiamento fixo de 50', async () => {
      // Pedido de 13/07 (validado na doc do Zernio e da Meta): não existe
      // limite por broadcast nem por campanha — o limite real é o tier da
      // janela rolante de 24h, GLOBAL. Fatiar em pedaços de 50 só espalhava a
      // campanha em N broadcasts no painel. Quem corta agora é o dispatchBatch
      // (no teto da janela), e o excedente volta re-enfileirado.
      const broadcastQueue = { add: vi.fn(async () => ({ id: 'd' })) };
      const svcBroadcast = new CampaignsService(
        repo,
        segmentsRepo,
        templatesRepo,
        instancesRepo,
        sendQueue,
        audit,
        cls,
        redis as never,
        consent,
        prisma,
        broadcastQueue as never,
      );
      instancesRepo.findById.mockResolvedValue({
        id: 'i1',
        provider: 'ZERNIO',
        isActive: true,
        sentToday: 0,
        dailySendLimit: 2000,
        zernioBroadcastEnabled: true,
        zernioBroadcastChunk: 50,
      } as any);

      const r = await svcBroadcast.sendBatch('camp1', 120);

      expect(r.queued).toBe(120);
      expect(broadcastQueue.add).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastQueue.add.mock.calls[0] as [
        string,
        { messageIds: string[] },
      ];
      expect(payload.messageIds).toHaveLength(120);
    });

    it('respeita o gate de consentimento: quem não consentiu não consome cota do lote', async () => {
      // Só os 60 primeiros consentiram. Um lote de 50 deve entregar 50 ENVIOS —
      // não 50 "contatos varridos" dos quais metade foi pulada.
      const consented = new Set(contacts.slice(0, 60).map((c) => c.id));
      consent.grantedContactIds.mockImplementation(
        async (ids: string[]) => new Set(ids.filter((id) => consented.has(id))),
      );

      const r = await service.sendBatch('camp1', 50);

      expect(r.queued).toBe(50);
      expect(queuedContactIds()).toHaveLength(50);
    });

    it('respeita a supressão: contato suprimido não entra no lote', async () => {
      consent.suppressedPhones.mockResolvedValue(
        new Set([contacts[0].phoneE164]),
      );

      await service.sendBatch('camp1', 10);

      expect(queuedContactIds()).not.toContain('c000');
    });

    it('uma falha TRANSITÓRIA devolve o contato para o próximo lote', async () => {
      await service.sendBatch('camp1', 10);
      // O Zernio caiu no meio do lote: 3 mensagens falharam com 500.
      for (const m of messages.slice(0, 3)) {
        m.status = 'FAILED';
        m.errorCode = '500';
      }
      const failedIds = messages.slice(0, 3).map((m) => m.contactId);

      messages = messages.filter((m) => m.status !== 'QUEUED' || true);
      const before = queuedContactIds().length;
      await service.sendBatch('camp1', 10);

      // Os 3 que falharam transitoriamente voltaram a ser pendentes e foram
      // re-enfileirados — o operador não precisou caçar quem faltou.
      const requeued = queuedContactIds().slice(before);
      expect(failedIds.every((id) => requeued.includes(id))).toBe(true);
    });

    it('uma falha DEFINITIVA (131026) NÃO devolve o contato para o próximo lote', async () => {
      await service.sendBatch('camp1', 10);
      messages[0].status = 'FAILED';
      messages[0].errorCode = '131026';
      const deadId = messages[0].contactId;
      const before = queuedContactIds().length;

      await service.sendBatch('camp1', 10);

      expect(queuedContactIds().slice(before)).not.toContain(deadId);
    });

    it('recusa um lote numa campanha terminal', async () => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'COMPLETED',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
      } as any);

      await expect(service.sendBatch('camp1', 10)).rejects.toBeInstanceOf(
        CampaignBatchNotAllowedError,
      );
    });

    it('recusa um lote quando não há mais ninguém pendente', async () => {
      contacts = [];

      await expect(service.sendBatch('camp1', 10)).rejects.toBeInstanceOf(
        CampaignNoPendingRecipientsError,
      );
    });

    it('registra o lote no histórico (quantos pedidos × quantos enfileirados)', async () => {
      await service.sendBatch('camp1', 50);

      expect(repo.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({ campaignId: 'camp1', requested: 50 }),
      );
      expect(repo.finishBatch).toHaveBeenCalledWith(
        'batch-1',
        expect.objectContaining({ queued: 50 }),
      );
    });

    it('vincula as mensagens ao lote que as gerou', async () => {
      await service.sendBatch('camp1', 5);

      expect(repo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ campaignBatchId: 'batch-1' }),
      );
    });

    it('o primeiro lote desarma o agendamento one-shot (senão o scheduler dispara TUDO)', async () => {
      await service.sendBatch('camp1', 50);

      expect(repo.transitionToQueued).toHaveBeenCalledWith(
        'camp1',
        120,
        expect.objectContaining({ disarmSchedule: true }),
      );
    });

    // PROVA DA NÃO-MUDANÇA: o refactor resolveAudience(mode) não pode alterar o
    // recorte REAL que o lote envia. Prende o `where` que chega em
    // findContactsPage e confirma que ainda é o predicado de TRATADOS (handled,
    // OR explícito) — e NÃO o de RECEBIDOS (reached), que é o modo 'unreached'
    // reservado às Tasks 3-5.
    it('sendBatch dispara o recorte PENDENTE (handled), inalterado', async () => {
      await service.sendBatch('camp1', 50);

      const where = repo.findContactsPage.mock.calls[0][0] as any;
      const none = (where.AND as any[]).find((c) => c.messages)?.messages?.none;
      // handledInCampaignFilter usa OR (11 status + FAILED-permanente); o de
      // 'unreached' seria um status:{ in: [...] } com direction:'OUTBOUND'.
      expect(none.OR).toBeDefined();
      expect(none.status).toBeUndefined();
      expect(none.direction).toBeUndefined();
      expect(none.campaignId).toBe('camp1');
    });

    /**
     * A.4 — PEDIR MAIS DO QUE RESTA É SEMPRE UM NÚMERO VELHO NA TELA.
     *
     * Antes o lote mandava o que houvesse e ficava calado. Com o cabeçalho de
     * progresso, o número do campo vem de "Restam" — se ele estourou, o que o
     * operador está lendo já não é verdade, e mandar assim mesmo é o mesmo
     * silêncio que fez ele reenviar em cima de quem já tinha recebido.
     */
    it('recusa (400) um lote maior do que o público que resta, dizendo quantos restam', async () => {
      repo.countContactsByWhere.mockResolvedValue(70);

      await expect(service.sendBatch('camp1', 100)).rejects.toMatchObject({
        status: 400,
        code: 'campaign.batch_size_exceeds_pending',
        message: expect.stringContaining('70'),
      });
      expect(repo.createBatch).not.toHaveBeenCalled();
    });

    it('aceita o lote de tamanho EXATAMENTE igual ao que resta', async () => {
      repo.countContactsByWhere.mockResolvedValue(70);

      const r = await service.sendBatch('camp1', 70);

      expect(r.requested).toBe(70);
    });

    /**
     * A.4 — o resumo VOLTA COM O LOTE. Sem isto a tela precisa de uma 2ª
     * chamada, e no intervalo ela mostra os números de ANTES do envio: o
     * operador clica "enviar 300", lê "Restam 12.900" por mais um segundo e
     * clica de novo.
     */
    it('devolve o resumo (summary) junto com o lote criado', async () => {
      const r = await service.sendBatch('camp1', 50);

      expect(r.summary).toEqual(
        expect.objectContaining({
          total: expect.any(Number),
          sent: expect.any(Number),
          pending: expect.any(Number),
          inFlight: expect.any(Number),
          waiting: expect.any(Number),
        }),
      );
    });
  });

  // A aba "enviados × não enviados" que o cliente pediu. Os PENDENTES não têm
  // Message nenhuma (é o que os define), então não dá para listá-los pelo
  // /messages — eles só existem como CONTATOS que a audiência ainda alcança.
  describe('ZE — listRecipients (enviados × não enviados × inalcançáveis)', () => {
    beforeEach(() => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
      } as any);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      repo.listContactsPaged.mockResolvedValue({ items: [], total: 0 } as any);
    });

    it('grupo "enviados" filtra por quem TEM mensagem entregue nesta campanha', async () => {
      await service.listRecipients('camp1', {
        group: 'sent',
        page: 1,
        pageSize: 50,
      });

      const where = (repo.listContactsPaged.mock.calls[0] as any[])[0];
      const some = where.AND.find((c: any) => c.messages)?.messages?.some;
      expect(some.campaignId).toBe('camp1');
      expect(some.status.in).toEqual(['SENT', 'DELIVERED', 'READ']);
    });

    it('grupo "pendentes" usa o MESMO recorte que o lote enviaria', async () => {
      await service.listRecipients('camp1', {
        group: 'pending',
        page: 1,
        pageSize: 50,
      });

      const where = (repo.listContactsPaged.mock.calls[0] as any[])[0];
      // Exclui quem já foi tratado…
      expect(
        where.AND.find((c: any) => c.messages)?.messages?.none?.campaignId,
      ).toBe('camp1');
      // …e os inalcançáveis (a campanha é MARKETING).
      expect(where.AND).toContainEqual({ marketingUndeliverableAt: null });
    });

    it('grupo "inalcançáveis" lista quem desligou marketing', async () => {
      await service.listRecipients('camp1', {
        group: 'unreachable',
        page: 1,
        pageSize: 50,
      });

      const where = (repo.listContactsPaged.mock.calls[0] as any[])[0];
      expect(where.AND).toContainEqual({
        marketingUndeliverableAt: { not: null },
      });
    });
  });

  describe('ZE — maybeCompleteCampaign com lotes', () => {
    beforeEach(() => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
      } as any);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      // Nenhuma mensagem em voo: sem os lotes, isto COMPLETARIA a campanha.
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SENT', _count: 50 },
      ] as any);
    });

    it('NÃO conclui a campanha enquanto sobrar pendente', async () => {
      repo.countBatches.mockResolvedValue(1);
      repo.countContactsByWhere.mockResolvedValue(70); // 70 pendentes

      await service.maybeCompleteCampaign('camp1');

      expect(repo.updateStatus).not.toHaveBeenCalledWith(
        'camp1',
        'COMPLETED',
        expect.anything(),
      );
    });

    it('conclui quando não sobra pendente', async () => {
      repo.countBatches.mockResolvedValue(1);
      repo.countContactsByWhere.mockResolvedValue(0);

      await service.maybeCompleteCampaign('camp1');

      expect(repo.updateStatus).toHaveBeenCalledWith(
        'camp1',
        'COMPLETED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
    });

    it('campanha SEM lotes mantém a semântica clássica (não consulta pendentes)', async () => {
      // O "Disparar" clássico enfileira a audiência inteira de uma vez. Uma falha
      // transitória lá NÃO pode impedir a campanha de concluir para sempre.
      repo.countBatches.mockResolvedValue(0);

      await service.maybeCompleteCampaign('camp1');

      expect(repo.updateStatus).toHaveBeenCalledWith(
        'camp1',
        'COMPLETED',
        expect.anything(),
      );
    });
  });

  /**
   * GATE SILENCIOSO — o incidente de 2026-07-10.
   *
   * O operador montou uma campanha para 2 contatos, disparou e não saiu nada.
   * Passou horas achando que era problema de HORÁRIO/agendamento. Não era: os 2
   * contatos não tinham consentimento para a finalidade declarada e o gate os
   * marcou como SKIPPED_NO_CONSENT — corretamente, mas EM SILÊNCIO.
   *
   * O gate está certo e não muda. O que muda é a VISIBILIDADE do bloqueio.
   */
  describe('gate silencioso — os pulados precisam CONCLUIR a campanha e APARECER', () => {
    it('run() com audiência 100% sem consentimento CONCLUI a campanha (hoje fica RUNNING para sempre)', async () => {
      // Nenhum job vai para o BullMQ (queued=0), logo o worker nunca roda e
      // ninguém nunca chama maybeCompleteCampaign — a campanha ficava "Em
      // execução" eternamente.
      const draft = {
        id: 'cq',
        status: 'DRAFT',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        purposeKey: 'campanha_apoio',
        override: false,
        overrideJustification: null,
        scheduleType: 'IMMEDIATE',
        runCount: 0,
      };
      // A 1ª leitura (run) vê DRAFT; depois do updateStatus(RUNNING) as leituras
      // seguintes (maybeCompleteCampaign) veem RUNNING.
      repo.findById.mockResolvedValue({ ...draft, status: 'RUNNING' } as any);
      repo.findById.mockResolvedValueOnce(draft as any);
      repo.transitionToQueued.mockResolvedValue(1);
      repo.createSkippedMessage.mockImplementation(
        async ({ contactId }: { contactId: string }) =>
          ({ id: `skip-${contactId}` }) as any,
      );
      instancesRepo.findById.mockResolvedValue({
        id: 'i1',
        provider: 'TWILIO',
        isActive: true,
      } as any);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'TWILIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      wireRecipientPages([
        { id: 'ct1', phoneE164: '+5592991110001' },
        { id: 'ct2', phoneE164: '+5592991110002' },
      ]);
      consent.grantedContactIds.mockResolvedValue(new Set());
      repo.countBatches.mockResolvedValue(0);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SKIPPED_NO_CONSENT', _count: 2 } as any,
      ]);

      const result = await service.run('cq');

      expect(result).toEqual({ queued: 0 });
      expect(sendQueue.add).not.toHaveBeenCalled();
      // A campanha não pode ficar "Em execução" com nada em voo.
      expect(repo.updateStatus).toHaveBeenCalledWith(
        'cq',
        'COMPLETED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
    });

    it('100% pulados pelo gate NÃO é FALHA — é campanha concluída sem envios', async () => {
      // FAILED mentiria: nada falhou, tudo foi BLOQUEADO. A verdade vem do
      // contador de pulados, não do status.
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.countBatches.mockResolvedValue(0);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SKIPPED_NO_CONSENT', _count: 2 } as any,
      ]);

      await service.maybeCompleteCampaign('c1');

      expect(repo.updateStatus).toHaveBeenCalledWith(
        'c1',
        'COMPLETED',
        expect.objectContaining({ finishedAt: expect.any(Date) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.completed',
        'Campaign',
        'c1',
        expect.objectContaining({ totalSucceeded: 0, skippedNoConsent: 2 }),
      );
    });

    it('não conclui uma campanha que ainda não materializou nenhuma mensagem', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'RUNNING' } as any);
      repo.countBatches.mockResolvedValue(0);
      repo.groupMessagesByStatus.mockResolvedValue([]);

      await service.maybeCompleteCampaign('c1');

      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('getById expõe o contador de pulados por consentimento (o número que sumia dos totais)', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'COMPLETED' } as any);
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'SKIPPED_NO_CONSENT', _count: 2 } as any,
        { status: 'SKIPPED_SUPPRESSED', _count: 1 } as any,
        { status: 'SENT', _count: 3 } as any,
      ]);

      const result = await service.getById('c1');

      expect(result.skippedNoConsent).toBe(2);
      expect(result.skippedSuppressed).toBe(1);
      expect(result.skippedTotal).toBe(3);
    });

    it('listRecipients ganha o grupo "skipped" — o contato pulado não sumia em nenhuma aba', async () => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'COMPLETED',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
      } as any);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      repo.listSkippedContactsPaged.mockResolvedValue({
        items: [
          {
            id: 'ct1',
            name: 'Maria',
            phoneE164: '+5592991110001',
            marketingUndeliverableAt: null,
            marketingUndeliverableReason: null,
            skipReason: 'no_consent',
          },
        ],
        total: 1,
      } as any);

      const result = await service.listRecipients('camp1', {
        group: 'skipped',
        page: 1,
        pageSize: 50,
      });

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({ skipReason: 'no_consent' });
      const [, campaignId] = repo.listSkippedContactsPaged.mock
        .calls[0] as any[];
      expect(campaignId).toBe('camp1');
    });

    // F2 T7 — o grupo "failed": quem tem Message FAILED nesta campanha não
    // tinha aba própria (ficava implícito em "pendente", se ainda elegível
    // para retry) e o MOTIVO da falha era invisível na tela.
    it('listRecipients ganha o grupo "failed" — contatos com Message FAILED, com o motivo embutido', async () => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'COMPLETED',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
      } as any);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as any);
      repo.listFailedContactsPaged.mockResolvedValue({
        items: [
          {
            id: 'ct2',
            name: 'Bia',
            phoneE164: '+5592991110002',
            marketingUndeliverableAt: null,
            marketingUndeliverableReason: null,
            failureReason: 'TELEFONE_INVALIDO',
            errorCode: '21211',
          },
        ],
        total: 1,
      } as any);

      const result = await service.listRecipients('camp1', {
        group: 'failed',
        page: 1,
        pageSize: 50,
      });

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        failureReason: 'TELEFONE_INVALIDO',
      });
      const [, campaignId] = repo.listFailedContactsPaged.mock
        .calls[0] as any[];
      expect(campaignId).toBe('camp1');
    });
  });

  /**
   * F2 T7 — GET /campaigns/:id/failure-reasons: a agregação
   * [{failureReason, count}] das Messages FAILED da campanha, para o painel
   * "por que falhou" (em vez do operador ter que abrir mensagem por mensagem).
   */
  describe('getFailureReasons', () => {
    it('agrega as falhas da campanha por motivo, com rótulo PT-BR', async () => {
      repo.findById.mockResolvedValue({ id: 'camp1', status: 'COMPLETED' } as any);
      repo.groupFailuresByReason.mockResolvedValue([
        { failureReason: 'OPT_OUT', count: 5 },
        { failureReason: 'TELEFONE_INVALIDO', count: 2 },
        { failureReason: null, count: 1 },
      ] as any);

      const result = await service.getFailureReasons('camp1');

      expect(repo.groupFailuresByReason).toHaveBeenCalledWith('camp1');
      expect(result).toEqual([
        {
          failureReason: 'OPT_OUT',
          count: 5,
          label: expect.any(String),
        },
        {
          failureReason: 'TELEFONE_INVALIDO',
          count: 2,
          label: expect.any(String),
        },
        { failureReason: null, count: 1, label: null },
      ]);
    });

    it('lança CampaignNotFoundError quando a campanha não existe', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.getFailureReasons('nope')).rejects.toThrow(
        CampaignNotFoundError,
      );
      expect(repo.groupFailuresByReason).not.toHaveBeenCalled();
    });
  });
  /**
   * APAGAR CAMPANHA.
   *
   * `Message.campaignId -> Campaign` é `onDelete: Cascade`: apagar a campanha
   * APAGA AS MENSAGENS — e as Message são as BOLHAS DO INBOX
   * (`Message.conversationId`). Apagar uma campanha que enviou de verdade ARRANCA
   * essas bolhas das conversas. Por isso a tela avisa ANTES, com o número.
   *
   * O que SOBREVIVE, por construção do schema:
   *   • ConsentEvent — não tem FK para Campaign, e há trigger no banco proibindo
   *     DELETE. O consentimento é prova jurídica; nenhum "apagar campanha" o toca.
   *   • ZernioBroadcast — SetNull: o histórico do disparo no Zernio continua.
   */
  describe('remove (apagar campanha)', () => {
    it('apaga a campanha', async () => {
      repo.findById.mockResolvedValue({ id: 'c1', status: 'COMPLETED' } as any);

      await service.remove('c1');

      expect(repo.delete).toHaveBeenCalledWith('c1');
    });

    it('campanha inexistente -> CampaignNotFoundError', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.remove('nao-existe')).rejects.toBeInstanceOf(
        CampaignNotFoundError,
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });

    /**
     * Apagar uma campanha EM VOO deixaria os jobs do BullMQ apontando para
     * Message que não existem mais — o worker erraria em silencio, job a job. E o
     * operador nao teria como saber quantas mensagens chegaram a sair. Cancele
     * primeiro; o cancelamento ja existe e e explicito.
     */
    for (const status of ['QUEUED', 'RUNNING']) {
      it(`recusa apagar campanha ${status} (em voo) — cancele antes`, async () => {
        repo.findById.mockResolvedValue({ id: 'c1', status } as any);

        await expect(service.remove('c1')).rejects.toBeInstanceOf(
          CampaignInFlightError,
        );
        expect(repo.delete).not.toHaveBeenCalled();
      });
    }

    it('registra no audit quem apagou (e o que foi destruido junto)', async () => {
      repo.findById.mockResolvedValue({
        id: 'c1',
        status: 'COMPLETED',
        name: 'Teste 1',
      } as any);

      await service.remove('c1');

      expect(audit.log).toHaveBeenCalledWith(
        'campaign.delete',
        'Campaign',
        'c1',
        expect.objectContaining({ name: 'Teste 1' }),
      );
    });
  });

  /**
   * F1 T9 — GET /campaigns/:id/dependent-segments. Quando a campanha é apagada
   * (remove() acima), o CASCADE leva junto as Message, e um Segment cujo
   * filters tem um nó history {campaignIds: [id]} para de enxergar quem já
   * recebeu dela — silenciosamente. Este endpoint é o que alimenta o aviso na
   * tela de apagar.
   */
  describe('getDependentSegments', () => {
    it('campanha inexistente -> CampaignNotFoundError', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.getDependentSegments('nao-existe'),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
      expect(segmentsRepo.findAllWithFilters).not.toHaveBeenCalled();
    });

    it('um Segment cujo filters tem history com o campaignId aparece', async () => {
      repo.findById.mockResolvedValue({ id: 'camp-1', status: 'COMPLETED' } as any);
      segmentsRepo.findAllWithFilters.mockResolvedValue([
        {
          id: 'seg-1',
          name: 'Já receberam a campanha X',
          filters: {
            combinator: 'and',
            rules: [
              {
                kind: 'history',
                event: 'received',
                negate: true,
                campaignIds: ['camp-1'],
              },
            ],
          },
        },
      ] as any);

      const result = await service.getDependentSegments('camp-1');

      expect(result).toEqual([
        { id: 'seg-1', name: 'Já receberam a campanha X' },
      ]);
    });

    it('um Segment sem esse campaignId não aparece', async () => {
      repo.findById.mockResolvedValue({ id: 'camp-1', status: 'COMPLETED' } as any);
      segmentsRepo.findAllWithFilters.mockResolvedValue([
        {
          id: 'seg-1',
          name: 'Sem relação',
          filters: { combinator: 'and', rules: [{ field: 'city', op: 'eq', value: 'Manaus' }] },
        },
        {
          id: 'seg-2',
          name: 'Outra campanha',
          filters: {
            combinator: 'and',
            rules: [
              {
                kind: 'history',
                event: 'received',
                negate: true,
                campaignIds: ['camp-outra'],
              },
            ],
          },
        },
      ] as any);

      const result = await service.getDependentSegments('camp-1');

      expect(result).toEqual([]);
    });
  });

/**
 * A regra "não reenviar o mesmo template ao mesmo contato" no FUNIL de audiência
 * (spec `docs/superpowers/specs/2026-08-12-exclusao-por-template-design.md`).
 *
 * Precisa morar em `resolveAudience` e NÃO no `create`: o `create` não envia
 * nada — só conta. Quem materializa é o disparo, e ele RE-RESOLVE o filtro
 * contra a base atual a cada execução (lote 2..N, tick do agendador semanas
 * depois, campanha baseada em segmento). Uma checagem na criação seria uma foto
 * de t0 que ninguém revalida.
 *
 * E precisa ficar FORA do switch de modo: o modo `full` ("disparar novamente
 * para todos") descarta o histórico por construção e anularia a regra.
 */
describe('preview — exclusão por template espelhada na prévia', () => {
  it('sem templateId a prévia não muda (chamadas antigas seguem iguais)', async () => {
    prisma.campaign.findMany.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(500);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview({ combinator: 'and', rules: [] } as never, null);

    expect(r.count).toBe(500);
    expect(r.excludedSameTemplate).toBe(0);
    expect(prisma.campaign.findMany).not.toHaveBeenCalled();
  });

  it('com templateId, aplica a MESMA regra e devolve quantos saíram', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'irma-viva', status: 'RUNNING' },
    ] as never);
    repo.countContactsByWhere
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(88);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview(
      { combinator: 'and', rules: [] } as never,
      null,
      'tpl-T',
    );

    expect(r.count).toBe(88);
    expect(r.excludedSameTemplate).toBe(412);
    // A amostra sai da audiência JÁ filtrada — senão a tela lista gente que
    // não vai receber.
    const whereDaAmostra = JSON.stringify(
      repo.findContactsByWhere.mock.calls.at(-1)?.[0],
    );
    expect(whereDaAmostra).toContain('irma-viva');
  });

  /**
   * ★ Pedido do cliente 2026-08-25 — reprodução do relato "excluir quem já
   * recebeu parece não funcionar": uma campanha NOVA com um template
   * DIFERENTE de uma campanha anterior. `prisma.campaign.findMany` é
   * consultado com `templateId` fixo em 'tpl-NOVO' — a campanha irmã, que é
   * de outro template ('tpl-VELHO'), nunca aparece na resposta (é o Prisma
   * REAL quem filtra isso; o mock aqui só documenta o WHERE enviado), então
   * ninguém é excluído. Este é o comportamento DEFAULT, preservado de
   * propósito (`excludeAnyPreviousCampaign` ausente/false).
   */
  it('BUG REPRODUZIDO — template diferente de uma campanha anterior: exclusão automática não pergunta pela irmã (fica restrita ao MESMO template)', async () => {
    prisma.campaign.findMany.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(500);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview(
      { combinator: 'and', rules: [] } as never,
      null,
      'tpl-NOVO',
    );

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId: 'tpl-NOVO' },
      }),
    );
    expect(r.excludedSameTemplate).toBe(0);
    expect(r.count).toBe(500);
  });

  /**
   * ★ A CORREÇÃO — `excludeAnyPreviousCampaign: true` faz a MESMA prévia
   * enxergar a campanha irmã de OUTRO template e excluir quem já a recebeu.
   */
  it('CORRIGIDO — excludeAnyPreviousCampaign:true exclui quem recebeu uma campanha de OUTRO template', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'irma-outro-template', status: 'RUNNING' },
    ] as never);
    repo.countContactsByWhere
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(120);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview(
      { combinator: 'and', rules: [] } as never,
      null,
      'tpl-NOVO',
      true,
    );

    // A consulta de irmãs deixa de restringir por templateId — é o que
    // permite achar a campanha 'tpl-VELHO'.
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    expect(r.count).toBe(120);
    expect(r.excludedSameTemplate).toBe(380);
  });

  it('template sem campanha anterior: conta igual e contador em 0', async () => {
    prisma.campaign.findMany.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(500);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview(
      { combinator: 'and', rules: [] } as never,
      null,
      'tpl-novo',
    );

    expect(r.count).toBe(500);
    expect(r.excludedSameTemplate).toBe(0);
  });
});

describe('resolveAudience — exclusão por template', () => {
  const CAMPANHA = {
    id: 'camp-atual',
    templateId: 'tpl-T',
    filters: { combinator: 'and', rules: [] } as never,
    segmentId: null,
    limit: null,
  };

  function irmas(rows: { id: string; status: string }[]) {
    prisma.campaign.findMany.mockResolvedValue(rows as never);
  }

  /** `resolveAudience` é privado — exercitado pelo caminho público do serviço. */
  async function audienciaDe(mode: 'pending' | 'unreached' | 'full') {
    templatesRepo.findById.mockResolvedValue({
      id: 'tpl-T',
      category: 'UTILITY',
    } as never);
    return (
      service as unknown as {
        resolveAudience: (c: unknown, m: string) => Promise<{
          audience: Record<string, unknown>;
          where: Record<string, unknown>;
        }>;
      }
    ).resolveAudience(CAMPANHA, mode);
  }

  it('exclui quem está em OUTRA campanha do mesmo template', async () => {
    irmas([{ id: 'irma-viva', status: 'RUNNING' }]);

    const { audience } = await audienciaDe('unreached');

    expect(JSON.stringify(audience)).toContain('irma-viva');
  });

  it('a PRÓPRIA campanha é excluída NA QUERY — senão o modo `full` se anularia', async () => {
    // O Prisma real nunca devolveria a campanha corrente com este `where`, e o
    // mock não filtra nada: afirmar sobre o que ele devolve testaria o mock, não
    // o código. O que importa aqui é o PEDIDO — e ele precisa dizer, explícito,
    // para deixar a campanha corrente de fora. A deduplicação DENTRO dela é dos
    // modos `pending`/`unreached`, e o modo `full` existe para reenviar nela.
    irmas([]);

    await audienciaDe('full');

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          templateId: 'tpl-T',
          id: { not: 'camp-atual' },
        }),
      }),
    );
  });

  it('vale TAMBÉM no modo `full` — o botão "disparar para todos" não fura a regra', async () => {
    irmas([{ id: 'irma-viva', status: 'COMPLETED' }]);

    const { audience, where } = await audienciaDe('full');

    expect(JSON.stringify(audience)).toContain('irma-viva');
    expect(JSON.stringify(where)).toContain('irma-viva');
  });

  it('campanha CANCELADA entra com a régua curta (só entregue)', async () => {
    irmas([{ id: 'irma-cancelada', status: 'CANCELLED' }]);

    const { audience } = await audienciaDe('unreached');
    const json = JSON.stringify(audience);

    expect(json).toContain('irma-cancelada');
    expect(json).toContain('DELIVERED');
    // Em voo numa campanha cancelada NÃO bloqueia — o cancelamento libera.
    expect(json).not.toContain('WAITING_INSTANCE');
  });

  it('template sem nenhuma campanha anterior: audiência intocada', async () => {
    irmas([]);

    const { audience } = await audienciaDe('unreached');

    // Sem cláusula de exclusão — e sobretudo SEM um `none` vazio, que casaria
    // com todo mundo e daria a ilusão de exclusão sem excluir nada.
    expect(JSON.stringify(audience)).not.toContain('messages');
  });

  /**
   * ★ Pedido do cliente 2026-08-25 — mesma reprodução de
   * `describe('preview — exclusão por template...')`, agora no DISPARO
   * (resolveAudience): por padrão a consulta de irmãs continua restrita ao
   * MESMO template (`Campaign.excludeAnyPreviousCampaign` ausente/false).
   */
  it('excludeAnyPreviousCampaign ausente (default false): a consulta de irmãs continua restrita ao MESMO template', async () => {
    irmas([]);

    await audienciaDe('unreached');

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId: 'tpl-T', id: { not: 'camp-atual' } },
      }),
    );
  });

  /**
   * ★ A CORREÇÃO — `excludeAnyPreviousCampaign: true` amplia a rede de
   * `sameTemplateExclusion` para QUALQUER campanha anterior (de qualquer
   * template): a consulta de irmãs deixa de filtrar por `templateId`, e uma
   * irmã de OUTRO template passa a bloquear quem já a recebeu.
   */
  it('excludeAnyPreviousCampaign:true exclui quem recebeu uma campanha de OUTRO template', async () => {
    templatesRepo.findById.mockResolvedValue({
      id: 'tpl-T',
      category: 'UTILITY',
    } as never);
    irmas([{ id: 'irma-outro-template', status: 'RUNNING' }]);

    const { audience, where } = (await (
      service as unknown as {
        resolveAudience: (c: unknown, m: string) => Promise<{
          audience: Record<string, unknown>;
          where: Record<string, unknown>;
        }>;
      }
    ).resolveAudience(
      { ...CAMPANHA, excludeAnyPreviousCampaign: true },
      'unreached',
    )) as { audience: Record<string, unknown>; where: Record<string, unknown> };

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { not: 'camp-atual' } },
      }),
    );
    expect(JSON.stringify(audience)).toContain('irma-outro-template');
    expect(JSON.stringify(where)).toContain('irma-outro-template');
  });
});

  /**
   * A.1 — A GUARDA DE LEGADO.
   *
   * Uma campanha recorrente antiga com `limit: 500` NÃO pode mudar de público de
   * repente: o recorte tem de continuar sendo aplicado para ela. E uma campanha
   * nova (`limit: null`) não pode ganhar recorte nenhum.
   *
   * O mock de Prisma ignora `where`, então o que se asserta é o ARGUMENTO da
   * chamada a `applyAudienceLimit` — que é onde a decisão mora.
   */
  describe('A.1 — limit legado', () => {
    const campanha = (limit: number | null) =>
      ({
        id: 'campLegado',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
        limit,
      }) as never;

    beforeEach(() => {
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        category: 'MARKETING',
      } as never);
      repo.groupMessagesByStatus.mockResolvedValue([] as never);
      repo.countContactsByWhere.mockResolvedValue(0);
    });

    it('campanha ANTIGA com limit=500 continua recortando a audiência', async () => {
      repo.findById.mockResolvedValue(campanha(500));

      await service.batchSummary('campLegado');

      expect(repo.applyAudienceLimit).toHaveBeenCalledWith({}, 500);
    });

    it('campanha NOVA (limit null) não recorta nada', async () => {
      repo.findById.mockResolvedValue(campanha(null));

      await service.batchSummary('campLegado');

      expect(repo.applyAudienceLimit).toHaveBeenCalledWith({}, null);
    });
  });

  /**
   * A.5 — "EM FILA" E "AGUARDANDO O CANAL" SÃO COISAS DIFERENTES.
   *
   * QUEUED/SENDING é a campanha andando. WAITING_INSTANCE é a campanha PARADA
   * porque o número caiu — e é a única parcela que tem culpado e conserto. O
   * operador via os dois somados num "Pendentes" só, e passava a tarde
   * procurando o problema no agendamento.
   */
  describe('A.5 — batch-summary separa em-fila de aguardando-canal', () => {
    beforeEach(() => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
        limit: null,
      } as never);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        category: 'MARKETING',
      } as never);
      repo.countContactsByWhere.mockResolvedValue(0);
    });

    it('inFlight soma QUEUED+SENDING+WAITING_INSTANCE e waiting isola o canal', async () => {
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'QUEUED', _count: 12 },
        { status: 'SENDING', _count: 3 },
        { status: 'WAITING_INSTANCE', _count: 81 },
        { status: 'FAILED', _count: 2 },
      ] as never);

      const s = await service.batchSummary('camp1');

      expect(s.inFlight).toBe(96);
      expect(s.waiting).toBe(81);
      expect(s.failed).toBe(2);
    });

    it('sem nada em voo, os dois são zero (e não undefined)', async () => {
      repo.groupMessagesByStatus.mockResolvedValue([
        { status: 'DELIVERED', _count: 500 },
      ] as never);

      const s = await service.batchSummary('camp1');

      expect(s.inFlight).toBe(0);
      expect(s.waiting).toBe(0);
    });
  });

  /**
   * A.4 — `totalRecipients` É O PÚBLICO, NÃO O QUE SOBROU.
   *
   * O tick recorrente gravava ali o número de contatos que ELE enfileirou. Numa
   * campanha diária, o 2º tick achava 40 pendentes e escrevia 40: a barra de
   * progresso passava a dividir por 40 e mostrava ">100%", ou "0 destinatários"
   * quando não sobrava ninguém. O denominador tem de ser o PÚBLICO ELEGÍVEL
   * VIVO no momento da execução.
   *
   * O mock de Prisma ignora `where`, então os dois recortes são distinguidos
   * pelo ARGUMENTO: só o recorte do tick carrega `messages: { none: … }`.
   */
  describe('A.4 — totalRecipients é o público elegível vivo', () => {
    it('o tick recorrente NÃO sobrescreve totalRecipients com o pendente', async () => {
      repo.findById.mockResolvedValue({
        id: 'sc1',
        status: 'RUNNING',
        scheduleEnabled: true,
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        segmentId: null,
        limit: null,
        scheduleConfig: { type: 'INTERVAL', everyMinutes: 30 },
        timezone: 'America/Manaus',
        runCount: 1,
      } as never);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        category: 'MARKETING',
        // Sem isto, o guard T7 (assertTemplateProviderMatchesChannel, chamado
        // de dentro de dispatchAudience) recusa ANTES de chegar em markRan —
        // status ausente falha "!== APPROVED" incondicionalmente.
        status: 'APPROVED',
      } as never);
      // wireRecipientPages fixa countContactsByWhere; a implementação abaixo
      // TEM de vir depois dele para não ser sobrescrita.
      wireRecipientPages([{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }]);
      repo.countContactsByWhere.mockImplementation((async (w: unknown) =>
        JSON.stringify(w).includes('"messages"') ? 40 : 13400) as never);
      repo.createMessage.mockImplementation(
        (async ({ contactId }: { contactId: string }) =>
          ({ id: `msg-${contactId}` })) as never,
      );
      repo.markRan.mockResolvedValue(1 as never);

      await service.runScheduled('sc1');

      expect(repo.markRan).toHaveBeenCalledWith(
        'sc1',
        expect.any(Date),
        expect.any(Date),
        13400,
      );
    });

    it('cada lote reescreve totalRecipients com o público (não só o 1º)', async () => {
      repo.findById.mockResolvedValue({
        id: 'camp1',
        status: 'RUNNING',
        templateId: 't1',
        defaultInstanceId: 'i1',
        filters: { combinator: 'and', rules: [] },
        variableMap: {},
        purposeKey: 'marketing',
        override: false,
        overrideJustification: null,
        scheduleType: 'IMMEDIATE',
        segmentId: null,
        limit: null,
        totalRecipients: 40,
      } as never);
      templatesRepo.findById.mockResolvedValue({
        id: 't1',
        provider: 'ZERNIO',
        status: 'APPROVED',
        category: 'MARKETING',
      } as never);
      instancesRepo.findById.mockResolvedValue({
        id: 'i1',
        provider: 'ZERNIO',
        isActive: true,
        sentToday: 0,
        dailySendLimit: 500,
      } as never);
      repo.createBatch.mockResolvedValue({
        id: 'b1',
        seq: 2,
        requested: 10,
      } as never);
      repo.finishBatch.mockResolvedValue({} as never);
      repo.groupMessagesByStatus.mockResolvedValue([] as never);
      wireRecipientPages([{ id: 'k1' }]);
      repo.countContactsByWhere.mockImplementation((async (w: unknown) =>
        JSON.stringify(w).includes('"messages"') ? 40 : 13400) as never);
      repo.createMessage.mockResolvedValue({ id: 'm1' } as never);

      await service.sendBatch('camp1', 10);

      expect(repo.updateStatus).toHaveBeenCalledWith('camp1', 'RUNNING', {
        totalRecipients: 13400,
      });
    });
  });

  describe('CampaignsService.preview — excludedInvalid (A.2/B.4)', () => {
  const GRUPO_EXCLUSAO = {
    combinator: 'and' as const,
    rules: [
      {
        combinator: 'or' as const,
        rules: [
          { field: 'whatsappValid' as const, op: 'isNull' as const },
          { field: 'whatsappValid' as const, op: 'eq' as const, value: true },
        ],
      },
      {
        combinator: 'or' as const,
        rules: [
          { field: 'lastFailureReason' as const, op: 'isNull' as const },
          {
            field: 'lastFailureReason' as const,
            op: 'notIn' as const,
            value: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
          },
        ],
      },
    ],
  };

  it('sem o grupo de exclusão, devolve 0 e não faz query a mais', async () => {
    repo.applyAudienceLimit.mockResolvedValue({} as never);
    repo.countContactsByWhere.mockResolvedValue(100);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview({ combinator: 'and', rules: [] });

    expect(r.excludedInvalid).toBe(0);
    // Sem grupo, `preview` só chama countContactsByWhere UMA vez (o `count`
    // do caminho sem bloqueio) — nenhuma query extra para excludedInvalid.
    expect(repo.countContactsByWhere).toHaveBeenCalledTimes(1);
  });

  /**
   * ★ POR QUE A CONTA É "SEM A EXCLUSÃO". O filtro que chega JÁ exclui os
   * inválidos — contá-los na audiência final daria ZERO por construção, e a
   * linha da prévia mostraria "0 inválidos excluídos" para sempre. A conta
   * certa é: na audiência SEM a exclusão, quantos são inválidos?
   */
  it('com o grupo, conta os inválidos da audiência SEM a exclusão', async () => {
    repo.applyAudienceLimit.mockResolvedValue({ optedOut: false } as never);
    repo.findContactsByWhere.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(120);

    const r = await service.preview({
      combinator: 'and',
      rules: [GRUPO_EXCLUSAO],
    });

    expect(r.excludedInvalid).toBe(120);
    // O ARGUMENTO é o que importa (o mock ignora `where`): a contagem cruza a
    // audiência sem exclusão com o predicado de inválido do helper.
    expect(repo.countContactsByWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        AND: expect.arrayContaining([invalidContactWhere()]),
      }),
    );
  });

  /**
   * Review T15 (Needs fixes) — sem isto, com `limit` setado, `excludedInvalid`
   * contava sobre a tabela INTEIRA (sem o corte de id), inflando o `total`
   * que a tela soma (`count + excludedSameTemplate + excludedInvalid`). A
   * regra: contar os inválidos dentro da MESMA janela de id que `base`
   * (count/sample) já usa — a janela que `applyAudienceLimit` calculou.
   */
  it('com limite, conta os inválidos dentro da MESMA janela de id que count/sample usam', async () => {
    const recortada = { AND: [{}, { id: { lte: 'c200' } }] };
    repo.applyAudienceLimit.mockResolvedValue(recortada as any);
    repo.findContactsByWhere.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(30);

    const r = await service.preview(
      { combinator: 'and', rules: [GRUPO_EXCLUSAO] },
      200,
    );

    expect(r.excludedInvalid).toBe(30);
    expect(repo.countContactsByWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        AND: expect.arrayContaining([
          invalidContactWhere(),
          { id: { lte: 'c200' } },
        ]),
      }),
    );
  });

  it('sem limite, a contagem de inválidos NÃO ganha janela de id', async () => {
    repo.applyAudienceLimit.mockResolvedValue({ optedOut: false } as never);
    repo.findContactsByWhere.mockResolvedValue([] as never);
    repo.countContactsByWhere.mockResolvedValue(120);

    await service.preview({ combinator: 'and', rules: [GRUPO_EXCLUSAO] });

    // Nenhuma chamada a countContactsByWhere carrega uma cláusula `id.lte`.
    for (const [arg] of repo.countContactsByWhere.mock.calls) {
      expect(JSON.stringify(arg)).not.toContain('"lte"');
    }
  });

  it('não mexe em excludedSameTemplate, que continua vindo do mesmo lugar', async () => {
    repo.applyAudienceLimit.mockResolvedValue({} as never);
    repo.countContactsByWhere.mockResolvedValue(0);
    repo.findContactsByWhere.mockResolvedValue([] as never);

    const r = await service.preview({ combinator: 'and', rules: [] });
    expect(r.excludedSameTemplate).toBe(0);
  });
  });
});
