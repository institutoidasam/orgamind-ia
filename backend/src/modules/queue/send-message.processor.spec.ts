import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import {
  SendMessageProcessor,
  enrichVariablesWithContact,
} from './send-message.processor';
// I9 — a guarda anti-duplicata deixou de ser uma cópia por transporte: os dois
// caminhos de saída (este worker e o broadcast do Zernio) chamam a MESMA função.
import { duplicateGuardWhere } from '../campaigns/duplicate-guard';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { DomainError } from '../../shared/errors/domain.error';
import type { SendMessageJob } from './queue.constants';
import type { WhatsappInstanceRouter } from '../whatsapp-instances/whatsapp-instance-router.service';
import type { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import type { CampaignsRepository } from '../campaigns/campaigns.repository';

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(),
}));

// Mock pacing helpers so tests don't sleep 10-45 s and we control lock behaviour.
vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn().mockResolvedValue({ acquired: true }),
  releasePacingLock: vi.fn().mockResolvedValue(undefined),
  checkAndPauseBurst: vi.fn().mockResolvedValue(1),
  PACING_JITTER_MIN_MS: 10_000,
  PACING_JITTER_MAX_MS: 45_000,
  PACING_BURST_SIZE: 100,
  PACING_BURST_PAUSE_MS: 300_000,
}));

import * as Sentry from '@sentry/nestjs';
import * as pacingHelper from '../campaigns/pacing.helper';

type PrismaMock = {
  message: {
    findUnique: ReturnType<typeof vi.fn>;
    // K4 — a guarda "esta pessoa já recebeu?" no ato do envio.
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    // K4 — o carimbo de "não enviada para não duplicar" é CONDICIONAL: só pega
    // a linha que ainda está na fila.
    updateMany: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  // C2 — o kill-switch por 132015 marca o template local como PAUSED (o job de
  // sync confirma depois).
  template: {
    update: ReturnType<typeof vi.fn>;
  };
  // ZE — 131026/130472 marcam o CONTATO como inalcançável para MARKETING.
  contact: {
    update: ReturnType<typeof vi.fn>;
  };
};

type WaMock = {
  send: ReturnType<typeof vi.fn>;
  sendVia: ReturnType<typeof vi.fn>;
};

// Maps the legacy provider name used by these fixtures to the ChannelProvider
// enum stored on the resolved instance. T3 decides the anti-ban path by
// `instance.provider`, so the fixtures now carry it.
const PROVIDER_ENUM: Record<
  'meta' | 'evolution' | 'twilio' | 'zernio',
  string
> = {
  evolution: 'EVOLUTION',
  twilio: 'TWILIO',
  meta: 'META',
  zernio: 'ZERNIO',
};

function makeJob(
  data: Partial<SendMessageJob> = {},
  overrides: Partial<Job<SendMessageJob>> = {},
): Job<SendMessageJob> {
  return {
    id: 'job-1',
    data: {
      messageId: 'm1',
      campaignId: 'camp1',
      correlationId: 'corr-1',
      ...data,
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
    ...overrides,
  } as unknown as Job<SendMessageJob>;
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    variables: {},
    // K4 — o desempate da guarda anti-duplicata é (createdAt, id): sem ele,
    // duas linhas em voo se cancelariam mutuamente.
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    // C1 — o gate do dispatch reconsulta consentimento por (contactId,
    // campaign.purposeKey) e supressão por telefone.
    contactId: 'c1',
    instanceId: 'inst-default',
    contact: {
      id: 'c1',
      name: 'Ana',
      city: 'SP',
      group: 'A',
      phoneE164: '+5511999999999',
      optedOut: false,
    },
    campaign: {
      id: 'camp1',
      templateId: 'tpl-1',
      presenceDelayMs: 0,
      defaultInstanceId: 'inst-default',
      status: 'RUNNING',
      purposeKey: 'convite_atividades',
      override: false,
      overrideJustification: null,
      template: {
        metaName: 'tpl_hello',
        language: 'pt_BR',
        body: 'Olá {{nome}}',
        kind: 'TEXT',
        variables: [],
        interactiveConfig: null,
      },
    },
    ...overrides,
  };
}

/** Build a WhatsappInstance-shaped object for mocking the router result. */
function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-default',
    // Default channel provider; overridden per-test / via makeProcessor's
    // provider arg. T3 gates the anti-ban pipeline on this field.
    provider: 'EVOLUTION',
    evolutionInstanceName: 'picoa-dev',
    apiKey: 'k1',
    dailySendLimit: 9999,
    sentToday: 0,
    sentTodayResetAt: new Date(Date.now() - 1000),
    sendWindowEnabled: false,
    sendWindowStartHour: 8,
    sendWindowEndHour: 20,
    globalPresenceDelayMs: 0,
    globalJitterMaxMs: 0,
    ...overrides,
  };
}

type RedisMock = {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  pttl: ReturnType<typeof vi.fn>;
};

/** Build a fully-wired SendMessageProcessor with injectable mocks. */
function makeProcessor(
  instanceOverrides: Record<string, unknown> = {},
  provider: 'meta' | 'evolution' | 'twilio' | 'zernio' = 'evolution',
) {
  const prisma: PrismaMock = {
    message: {
      findUnique: vi.fn(),
      // K4 — padrão: NÃO existe irmã já enviada/em voo para este contato, senão
      // todo teste de envio pararia na guarda anti-duplicata.
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      // K4 — padrão: a escrita condicional PEGA a linha (ela ainda estava na
      // fila). `count: 0` é o caso de corrida, exercitado no teste próprio.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      // T8 rolling-window guard: default = ninguém contatado nas últimas 24h.
      groupBy: vi.fn().mockResolvedValue([]),
    },
    template: {
      update: vi.fn().mockResolvedValue({}),
    },
    contact: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  // T3: production calls `wa.sendVia(channel, input)`. The mock forwards `input`
  // to `wa.send` so every existing single-arg `wa.send` assertion still holds;
  // channel routing (the first arg) is verified by the dedicated sendVia tests.
  const wa: WaMock = { send: vi.fn(), sendVia: vi.fn() };
  wa.sendVia.mockImplementation((_channel: unknown, input: unknown) =>
    (wa.send as unknown as (i: unknown) => unknown)(input),
  );
  const cls = {
    run: <T>(fn: () => T) => fn(),
    set: vi.fn(),
    get: vi.fn(),
  };
  // The resolved instance carries its channel provider (T3 decides the anti-ban
  // path by `instance.provider`). Explicit overrides still win.
  const resolvedInstance = makeInstance({
    provider: PROVIDER_ENUM[provider],
    ...instanceOverrides,
  });
  const router = {
    resolveForSend: vi.fn().mockResolvedValue({
      kind: 'send',
      instance: resolvedInstance,
    }),
  };
  // findById re-reads the instance's CURRENT sentToday inside the pacing lock
  // (Médio fix: the router-resolved value is stale by the time the lock is
  // acquired). Default: echo back the same instance the router resolved so the
  // existing happy-path tests keep their semantics.
  const instancesRepo = {
    incrementSentToday: vi.fn().mockResolvedValue({}),
    resetSentToday: vi.fn().mockResolvedValue({}),
    findById: vi.fn().mockResolvedValue(resolvedInstance),
    // Cloud tier reservation: default to a slot being available so happy-path
    // twilio tests send; the at-cap test overrides this to false.
    reserveSendSlot: vi.fn().mockResolvedValue(true),
    releaseSendSlot: vi.fn().mockResolvedValue(undefined),
  };
  const campaignsRepo = {
    claimForSend: vi.fn().mockResolvedValue(1),
    releaseClaim: vi.fn().mockResolvedValue(1),
    markSent: vi.fn().mockResolvedValue(undefined),
    markWaitingForInstance: vi.fn().mockResolvedValue(1),
  };
  const campaignsService = {
    maybeCompleteCampaign: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  // Redis mock: lock always available by default (pacing helper is mocked at module level)
  const redis: RedisMock = {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    // C2 — TTL do bloqueio de 24h por 131049. -2 = chave inexistente (padrão:
    // destinatário não está bloqueado).
    pttl: vi.fn().mockResolvedValue(-2),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  // C1 — por padrão o destinatário consentiu e não está suprimido; os testes do
  // gate sobrescrevem. (Sem isto, TODO teste de envio pararia no gate — que é o
  // comportamento correto, mas esconderia o que eles realmente testam.)
  const consent = {
    hasConsent: vi.fn().mockResolvedValue(true),
    isSuppressed: vi.fn().mockResolvedValue(false),
    // C2 — o bloqueio de 131049 é chaveado pelo HASH do telefone (nunca pelo
    // número em claro), como a supressão.
    hashOf: vi.fn((phone: string) => `hash(${phone})`),
  };

  // BOLHA VAZIA — o envio de campanha agora liga a Message à Conversation (é o
  // que dá thread, preview e horário na lista lateral) e avisa a inbox ao vivo.
  const chatRepo = {
    linkOutboundCampaignMessage: vi.fn().mockResolvedValue('conv-1'),
  };
  const chatEvents = { publish: vi.fn().mockResolvedValue(undefined) };

  const processor = new SendMessageProcessor(
    prisma as unknown as PrismaService,
    wa as unknown as WhatsappProvidersService,
    cls as never,
    router as unknown as WhatsappInstanceRouter,
    instancesRepo as unknown as WhatsappInstancesRepository,
    campaignsRepo as unknown as CampaignsRepository,
    campaignsService as never,
    redis as never,
    audit as never,
    consent as never,
    chatRepo as never,
    chatEvents as never,
  );

  return {
    consent,

    processor,
    prisma,
    wa,
    router,
    instancesRepo,
    campaignsRepo,
    campaignsService,
    redis,
    audit,
    chatRepo,
    chatEvents,
  };
}

describe('SendMessageProcessor', () => {
  let prisma: PrismaMock;
  let wa: WaMock;
  let proc: SendMessageProcessor;
  let router: { resolveForSend: ReturnType<typeof vi.fn> };
  let instancesRepo: {
    incrementSentToday: ReturnType<typeof vi.fn>;
    resetSentToday: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let campaignsRepo: {
    claimForSend: ReturnType<typeof vi.fn>;
    markSent: ReturnType<typeof vi.fn>;
    markWaitingForInstance: ReturnType<typeof vi.fn>;
  };
  let consent: {
    hasConsent: ReturnType<typeof vi.fn>;
    isSuppressed: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = makeProcessor();
    proc = mocks.processor;
    prisma = mocks.prisma;
    wa = mocks.wa;
    router = mocks.router;
    instancesRepo = mocks.instancesRepo;
    campaignsRepo = mocks.campaignsRepo;
    consent = mocks.consent;
    // default: message found + send succeeds
    prisma.message.findUnique.mockResolvedValue(baseMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'provider-xyz',
      acceptedAt: new Date('2026-05-07T12:00:00.000Z'),
    });
  });

  describe('process()', () => {
    it('returns silently when message is not found', async () => {
      prisma.message.findUnique.mockResolvedValue(null);
      await expect(proc.process(makeJob())).resolves.toBeUndefined();
      expect(wa.send).not.toHaveBeenCalled();
      expect(campaignsRepo.markSent).not.toHaveBeenCalled();
    });

    /**
     * ★ Decisão do cliente, 25/08/2026 — a barreira de ENVIO por
     * `Contact.optedOut` foi removida (risco de LGPD/WhatsApp apresentado e
     * aceito). O booleano é só um CACHE; a fonte da verdade durável
     * (`SuppressionList` por `phoneHash`) continua cancelando, e é o teste
     * logo abaixo que a prova.
     *
     * RED antes desta mudança: `wa.send` não era chamado e a mensagem virava
     * `CANCELLED` / `opted_out`.
     */
    it('optedOut sozinho NÃO cancela mais — sem SuppressionList a mensagem SAI', async () => {
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({ contact: { ...baseMessage().contact, optedOut: true } }),
      );
      consent.isSuppressed.mockResolvedValue(false);

      await proc.process(makeJob());

      expect(wa.send).toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorCode: 'opted_out' }),
        }),
      );
    });

    /**
     * A chave durável continua absoluta mesmo com o cache dizendo `true`: quem
     * cancela é a `SuppressionList`, não o booleano.
     */
    it('optedOut + SuppressionList: a lista durável continua cancelando com "opted_out"', async () => {
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({ contact: { ...baseMessage().contact, optedOut: true } }),
      );
      consent.isSuppressed.mockResolvedValue(true);

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'CANCELLED', errorCode: 'opted_out' },
      });
    });

    /**
     * O gate de consentimento por finalidade é OUTRA regra: liberar o
     * `optedOut` não o transforma em "pode enviar".
     */
    it('optedOut liberado NÃO fura o gate de consentimento — vira SKIPPED_NO_CONSENT', async () => {
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({ contact: { ...baseMessage().contact, optedOut: true } }),
      );
      consent.isSuppressed.mockResolvedValue(false);
      consent.hasConsent.mockResolvedValue(false);

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'SKIPPED_NO_CONSENT', errorCode: 'no_consent' },
      });
    });

    // ── C1: o gate é REAVALIADO no dispatch de cada mensagem ──────────────
    // A materialização da audiência e o envio podem estar separados por SEMANAS
    // (tier de 250 usuários/24h → uma campanha para milhares leva um mês). Quem
    // revogou no dia 3 não pode receber no dia 30.
    it('cancela quando o telefone entrou na SuppressionList DEPOIS da materialização', async () => {
      prisma.message.findUnique.mockResolvedValue(baseMessage());
      // O cache optedOut ainda diz `false` (a linha de Contact foi recriada por
      // uma importação); a SuppressionList — a fonte da verdade — diz que sim.
      consent.isSuppressed.mockResolvedValue(true);

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'CANCELLED', errorCode: 'opted_out' },
      });
    });

    it('vira SKIPPED_NO_CONSENT quando a finalidade foi revogada depois da materialização', async () => {
      prisma.message.findUnique.mockResolvedValue(baseMessage());
      // Revogação PARCIAL: só esta finalidade. O telefone NÃO está suprimido, e
      // por isso a checagem de supressão acima não a veria.
      consent.isSuppressed.mockResolvedValue(false);
      consent.hasConsent.mockResolvedValue(false);

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(consent.hasConsent).toHaveBeenCalledWith('c1', 'convite_atividades');
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'SKIPPED_NO_CONSENT', errorCode: 'no_consent' },
      });
    });

    it('o pulo pelo gate REAVALIA a conclusão da campanha (senão ela trava "Em execução" para sempre)', async () => {
      // GATE SILENCIOSO: o early-return do gate gravava SKIPPED_NO_CONSENT e
      // voltava sem chamar maybeCompleteCampaign. Se a última mensagem em voo
      // for a pulada, ninguém mais reavalia o status da campanha.
      const m = makeProcessor();
      m.prisma.message.findUnique.mockResolvedValue(baseMessage());
      m.consent.isSuppressed.mockResolvedValue(false);
      m.consent.hasConsent.mockResolvedValue(false);

      await m.processor.process(makeJob());

      expect(m.wa.send).not.toHaveBeenCalled();
      expect(m.campaignsService.maybeCompleteCampaign).toHaveBeenCalledWith(
        'camp1',
      );
    });

    it('override de campanha NÃO ressuscita o envio em canal oficial', async () => {
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({
          campaign: {
            ...baseMessage().campaign,
            override: true,
            overrideJustification: 'justificativa longa o suficiente',
          },
        }),
      );
      consent.hasConsent.mockResolvedValue(false);
      // O canal é TWILIO (oficial) → o override é inexprimível.
      prisma.channel = {
        findUnique: vi.fn().mockResolvedValue({ provider: 'TWILIO' }),
      } as never;

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'SKIPPED_NO_CONSENT', errorCode: 'no_consent' },
      });
    });

    it('cancels message when campaign is CANCELLED', async () => {
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({
          campaign: { ...baseMessage().campaign, status: 'CANCELLED' },
        }),
      );
      await proc.process(makeJob());
      expect(wa.send).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { status: 'CANCELLED', errorCode: 'campaign_cancelled' },
      });
    });

    it('TEXT happy path sends and marks message SENT with instanceId', async () => {
      await proc.process(makeJob());

      expect(wa.send).toHaveBeenCalledWith(
        expect.objectContaining({
          toE164: '+5511999999999',
          templateName: 'tpl_hello',
          language: 'pt_BR',
          variables: {},
          body: 'Olá {{nome}}',
          kind: 'TEXT',
          interactiveConfig: null,
          delay: 0,
          evolutionInstanceName: 'picoa-dev',
        }),
      );
      expect(campaignsRepo.markSent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'm1',
          instanceId: 'inst-default',
          providerMessageId: 'provider-xyz',
        }),
      );
      expect(instancesRepo.incrementSentToday).toHaveBeenCalledWith(
        'inst-default',
      );
    });

    it('send uses twilioContentSid as templateName when set', async () => {
      const HX = 'HX0123456789abcdef0123456789abcdef';
      prisma.message.findUnique.mockResolvedValue(
        baseMessage({
          campaign: {
            ...baseMessage().campaign,
            template: {
              ...baseMessage().campaign.template,
              twilioContentSid: HX,
            },
          },
        }),
      );
      await proc.process(makeJob());
      expect(wa.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: HX }),
      );
    });

    it('send falls back to metaName as templateName when twilioContentSid absent', async () => {
      await proc.process(makeJob());
      expect(wa.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: 'tpl_hello' }),
      );
    });

    it('marca WAITING_INSTANCE quando router retorna kind=waiting', async () => {
      router.resolveForSend.mockResolvedValue({
        kind: 'waiting',
        instanceId: 'inst-off',
      });

      await proc.process(makeJob());

      expect(campaignsRepo.markWaitingForInstance).toHaveBeenCalledWith({
        messageId: 'm1',
        instanceId: 'inst-off',
        from: 'QUEUED',
      });
      expect(wa.send).not.toHaveBeenCalled();
    });

    it('não envia e não lança quando markWaitingForInstance devolve count 0 (linha já saiu de QUEUED)', async () => {
      // Outro ator (ex.: um worker que já claimou a linha) já tirou a
      // mensagem do estado QUEUED entre o routing e esta chamada — o
      // updateMany escopado não encontra a linha e devolve 0. Sem instância
      // atribuída de verdade, o send TEM que ser pulado (não lançar: um throw
      // aqui só queimaria o orçamento de retry do BullMQ à toa).
      campaignsRepo.markWaitingForInstance.mockResolvedValue(0);
      router.resolveForSend.mockResolvedValue({
        kind: 'waiting',
        instanceId: 'inst-off',
      });

      await expect(proc.process(makeJob())).resolves.toBeUndefined();

      expect(wa.send).not.toHaveBeenCalled();
    });

    // ── A2 — atomic send claim (the core idempotency guard) ────────────────
    it('claims QUEUED→SENDING atomically before calling wa.send', async () => {
      campaignsRepo.claimForSend.mockResolvedValue(1);

      await proc.process(makeJob());

      expect(campaignsRepo.claimForSend).toHaveBeenCalledWith('m1');
      expect(wa.send).toHaveBeenCalledTimes(1);
    });

    it('SKIPS wa.send when the claim returns 0 (already claimed/sent by another attempt)', async () => {
      // Simulates a BullMQ retry after a successful send (or a sibling attempt
      // that already claimed the row): the row is no longer QUEUED.
      campaignsRepo.claimForSend.mockResolvedValue(0);

      await proc.process(makeJob());

      expect(wa.send).not.toHaveBeenCalled();
      expect(campaignsRepo.markSent).not.toHaveBeenCalled();
      expect(instancesRepo.incrementSentToday).not.toHaveBeenCalled();
    });

    it('does NOT claim before there is an instance (WAITING_INSTANCE branch keeps working)', async () => {
      router.resolveForSend.mockResolvedValue({
        kind: 'waiting',
        instanceId: 'inst-off',
      });

      await proc.process(makeJob());

      expect(campaignsRepo.claimForSend).not.toHaveBeenCalled();
      expect(campaignsRepo.markWaitingForInstance).toHaveBeenCalled();
      expect(wa.send).not.toHaveBeenCalled();
    });

    it('envia via instância resolvida e atualiza Message.instanceId', async () => {
      const instance = makeInstance({
        id: 'inst-a',
        evolutionInstanceName: 'evo-a',
        apiKey: 'k',
        dailySendLimit: 500,
        sentToday: 0,
        sendWindowEnabled: false,
      });
      router.resolveForSend.mockResolvedValue({ kind: 'send', instance });
      // The processor re-reads the instance inside the pacing lock — mirror the
      // router's resolved instance so the fresh read matches.
      instancesRepo.findById.mockResolvedValue(instance);
      wa.send.mockResolvedValue({
        providerMessageId: 'wamid',
        acceptedAt: new Date(),
      });

      await proc.process(makeJob());

      expect(wa.send).toHaveBeenCalledWith(
        expect.objectContaining({ evolutionInstanceName: 'evo-a' }),
      );
      expect(campaignsRepo.markSent).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', instanceId: 'inst-a' }),
      );
      expect(instancesRepo.incrementSentToday).toHaveBeenCalledWith('inst-a');
    });

    it.each(['LIST', 'BUTTONS', 'POLL'] as const)(
      '%s kind passes interactiveConfig through to wa.send',
      async (kind) => {
        const interactiveConfig = { sections: [{ title: 'Pick' }] };
        const msg = baseMessage();
        msg.campaign.template = {
          ...msg.campaign.template,
          kind,
          interactiveConfig,
        };
        prisma.message.findUnique.mockResolvedValue(msg);

        await proc.process(makeJob());

        expect(wa.send).toHaveBeenCalledWith(
          expect.objectContaining({ kind, interactiveConfig }),
        );
      },
    );

    it('auto-fills missing template variables from contact data', async () => {
      const msg = baseMessage({
        variables: {},
        contact: {
          id: 'c1',
          name: 'Ana',
          city: 'SP',
          group: null,
          phoneE164: '+5511888887777',
          optedOut: false,
        },
      });
      msg.campaign.template = {
        ...msg.campaign.template,
        variables: ['nome', 'cidade'],
      };
      prisma.message.findUnique.mockResolvedValue(msg);

      await proc.process(makeJob());

      expect(wa.send).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { nome: 'Ana', cidade: 'SP' } }),
      );
    });

    it('marks FAILED without throwing when WhatsappSendError is fatal', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'session closed',
          'session_closed',
          'Provider session closed',
          true,
        ),
      );

      await expect(proc.process(makeJob())).resolves.toBeUndefined();

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'session_closed',
          errorMessage: 'session closed',
          failedAt: expect.any(Date),
        }),
      });
    });

    it('marks FAILED for fatal-by-meta-code without throwing', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'meta said no',
          '131026',
          'Message Undeliverable',
          false,
        ),
      );

      await expect(proc.process(makeJob())).resolves.toBeUndefined();

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: '131026',
        }),
      });
    });

    // ZE — 130472 ("marketing-message experiment") não era conhecido por NENHUM
    // dos dois caminhos de fatalidade: nem o mapper do Zernio, nem este Set. Um
    // adapter que reporte fatal=false (ou um provedor sem mapper próprio, como o
    // META) deixava o 130472 ser RETENTADO 5x contra uma parede. Aqui garantimos
    // a rede de segurança: o código sozinho já basta para terminalizar.
    it('marks FAILED for 130472 (experimento de marketing da Meta) sem retentar', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'meta said no',
          '130472',
          'Marketing message experiment',
          false,
        ),
      );

      await expect(proc.process(makeJob())).resolves.toBeUndefined();

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: '130472',
        }),
      });
    });

    // ZE — o código pode chegar TAMBÉM pela resposta do POST de envio (o adapter
    // do Zernio mapeia o platformError inline), não só pelo webhook de status.
    // Os dois caminhos precisam gravar o mesmo estado no contato.
    it('marca o contato como inalcançável para MARKETING quando o envio falha com 130472', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError('meta said no', '130472', 'experiment', true),
      );

      await proc.process(makeJob());

      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            marketingUndeliverableCode: '130472',
            marketingUndeliverableAt: expect.any(Date),
          }),
        }),
      );
    });

    it('NÃO marca o contato como inalcançável para MARKETING numa falha fatal que não é de marketing', async () => {
      // 132001 (template não aprovado) é falha da CAMPANHA, não do destinatário.
      wa.send.mockRejectedValue(
        new WhatsappSendError('no template', '132001', 'not found', true),
      );

      await proc.process(makeJob());

      // F2 — o contact.update AINDA roda (failureCount incrementa em toda
      // falha), mas sem os campos marketingUndeliverable* (essa falha é do
      // CATÁLOGO/template, não uma preferência do destinatário).
      expect(prisma.contact.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            marketingUndeliverableCode: expect.anything(),
          }),
        }),
      );
    });

    // F2 — classifyFailure roda ANTES do ramo específico de marketing e grava
    // o motivo normalizado na Message; a flag durável do Contact (failureCount
    // sempre, lastFailure* só se definitiva) é gravada best-effort logo após.
    it('F2: grava failureReason na Message e failureCount no Contact numa falha fatal não permanente', async () => {
      // 132001 → TEMPLATE_INDISPONIVEL; não é falha PERMANENTE do destinatário,
      // então só failureCount incrementa (sem lastFailureReason/Code/At).
      wa.send.mockRejectedValue(
        new WhatsappSendError('no template', '132001', 'not found', true),
      );

      await proc.process(makeJob());

      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: '132001',
            failureReason: 'TEMPLATE_INDISPONIVEL',
          }),
        }),
      );
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { failureCount: { increment: 1 } },
      });
    });

    // F2 — falha PERMANENTE do destinatário (opted_out/recipient_opted_out):
    // a flag durável GRAVA lastFailureReason/Code/At, não só failureCount.
    it('F2: grava lastFailureReason/Code/At no Contact numa falha permanente do destinatário', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'recusado pelo destinatário',
          'recipient_opted_out',
          'opted out',
          true,
        ),
      );

      await proc.process(makeJob());

      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: {
          failureCount: { increment: 1 },
          lastFailureReason: 'OPT_OUT',
          lastFailureCode: 'recipient_opted_out',
          lastFailureAt: expect.any(Date),
        },
      });
    });

    it('rethrows non-fatal WhatsappSendError so BullMQ can retry', async () => {
      const err = new WhatsappSendError(
        'transient',
        'rate_limit',
        'Too fast',
        false,
      );
      wa.send.mockRejectedValue(err);

      await expect(proc.process(makeJob())).rejects.toBe(err);

      // Should NOT mark FAILED (let onFailed handle that after retries exhausted)
      expect(campaignsRepo.markSent).not.toHaveBeenCalled();
      // DomainError → no Sentry capture
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('parks WAITING_INSTANCE (no throw, no FAILED) when send fails with evolution.not_connected', async () => {
      // The instance disconnected mid-send; the 5-attempt/62s BullMQ budget can't
      // outlast a real disconnect, so instead of burning it we park the message
      // for reconnect-replay to re-enqueue once the instance reconnects.
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'not connected',
          'evolution.not_connected',
          'WhatsApp not connected',
          false,
        ),
      );

      await expect(proc.process(makeJob())).resolves.toBeUndefined();

      expect(campaignsRepo.markWaitingForInstance).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', from: 'SENDING' }),
      );
      // Not permanently failed, and not re-thrown for a doomed BullMQ retry.
      expect(prisma.message.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('não lança quando markWaitingForInstance (pós-claim) devolve count 0 — a linha já saiu de SENDING', async () => {
      // Ex.: o reconciler já recuperou a linha (SENDING→FAILED) entre o claim
      // e este catch. O updateMany escopado a SENDING não a encontra (count 0)
      // — o worker só loga e retorna, nunca lança (queimaria o retry à toa).
      campaignsRepo.markWaitingForInstance.mockResolvedValue(0);
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'not connected',
          'evolution.not_connected',
          'WhatsApp not connected',
          false,
        ),
      );

      await expect(proc.process(makeJob())).resolves.toBeUndefined();
    });

    // A2 — a retryable failure leaves the row in SENDING (we claimed it). It
    // must be returned to QUEUED so BullMQ's retry can re-claim and re-send;
    // otherwise the retry would hit claim count=0 and silently skip forever.
    it('releases the claim (SENDING→QUEUED) on a retryable error so the retry can re-send', async () => {
      const err = new WhatsappSendError(
        'transient',
        'rate_limit',
        'Too fast',
        false,
      );
      wa.send.mockRejectedValue(err);

      await expect(proc.process(makeJob())).rejects.toBe(err);

      expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('m1');
    });

    it('does NOT release the claim on a fatal error (it goes straight to FAILED)', async () => {
      wa.send.mockRejectedValue(
        new WhatsappSendError(
          'session closed',
          'session_closed',
          'closed',
          true,
        ),
      );

      await proc.process(makeJob());

      expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('captures Sentry and rethrows on generic Error', async () => {
      const err = new Error('boom');
      wa.send.mockRejectedValue(err);

      await expect(proc.process(makeJob())).rejects.toBe(err);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: expect.objectContaining({
            messageId: 'm1',
            correlationId: 'corr-1',
          }),
        }),
      );
      expect(campaignsRepo.markSent).not.toHaveBeenCalled();
    });

    it('does NOT capture Sentry for non-Whatsapp DomainError', async () => {
      const err = new DomainError({ code: 'something.else', message: 'nope' });
      wa.send.mockRejectedValue(err);

      await expect(proc.process(makeJob())).rejects.toBe(err);

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('handles legacy jobs without correlationId', async () => {
      await proc.process(makeJob({ correlationId: undefined }));
      expect(wa.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('onFailed()', () => {
    it('marks FAILED when retries are exhausted (WhatsappSendError → errorCode set)', async () => {
      const err = new WhatsappSendError(
        'final boom',
        'rate_limit',
        'Too fast',
        false,
      );
      const job = makeJob({}, { attemptsMade: 5 } as never);

      await proc.onFailed(job, err);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'rate_limit',
          errorMessage: 'final boom',
          failedAt: expect.any(Date),
          // F2 — 'rate_limit' não bate em nenhum código conhecido → OUTRO.
          failureReason: 'OUTRO',
        }),
      });
    });

    // F2 — onFailed não tem provider/contactId no escopo (job.data só carrega
    // messageId/campaignId/correlationId), mas ainda classifica o código.
    it('F2: grava failureReason classificado quando o código é conhecido', async () => {
      const err = new WhatsappSendError(
        'esgotou retries',
        'sending_stuck',
        'stuck',
        false,
      );
      const job = makeJob({}, { attemptsMade: 5 } as never);

      await proc.onFailed(job, err);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          errorCode: 'sending_stuck',
          failureReason: 'INDETERMINADO',
        }),
      });
    });

    // U4 — prod incident: router failures are DomainErrors (e.g.
    // 'campaign.default_instance_inactive'), thrown BEFORE the try/catch, so
    // they surface here via BullMQ. Their .code must be persisted into
    // Message.errorCode instead of being dropped (errorCode=NULL in prod).
    it('marks FAILED persisting DomainError.code as errorCode when retries are exhausted', async () => {
      const err = new DomainError({
        code: 'campaign.default_instance_inactive',
        message: 'Campaign default instance has been deleted',
      });
      const job = makeJob({}, { attemptsMade: 5 } as never);

      await proc.onFailed(job, err);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'campaign.default_instance_inactive',
          errorMessage: 'Campaign default instance has been deleted',
          failedAt: expect.any(Date),
          // CANAL_FORA, não OUTRO: `campaign.default_instance_inactive` entrou
          // em CANAL_FORA_CODES (failure-reason.ts) no review do F2 — a
          // instância padrão foi soft-deleted e não há outra ativa, ou seja, o
          // canal está fora, nada a ver com ESTE destinatário. A asserção aqui
          // era incidental (o foco do teste, ver comentário U4 acima, é o
          // errorCode ser PERSISTIDO em vez de virar NULL) e ficou para trás
          // porque nenhuma rodada de teste do F2 cobriu src/modules/queue.
          failureReason: 'CANAL_FORA',
        }),
      });
    });

    // WhatsappSendError extends DomainError, so the extraction must check it
    // FIRST: its providerErrorCode (not the generic 'whatsapp.send_failed'
    // DomainError code) is the value operators need to see.
    it('prefers providerErrorCode over DomainError.code for WhatsappSendError', async () => {
      const err = new WhatsappSendError(
        'boom',
        'rate_limit',
        'Too fast',
        false,
      );
      const job = makeJob({}, { attemptsMade: 5 } as never);

      await proc.onFailed(job, err);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({ errorCode: 'rate_limit' }),
      });
    });

    it('marks FAILED with null errorCode for plain Error', async () => {
      const err = new Error('plain boom');
      const job = makeJob({}, { attemptsMade: 5 } as never);

      await proc.onFailed(job, err);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: undefined,
          errorMessage: 'plain boom',
        }),
      });
    });

    it('does nothing when attempts are not yet exhausted', async () => {
      const job = makeJob({}, { attemptsMade: 2 } as never);
      await proc.onFailed(job, new Error('still trying'));
      expect(prisma.message.update).not.toHaveBeenCalled();
    });

    it('falls back to default attempts (1) when opts.attempts is undefined', async () => {
      const job = makeJob({}, { attemptsMade: 5, opts: {} } as never);
      await proc.onFailed(job, new Error('default attempts'));
      expect(prisma.message.update).toHaveBeenCalled();
    });

    it('logs but does not throw when the FAILED update itself fails', async () => {
      prisma.message.update.mockRejectedValueOnce(new Error('db down'));
      const job = makeJob({}, { attemptsMade: 5 } as never);
      await expect(
        proc.onFailed(job, new Error('original')),
      ).resolves.toBeUndefined();
    });
  });
});

describe('enrichVariablesWithContact()', () => {
  const contact = {
    name: 'Ana',
    city: 'SP',
    group: 'GroupA',
    phoneE164: '+5511999999999',
  };

  it('does NOT overwrite variables already present in current', () => {
    const out = enrichVariablesWithContact(
      { nome: 'Maria' },
      ['nome'],
      contact,
    );
    expect(out.nome).toBe('Maria');
  });

  it.each([
    'nome',
    'name',
    'cliente',
    'contato',
    'destinatario',
    'NomeCompleto',
  ])('maps "%s" → contact.name', (key) => {
    expect(enrichVariablesWithContact({}, [key], contact)[key]).toBe('Ana');
  });

  it.each(['cidade', 'city', 'local'])('maps "%s" → contact.city', (key) => {
    expect(enrichVariablesWithContact({}, [key], contact)[key]).toBe('SP');
  });

  it.each(['grupo', 'group', 'categoria'])(
    'maps "%s" → contact.group',
    (key) => {
      expect(enrichVariablesWithContact({}, [key], contact)[key]).toBe(
        'GroupA',
      );
    },
  );

  it.each(['tel', 'phone', 'fone', 'whats'])(
    'maps "%s" → contact.phoneE164',
    (key) => {
      expect(enrichVariablesWithContact({}, [key], contact)[key]).toBe(
        '+5511999999999',
      );
    },
  );

  it('falls back to empty string when no rule matches', () => {
    expect(
      enrichVariablesWithContact({}, ['unknown_var'], contact).unknown_var,
    ).toBe('');
  });

  it('uses empty string when contact.name is null', () => {
    expect(
      enrichVariablesWithContact({}, ['nome'], { ...contact, name: null }).nome,
    ).toBe('');
  });

  it('uses empty string when contact.city is null', () => {
    expect(
      enrichVariablesWithContact({}, ['cidade'], { ...contact, city: null })
        .cidade,
    ).toBe('');
  });

  it('uses empty string when contact.group is null', () => {
    expect(
      enrichVariablesWithContact({}, ['grupo'], { ...contact, group: null })
        .grupo,
    ).toBe('');
  });
});

// ── Anti-ban tests ──────────────────────────────────────────────────────────

function makeAntiBanJob(overrides = {}): Job {
  return {
    id: 'job-1',
    data: { messageId: 'msg-1', campaignId: 'camp1', correlationId: 'corr-1' },
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job;
}

function makeAntiBanMessage(campaignOverrides = {}) {
  return {
    id: 'msg-1',
    variables: {},
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    contact: {
      id: 'co1',
      optedOut: false,
      phoneE164: '+5511999990000',
      name: 'Test',
      city: null,
      group: null,
    },
    campaign: {
      id: 'camp1',
      templateId: 'tpl1',
      presenceDelayMs: 0,
      defaultInstanceId: 'inst-default',
      status: 'RUNNING',
      template: {
        id: 'tpl1',
        metaName: 't',
        language: 'pt_BR',
        body: 'hello',
        variables: [],
        kind: 'TEXT',
        interactiveConfig: null,
      },
      ...campaignOverrides,
    },
  };
}

describe('SendMessageProcessor — daily limit', () => {
  it('moves job to delayed (next reset) when sentToday >= dailySendLimit', async () => {
    const resetAt = new Date(Date.now() - 1000); // reset happened ~1s ago
    const { processor, prisma, wa } = makeProcessor({
      sentToday: 500,
      dailySendLimit: 500,
      sentTodayResetAt: resetAt,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    // Should be approximately 24h from now (within a 5s tolerance)
    const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(delayedMs - expectedMs)).toBeLessThanOrEqual(5_000);
    expect(wa.send).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('does NOT fail message when sentToday < dailySendLimit', async () => {
    const { processor, prisma, wa, instancesRepo } = makeProcessor({
      sentToday: 499,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(instancesRepo.incrementSentToday).toHaveBeenCalledWith(
      'inst-default',
    );
  });

  // ── Médio: read-then-act reservation ──────────────────────────────────────
  // The router-resolved instance is read BEFORE the pacing lock is held, so its
  // sentToday is stale by the time we're about to send. Several jobs can all
  // pass the limit check with the same stale value and then send one-by-one
  // through the lock — blowing past dailySendLimit. The fix re-reads sentToday
  // inside the pacing-lock critical section.
  it('re-reads sentToday INSIDE the pacing lock and delays when the fresh value hits the cap', async () => {
    // Router resolves a stale snapshot under the limit…
    const { processor, prisma, wa, instancesRepo } = makeProcessor({
      sentToday: 0,
      dailySendLimit: 500,
      sendWindowEnabled: false,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    // …but the CURRENT (fresh) row is already at the cap because sibling jobs
    // incremented it while this job sat in the queue.
    instancesRepo.findById.mockResolvedValue(
      makeInstance({
        sentToday: 500,
        dailySendLimit: 500,
        sendWindowEnabled: false,
      }),
    );
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    // Must NOT send — the fresh read shows the cap is reached.
    expect(wa.send).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    // And must not double-count the daily counter.
    expect(instancesRepo.incrementSentToday).not.toHaveBeenCalled();
  });

  it('re-reads sentToday inside the lock and proceeds when the fresh value is still under the cap', async () => {
    const { processor, prisma, wa, instancesRepo } = makeProcessor({
      sentToday: 0,
      dailySendLimit: 500,
      sendWindowEnabled: false,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    instancesRepo.findById.mockResolvedValue(
      makeInstance({
        sentToday: 499,
        dailySendLimit: 500,
        sendWindowEnabled: false,
      }),
    );
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(instancesRepo.incrementSentToday).toHaveBeenCalledWith(
      'inst-default',
    );
  });

  it('resets sentToday and proceeds when sentTodayResetAt is older than 24h', async () => {
    const oldReset = new Date(Date.now() - 25 * 60 * 60 * 1000);
    // sentToday=600 → exceeds limit IF not reset; after reset sentToday becomes 0 → should send
    const { processor, prisma, wa, instancesRepo, router } = makeProcessor({
      sentToday: 600,
      dailySendLimit: 500,
      sentTodayResetAt: oldReset,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    // After reset, router re-resolves with sentToday=0
    instancesRepo.resetSentToday.mockResolvedValue({});
    // The processor re-calls resolveForSend after reset to get fresh instance data
    router.resolveForSend
      .mockResolvedValueOnce({
        kind: 'send',
        instance: makeInstance({
          sentToday: 600,
          dailySendLimit: 500,
          sentTodayResetAt: oldReset,
        }),
      })
      .mockResolvedValueOnce({
        kind: 'send',
        instance: makeInstance({
          sentToday: 0,
          dailySendLimit: 500,
          sentTodayResetAt: new Date(),
        }),
      });
    // The post-lock re-read reflects the reset (sentToday=0), under the cap.
    instancesRepo.findById.mockResolvedValue(
      makeInstance({
        sentToday: 0,
        dailySendLimit: 500,
        sentTodayResetAt: new Date(),
      }),
    );

    await processor.process(makeAntiBanJob());

    expect(instancesRepo.resetSentToday).toHaveBeenCalledTimes(1);
    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  // ── 3º chamador de markWaitingForInstance: pós-reset diário ─────────────────
  // O re-resolve feito logo após o reset (linha ~523) pode, ele também, devolver
  // kind=waiting — a instância que zerou o contador pode ter ficado indisponível
  // entre o reset e o re-resolve. Espelha os dois testes do 1º chamador
  // (~485-516), mas força o caminho de reset diário: 1ª chamada a
  // resolveForSend devolve kind=send com sentTodayResetAt vencido (dispara o
  // reset); 2ª chamada (pós-reset) devolve kind=waiting.
  it('marca WAITING_INSTANCE (pós-reset diário) quando o re-resolve devolve kind=waiting', async () => {
    const oldReset = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { processor, prisma, wa, instancesRepo, router, campaignsRepo } =
      makeProcessor({
        sentToday: 600,
        dailySendLimit: 500,
        sentTodayResetAt: oldReset,
      });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    instancesRepo.resetSentToday.mockResolvedValue({});
    router.resolveForSend
      .mockResolvedValueOnce({
        kind: 'send',
        instance: makeInstance({
          sentToday: 600,
          dailySendLimit: 500,
          sentTodayResetAt: oldReset,
        }),
      })
      .mockResolvedValueOnce({
        kind: 'waiting',
        instanceId: 'inst-off',
      });

    await processor.process(makeAntiBanJob());

    expect(instancesRepo.resetSentToday).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.markWaitingForInstance).toHaveBeenCalledWith({
      messageId: 'msg-1',
      instanceId: 'inst-off',
      from: 'QUEUED',
    });
    expect(wa.send).not.toHaveBeenCalled();
  });

  it('não envia e não lança (pós-reset diário) quando markWaitingForInstance devolve count 0', async () => {
    const oldReset = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { processor, prisma, wa, instancesRepo, router, campaignsRepo } =
      makeProcessor({
        sentToday: 600,
        dailySendLimit: 500,
        sentTodayResetAt: oldReset,
      });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    instancesRepo.resetSentToday.mockResolvedValue({});
    campaignsRepo.markWaitingForInstance.mockResolvedValue(0);
    router.resolveForSend
      .mockResolvedValueOnce({
        kind: 'send',
        instance: makeInstance({
          sentToday: 600,
          dailySendLimit: 500,
          sentTodayResetAt: oldReset,
        }),
      })
      .mockResolvedValueOnce({
        kind: 'waiting',
        instanceId: 'inst-off',
      });

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe('SendMessageProcessor — send window', () => {
  /**
   * Helper: instância com sendWindowEnabled, simulando uma hora LOCAL DE MANAUS.
   *
   * C3 — era `spHour + 3` (America/Sao_Paulo, UTC-3). A janela existe para não
   * incomodar o DESTINATÁRIO, e o destinatário está em Manaus: UTC-4, sem
   * horário de verão (por isso o offset é uma constante, e não uma tabela).
   * As campanhas destes testes não gravam fuso → caem no default, Manaus.
   */
  function makeWindowSetup(localHour: number, startHour: number, endHour: number) {
    const utcHour = (localHour + 4) % 24;
    const d = new Date();
    d.setUTCHours(utcHour, 0, 0, 0);
    return {
      currentTime: d,
      instanceOverrides: {
        sendWindowEnabled: true,
        sendWindowStartHour: startHour,
        sendWindowEndHour: endHour,
        sentToday: 0,
        dailySendLimit: 500,
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adia quando a hora LOCAL (Manaus) está fora da janela [8, 20)', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(6, 8, 20);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(delayedMs).toBeGreaterThan(Date.now());
    expect(wa.send).not.toHaveBeenCalled();
  });

  it('adia para as 8:00 locais de AMANHÃ quando a hora local é 21', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(21, 8, 20);
    const { processor, prisma } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    // Local 21:00 hoje → as 8:00 locais de amanhã são +11h.
    const expectedMs = currentTime.getTime() + 11 * 60 * 60 * 1000;
    expect(Math.abs(delayedMs - expectedMs)).toBeLessThanOrEqual(5_000);
  });

  it('adia para as 8:00 locais de HOJE quando a hora local é 6', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(6, 8, 20);
    const { processor, prisma } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    // Local 06:00 → as 8:00 de hoje são +2h.
    const expectedMs = currentTime.getTime() + 2 * 60 * 60 * 1000;
    expect(Math.abs(delayedMs - expectedMs)).toBeLessThanOrEqual(5_000);
  });

  /**
   * C3 (bônus) — O FUSO DA JANELA ANTI-BAN.
   *
   * A janela existe para não incomodar o DESTINATÁRIO, e o destinatário do
   * IDASAM está em MANAUS (UTC-4, sem horário de verão). Com o fuso fixo em
   * America/Sao_Paulo (UTC-3), uma janela configurada como "8h–20h" abria às
   * **07:00 locais** em Manaus: uma hora mais cedo, todos os dias — exatamente
   * o tipo de irritação que faz a pessoa tocar em "Denunciar", que é o
   * mecanismo real de ban.
   *
   * UTC 11:00 é o instante que separa as duas leituras: 08:00 em SP (DENTRO da
   * janela) e 07:00 em Manaus (FORA).
   */
  function atUtc(hour: number) {
    const d = new Date();
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }

  it('UTC 11:00 = 07:00 em Manaus → FORA da janela [8,20): adia (antes disparava, lendo 08:00 em SP)', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: true,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ timezone: 'America/Manaus' }),
    );
    const job = makeAntiBanJob();
    const now = atUtc(11);
    vi.setSystemTime(now);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(wa.send).not.toHaveBeenCalled();
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    // Manaus 07:00 → a janela abre às 08:00 locais = UTC 12:00 = +1h.
    expect(Math.abs(delayedMs - (now.getTime() + 60 * 60 * 1000))).toBeLessThanOrEqual(5_000);
  });

  it('UTC 12:00 = 08:00 em Manaus → DENTRO da janela: envia', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: true,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ timezone: 'America/Manaus' }),
    );
    wa.send.mockResolvedValue({ providerMessageId: 'p1', status: 'SENT' });
    const job = makeAntiBanJob();
    vi.setSystemTime(atUtc(12));

    await processor.process(job);

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(wa.send).toHaveBeenCalled();
  });

  /**
   * O fuso vem da CAMPANHA, não de uma constante: uma campanha gravada
   * explicitamente em America/Sao_Paulo (o default antigo) continua sendo
   * avaliada NAQUELE fuso — mudar o default não pode mover a janela de uma
   * campanha que alguém já configurou.
   */
  it('respeita o fuso GRAVADO na campanha: America/Sao_Paulo às UTC 11:00 = 08:00 SP → envia', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: true,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ timezone: 'America/Sao_Paulo' }),
    );
    wa.send.mockResolvedValue({ providerMessageId: 'p1', status: 'SENT' });
    const job = makeAntiBanJob();
    vi.setSystemTime(atUtc(11));

    await processor.process(job);

    expect(wa.send).toHaveBeenCalled();
  });

  /** Campanha legada sem fuso gravado → cai no default de quem opera: Manaus. */
  it('campanha sem timezone → usa America/Manaus (o fuso de quem opera o orgamind)', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: true,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage()); // sem timezone
    const job = makeAntiBanJob();
    vi.setSystemTime(atUtc(11)); // 07:00 em Manaus → fora

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(wa.send).not.toHaveBeenCalled();
  });

  it('does not delay when hour is inside window', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(10, 8, 20);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    vi.setSystemTime(currentTime);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('does not delay when sendWindowEnabled is false', async () => {
    const { currentTime } = makeWindowSetup(3, 8, 20);
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    vi.setSystemTime(currentTime);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  /**
   * ★ Pedido do cliente 2026-08-25 — `Campaign.respeitarJanelaDeEnvio: false`
   * é o botão explícito do operador para esta campanha ignorar a janela,
   * mesmo em canal de SESSÃO (onde a janela de fato se aplica) e mesmo fora
   * do intervalo configurado. Antes deste campo existir isto era impossível
   * de expressar por campanha — só existia o liga/desliga POR CANAL
   * (`sendWindowEnabled`).
   */
  it('respeitarJanelaDeEnvio: false ignora a janela mesmo fora do intervalo, em canal de sessão', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(6, 8, 20);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ respeitarJanelaDeEnvio: false }),
    );
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    vi.setSystemTime(currentTime);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  /**
   * O default (`respeitarJanelaDeEnvio` ausente/true, o comportamento de
   * sempre) continua adiando fora da janela — RED antes de `respeitaJanela`
   * existir seria "sempre adia"; este teste prova que o default não regrediu.
   */
  it('respeitarJanelaDeEnvio ausente (default true) continua adiando fora da janela', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(6, 8, 20);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(wa.send).not.toHaveBeenCalled();
  });

  // ── BullMQ deferral contract (finding 2) ──────────────────────────────────
  // A processor that defers a job MUST call job.moveToDelayed(ts, token) and
  // then throw DelayedError, otherwise BullMQ tries to moveToCompleted a job
  // that is no longer active ("Missing lock for job …") and re-emits it as an
  // unhandled worker 'error'. The worker token must be forwarded so the job
  // isn't removed from the active set.
  it('forwards the worker token to moveToDelayed and throws DelayedError when outside the window', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(6, 8, 20);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job, 'tok-abc')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      'tok-abc',
    );
    expect(wa.send).not.toHaveBeenCalled();
  });

  // ── Wrap-aware window (finding 1) ─────────────────────────────────────────
  // start > end is an overnight window (e.g. 22h–06h). The non-wrapping test
  // `h < start || h >= end` is true for ALL hours in that case, so every
  // message would be deferred forever. The comparison must wrap.
  it('sends when the SP hour is inside an overnight window [22, 6)', async () => {
    const { currentTime, instanceOverrides } = makeWindowSetup(23, 22, 6);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await processor.process(job);

    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("defers to TODAY's start (not a perpetual tomorrow loop) when outside an overnight window", async () => {
    // SP 12:00, overnight window 22h–06h → next start is today at 22:00 (+10h).
    const { currentTime, instanceOverrides } = makeWindowSetup(12, 22, 6);
    const { processor, prisma, wa } = makeProcessor(instanceOverrides);
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();
    vi.setSystemTime(currentTime);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    const expectedMs = currentTime.getTime() + 10 * 60 * 60 * 1000;
    expect(Math.abs(delayedMs - expectedMs)).toBeLessThanOrEqual(5_000);
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe('SendMessageProcessor — worker error handler (finding 2)', () => {
  it('registers an onError handler that captures the error to Sentry', async () => {
    const { processor } = makeProcessor();
    const err = new Error('transient worker error');
    await processor.onError(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });
});

describe('SendMessageProcessor — pacing + jitter', () => {
  it('uses max(campaign.presenceDelayMs, globalPresenceDelayMs) as base delay', async () => {
    const { processor, prisma, wa } = makeProcessor({
      globalPresenceDelayMs: 4000,
      globalJitterMaxMs: 0,
      sendWindowEnabled: false,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ presenceDelayMs: 2000 }),
    );
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledWith(
      expect.objectContaining({ delay: 4000 }),
    );
  });

  it('campaign presenceDelayMs wins when it is greater than global', async () => {
    const { processor, prisma, wa } = makeProcessor({
      globalPresenceDelayMs: 1000,
      globalJitterMaxMs: 0,
      sendWindowEnabled: false,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ presenceDelayMs: 3000 }),
    );
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledWith(
      expect.objectContaining({ delay: 3000 }),
    );
  });

  it('adds random jitter within [0, globalJitterMaxMs]', async () => {
    const JITTER_MAX = 5000;
    const { processor, prisma, wa } = makeProcessor({
      globalPresenceDelayMs: 1000,
      globalJitterMaxMs: JITTER_MAX,
      sendWindowEnabled: false,
    });
    prisma.message.findUnique.mockResolvedValue(
      makeAntiBanMessage({ presenceDelayMs: 0 }),
    );
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    const calledDelay = wa.send.mock.calls[0][0].delay as number;
    expect(calledDelay).toBeGreaterThanOrEqual(1000);
    expect(calledDelay).toBeLessThanOrEqual(1000 + JITTER_MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-instance concurrency lock integration tests
// These verify the processor's interaction with pacing helpers.
// ─────────────────────────────────────────────────────────────────────────────

describe('SendMessageProcessor — per-instance pacing lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset pacing mock to default (lock always acquired, no burst)
    vi.mocked(pacingHelper.acquirePacingLock).mockResolvedValue({
      acquired: true,
    });
    vi.mocked(pacingHelper.releasePacingLock).mockResolvedValue(undefined);
    vi.mocked(pacingHelper.checkAndPauseBurst).mockResolvedValue(1);
  });

  it('delays job when pacing lock is already held', async () => {
    vi.mocked(pacingHelper.acquirePacingLock).mockResolvedValue({
      acquired: false,
      retryDelayMs: 5_000,
    });

    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedEpoch = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(Math.abs(delayedEpoch - (Date.now() + 5_000))).toBeLessThanOrEqual(
      1_000,
    );
    expect(wa.send).not.toHaveBeenCalled();
    // Lock was NOT acquired, so release should NOT be called
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
  });

  it('acquires lock and calls releasePacingLock after successful send', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(pacingHelper.acquirePacingLock).toHaveBeenCalledWith(
      expect.anything(), // redis client
      'inst-default',
    );
    expect(wa.send).toHaveBeenCalledTimes(1);
    // Jitter sleep lock release should be called after successful send
    expect(pacingHelper.releasePacingLock).toHaveBeenCalledWith(
      expect.anything(),
      'inst-default',
      expect.anything(), // logger
    );
  });

  it('releases lock immediately (no sleep) and does NOT call releasePacingLock after fatal error', async () => {
    const { processor, prisma, wa, redis } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('fatal', 'session_closed', 'closed', true),
    );

    await processor.process(makeAntiBanJob());

    // Fatal error → message marked FAILED
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    // No jitter sleep release — lock is DEL'd directly
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });

  it('releases lock immediately (no sleep) and does NOT call releasePacingLock on retryable error', async () => {
    const { processor, prisma, wa, redis } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const err = new WhatsappSendError(
      'transient',
      'rate_limit',
      'too fast',
      false,
    );
    wa.send.mockRejectedValue(err);

    await expect(processor.process(makeAntiBanJob())).rejects.toBe(err);

    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });

  it('calls checkAndPauseBurst after successful send', async () => {
    const { processor, prisma, wa } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'p1',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(pacingHelper.checkAndPauseBurst).toHaveBeenCalledWith(
      expect.anything(),
      'inst-default',
      expect.anything(),
    );
  });

  it('releases the pacing lock immediately (no jitter sleep) when the claim is lost', async () => {
    const { processor, prisma, wa, redis, campaignsRepo } = makeProcessor({
      sendWindowEnabled: false,
      sentToday: 0,
      dailySendLimit: 500,
    });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    campaignsRepo.claimForSend.mockResolvedValue(0); // lost the claim

    await processor.process(makeAntiBanJob());

    expect(wa.send).not.toHaveBeenCalled();
    // Lock WAS acquired (we claim while holding it), so it must be released —
    // but without the jittered sleep, since nothing was sent.
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud providers (Twilio / Meta) — anti-ban gates are skipped entirely.
// These gates (send-window, warm-up cap, per-instance pacing lock + jitter)
// exist ONLY to keep unofficial Evolution/Baileys numbers from being banned.
// Twilio and Meta are official Cloud APIs that enforce their own limits, so a
// send must go through regardless of connection state, time-of-day, warm-up
// cap, or pacing lock — and no lock must ever be acquired OR released.
// ─────────────────────────────────────────────────────────────────────────────
describe('SendMessageProcessor — cloud providers skip anti-ban gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pacingHelper.acquirePacingLock).mockResolvedValue({
      acquired: true,
    });
    vi.mocked(pacingHelper.releasePacingLock).mockResolvedValue(undefined);
    vi.mocked(pacingHelper.checkAndPauseBurst).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('twilio message sends despite close instance + outside window + over warm-up cap', async () => {
    // SP 03:00 — well outside an 08–20 window; sentToday far over the cap; the
    // pacing lock is irrelevant. On Evolution every one of these would defer.
    const spHour = 3;
    const utcHour = (spHour + 3) % 24;
    const currentTime = new Date();
    currentTime.setUTCHours(utcHour, 0, 0, 0);
    vi.setSystemTime(currentTime);

    const { processor, prisma, wa, campaignsRepo, instancesRepo, redis } =
      makeProcessor(
        {
          sendWindowEnabled: true,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
          sentToday: 100_000,
          dailySendLimit: 10,
          warmupStartedAt: new Date(),
        },
        'twilio',
      );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'twilio-sid',
      acceptedAt: new Date(),
    });
    const job = makeAntiBanJob();

    await processor.process(job);

    // The send goes out exactly once and is marked sent.
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.markSent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        instanceId: 'inst-default',
      }),
    );
    // Cloud counts via the atomic tier reservation (reserveSendSlot), NOT the
    // Evolution-only incrementSentToday. The reservation still enforces the
    // daily tier cap for Twilio — the send-window and pacing lock are what get
    // skipped, not the tier budget.
    expect(instancesRepo.reserveSendSlot).toHaveBeenCalledWith(
      'inst-default',
      10,
    );
    expect(instancesRepo.incrementSentToday).not.toHaveBeenCalled();
    // NOT deferred/parked by any anti-ban gate.
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(campaignsRepo.markWaitingForInstance).not.toHaveBeenCalled();
    // No pacing lock acquired, no lock released, and the lock key is never
    // DEL'd. (The T8 kill-switch reset DELs its own `campaign:killswitch:*`
    // key on success — that one is expected; only the pacing lock key matters
    // to this assertion.)
    expect(pacingHelper.acquirePacingLock).not.toHaveBeenCalled();
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalledWith('pacing:send:lock:inst-default');
  });

  it('twilio: warm-up cap re-read is skipped — instancesRepo.findById not consulted for gating', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { sendWindowEnabled: true, sentToday: 100_000, dailySendLimit: 1 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({
      providerMessageId: 'sid',
      acceptedAt: new Date(),
    });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('twilio: lost claim still returns without touching the pacing lock', async () => {
    const { processor, prisma, wa, campaignsRepo, redis } = makeProcessor(
      { sendWindowEnabled: false },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    campaignsRepo.claimForSend.mockResolvedValue(0);

    await processor.process(makeAntiBanJob());

    expect(wa.send).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
  });

  it('twilio: a send failure releases the claim but never the (never-taken) lock', async () => {
    const { processor, prisma, wa, campaignsRepo, redis } = makeProcessor(
      { sendWindowEnabled: false },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const err = new WhatsappSendError(
      'transient',
      'rate_limit',
      'slow down',
      false,
    );
    wa.send.mockRejectedValue(err);

    await expect(processor.process(makeAntiBanJob())).rejects.toBe(err);

    expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('msg-1');
    // No lock was acquired on the cloud path, so nothing is released/DEL'd.
    expect(redis.del).not.toHaveBeenCalled();
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
  });
});

// ── Cloud tier batching & anti-double-charge (Twilio) ────────────────────────
describe('SendMessageProcessor — cloud tier batching', () => {
  it('reserves a slot against dailySendLimit and does NOT incrementSentToday (cloud)', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ dailySendLimit: 250, sentToday: 10 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(instancesRepo.reserveSendSlot).toHaveBeenCalledWith('inst-default', 250);
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.markSent).toHaveBeenCalledTimes(1);
    // Cloud already counted via the reservation — must not double-count.
    expect(instancesRepo.incrementSentToday).not.toHaveBeenCalled();
  });

  it('defers (moveToDelayed) and un-claims when the tier cap is reached', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor(
        { dailySendLimit: 250, sentTodayResetAt: new Date(Date.now() - 1000) },
        'twilio',
      );
    instancesRepo.reserveSendSlot.mockResolvedValue(false); // cap reached
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(wa.send).not.toHaveBeenCalled();
    // Row returned to QUEUED so it stays pending for the next 24h window.
    expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('msg-1');
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(Math.abs(delayedMs - (Date.now() + 24 * 60 * 60 * 1000))).toBeLessThanOrEqual(5_000);
  });

  it('does NOT resend when the send succeeded but markSent throws (anti double-charge)', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    // First markSent throws (DB blip); best-effort retry inside catch resolves.
    campaignsRepo.markSent
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValueOnce(undefined);

    // Must NOT throw (no BullMQ retry → no resend) and must NOT release the claim.
    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    // Slot kept (message was actually sent).
    expect(instancesRepo.releaseSendSlot).not.toHaveBeenCalled();
    // Best-effort re-persist attempted.
    expect(campaignsRepo.markSent).toHaveBeenCalledTimes(2);
  });

  it('terminalizes an indeterminate twilio.timeout as FAILED(twilio.indeterminate) without resend or slot release', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Twilio API send failed', 'twilio.timeout', 'timeout', false),
    );

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    // Terminal FAILED with the distinct non-auto-retryable code.
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'twilio.indeterminate',
          // F2 — INDETERMINADO: falha ambígua do provedor, não do destinatário.
          failureReason: 'INDETERMINADO',
        }),
      }),
    );
    // F2 — flag durável best-effort: 'twilio.indeterminate' está em
    // PERMANENT_RECIPIENT_FAILURE_CODES (marketing-reachability.ts) — mesmo
    // sendo INDETERMINADO quanto à entrega, a mensagem NÃO é auto-retentada,
    // então conta como definitiva para o Contact (lastFailure* grava).
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: {
        failureCount: { increment: 1 },
        lastFailureReason: 'INDETERMINADO',
        lastFailureCode: 'twilio.indeterminate',
        lastFailureAt: expect.any(Date),
      },
    });
    // But NO resend path: claim NOT released, not re-thrown, slot kept (may have
    // been sent + billed).
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    expect(instancesRepo.releaseSendSlot).not.toHaveBeenCalled();
  });

  // ── Fix: o B3 acima só interceptava `twilio.timeout`. Um timeout do Zernio
  // (`zernio.timeout`) é fatal:false no error-mapper (retryable por design —
  // 500/502/503 também são), então caía direto no ramo retryable genérico:
  // BullMQ reentregava e a pessoa recebia a MESMA mensagem duas vezes. O
  // Zernio é o provedor do tráfego REAL do cliente (uma campanha eleitoral) —
  // duplicata gera denúncia, e denúncia é o que derruba o número. Estes
  // testes cobrem a generalização da guarda para Zernio e GoZap sem tocar no
  // comportamento da Twilio (coberto acima, intocado).
  it('terminaliza um zernio.timeout indeterminado como FAILED(zernio.indeterminate) sem reenvio nem liberação de slot', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ dailySendLimit: 250 }, 'zernio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError(
        'Zernio API send failed',
        'zernio.timeout',
        'timeout',
        false,
      ),
    );

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    // Terminal FAILED com o código não-auto-retentável DISTINTO do Zernio.
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'zernio.indeterminate',
          failureReason: 'INDETERMINADO',
        }),
      }),
    );
    // A mensagem ao operador nomeia o provedor CERTO — nunca "Twilio" para um
    // envio Zernio.
    const messageUpdateCall = (
      prisma.message.update as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as { data: { errorMessage: string } };
    expect(messageUpdateCall.data.errorMessage).toContain('Zernio');
    expect(messageUpdateCall.data.errorMessage).not.toContain('Twilio');
    // zernio.indeterminate agora está em PERMANENT_RECIPIENT_FAILURE_CODES
    // (marketing-reachability.ts, generalizado junto com este fix) — mesmo
    // tratamento durável que a Twilio já tinha: sem isto, o PRÓXIMO LOTE desta
    // campanha acharia o contato "pendente" de novo e reenviaria (a mesma
    // duplicata, por outro caminho — ver batch-audience.spec.ts).
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: {
        failureCount: { increment: 1 },
        lastFailureReason: 'INDETERMINADO',
        lastFailureCode: 'zernio.indeterminate',
        lastFailureAt: expect.any(Date),
      },
    });
    // NO resend path: claim NOT released, not re-thrown, slot kept.
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    expect(instancesRepo.releaseSendSlot).not.toHaveBeenCalled();
  });

  it('terminaliza um gozap.timeout indeterminado como FAILED(gozap.indeterminate) sem reenvio', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ provider: 'GOZAP' });
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError(
        'GoZap API send failed',
        'gozap.timeout',
        'timeout',
        false,
      ),
    );

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'gozap.indeterminate',
          failureReason: 'INDETERMINADO',
        }),
      }),
    );
    const messageUpdateCall = (
      prisma.message.update as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as { data: { errorMessage: string } };
    expect(messageUpdateCall.data.errorMessage).toContain('GoZap');
    expect(messageUpdateCall.data.errorMessage).not.toContain('Twilio');
    expect(messageUpdateCall.data.errorMessage).not.toContain('Zernio');
    // gozap.indeterminate também está em PERMANENT_RECIPIENT_FAILURE_CODES —
    // mesma razão do caso Zernio acima.
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: {
        failureCount: { increment: 1 },
        lastFailureReason: 'INDETERMINADO',
        lastFailureCode: 'gozap.indeterminate',
        lastFailureAt: expect.any(Date),
      },
    });
    // GOZAP é session-based (sem slot de tier cloud) — nada a liberar; o que
    // importa é que não há reenvio (claim mantido, não relançado).
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    expect(instancesRepo.releaseSendSlot).not.toHaveBeenCalled();
  });

  it('releases the reserved slot and marks FAILED on a fatal cloud error', async () => {
    const { processor, prisma, wa, instancesRepo } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Twilio API send failed', '21211', 'Invalid To', true),
    );

    await processor.process(makeAntiBanJob());

    expect(instancesRepo.releaseSendSlot).toHaveBeenCalledWith('inst-default');
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: '21211',
          // F2 — 21211 (Twilio) → TELEFONE_INVALIDO.
          failureReason: 'TELEFONE_INVALIDO',
        }),
      }),
    );
    // F2 — flag durável best-effort no Contact (mesmo padrão do camino Evolution).
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: { failureCount: { increment: 1 } },
    });
  });

  it('releases the reserved slot AND the claim on a retryable cloud error', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const err = new WhatsappSendError('Twilio API send failed', '20429', 'rate', false);
    wa.send.mockRejectedValue(err);

    await expect(processor.process(makeAntiBanJob())).rejects.toBe(err);

    expect(instancesRepo.releaseSendSlot).toHaveBeenCalledWith('inst-default');
    expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('msg-1');
  });
});

// ── T8/ZA1: guarda de janela ROLANTE de 24h (TODO provedor CLOUD) — o limite
// da Meta conta usuários ÚNICOS em 24h móveis, não mensagens em dia-calendário.
// Antes de enviar, conta destinatários DISTINTOS com mensagem enviada nas
// últimas 24h no canal; cap atingido E destinatário atual fora do conjunto →
// adia como o tier batching (moveToDelayed p/ próxima janela). Coexiste com o
// contador sentToday (reserveSendSlot), que segue intacto.
// ZA1: a guarda era `if (provider === 'TWILIO')` — mas o TIER_2K do número
// ZERNIO é o MESMO teto da Meta, e estourá-lo derruba o quality rating.
// ────────────────────────────────────────────────────────────────────────────
describe('SendMessageProcessor — janela rolante de 24h (cloud: T8/ZA1)', () => {
  // ZA1 — o caso real: número ZERNIO em TIER_2K. Os 2.000 primeiros usuários
  // únicos passam; o 2.001º é ADIADO (não falha, não envia).
  it('ZERNIO em TIER_2K: com 2000 únicos nas últimas 24h, o 2001º destinatário é ADIADO (não falha, não envia)', async () => {
    const { processor, prisma, wa, campaignsRepo, instancesRepo } = makeProcessor(
      { dailySendLimit: 2000, sentTodayResetAt: new Date(Date.now() - 1000) },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    prisma.message.groupBy.mockResolvedValue(
      Array.from({ length: 2000 }, (_, i) => ({ contactId: `other-${i}` })),
    );
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(wa.send).not.toHaveBeenCalled();
    // Adiado ≠ falho: a mensagem volta para QUEUED e nada é marcado FAILED.
    expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('msg-1');
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(instancesRepo.reserveSendSlot).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('ZERNIO: destinatário JÁ contado entre os 2000 únicos não é bloqueado (é o mesmo usuário único)', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { dailySendLimit: 2000 },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    prisma.message.groupBy.mockResolvedValue([
      ...Array.from({ length: 1999 }, (_, i) => ({ contactId: `other-${i}` })),
      { contactId: 'co1' }, // o próprio destinatário da mensagem
    ]);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('META também é coberto pela janela rolante (mesma API da Meta)', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { dailySendLimit: 1, sentTodayResetAt: new Date(Date.now() - 1000) },
      'meta',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    prisma.message.groupBy.mockResolvedValue([{ contactId: 'other-1' }]);

    await expect(processor.process(makeAntiBanJob())).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(wa.send).not.toHaveBeenCalled();
  });
  it('adia (moveToDelayed) e solta o claim quando 24h rolantes já têm dailySendLimit destinatários únicos e o atual NÃO está entre eles', async () => {
    const { processor, prisma, wa, campaignsRepo, instancesRepo } =
      makeProcessor(
        { dailySendLimit: 2, sentTodayResetAt: new Date(Date.now() - 1000) },
        'twilio',
      );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    // 2 destinatários distintos já contatados na janela — contato atual (co1) fora.
    prisma.message.groupBy.mockResolvedValue([
      { contactId: 'other-1' },
      { contactId: 'other-2' },
    ]);
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(wa.send).not.toHaveBeenCalled();
    expect(campaignsRepo.releaseClaim).toHaveBeenCalledWith('msg-1');
    // Nenhum slot do contador sentToday deve ter sido consumido.
    expect(instancesRepo.reserveSendSlot).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(
      Math.abs(delayedMs - (Date.now() + 24 * 60 * 60 * 1000)),
    ).toBeLessThanOrEqual(5_000);
  });

  it('envia quando a janela está cheia MAS o destinatário atual JÁ está entre os únicos (não adiciona usuário novo)', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { dailySendLimit: 2 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    prisma.message.groupBy.mockResolvedValue([
      { contactId: 'co1' }, // o próprio destinatário da mensagem
      { contactId: 'other-2' },
    ]);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('envia quando a janela rolante está abaixo do cap e consulta só OUTBOUND enviados nas últimas 24h do canal', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    prisma.message.groupBy.mockResolvedValue([{ contactId: 'other-1' }]);

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
    const arg = prisma.message.groupBy.mock.calls[0][0] as {
      by: string[];
      where: {
        instanceId: string;
        direction: string;
        contactId: { not: null };
        sentAt: { gte: Date };
      };
    };
    expect(arg.by).toEqual(['contactId']);
    expect(arg.where.instanceId).toBe('inst-default');
    expect(arg.where.direction).toBe('OUTBOUND');
    expect(
      Math.abs(
        arg.where.sentAt.gte.getTime() - (Date.now() - 24 * 60 * 60 * 1000),
      ),
    ).toBeLessThanOrEqual(5_000);
  });

  it('canal EVOLUTION não consulta a janela rolante (não-oficial: não há tier da Meta)', async () => {
    const { processor, prisma, wa } = makeProcessor({}, 'evolution');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(prisma.message.groupBy).not.toHaveBeenCalled();
  });
});

// ── ZA4: throttle de ≤ 1 msg/s por canal ZERNIO ──────────────────────────────
// O balde do Zernio é de 60 req/min POR CHAVE de API (= 1 req/s) e é o MESMO
// que o sync do inbox consome. Sem espaçamento, um lote grande vira 429 em
// série. O gate roda ANTES do claim (como o lock do Evolution), então um job
// adiado não desperdiça claim nem slot de tier.
describe('SendMessageProcessor — throttle 1 msg/s por canal ZERNIO (ZA4)', () => {
  const THROTTLE_KEY = 'zernio:send:throttle:inst-default';

  it('adia o job quando outro envio do MESMO canal ZERNIO ocorreu há menos de 1s', async () => {
    const { processor, prisma, wa, redis, campaignsRepo, instancesRepo } =
      makeProcessor({ dailySendLimit: 2000 }, 'zernio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    // O slot do segundo está ocupado (SET NX falhou) e faltam 700ms.
    redis.set.mockImplementation(async (key: string) =>
      key === THROTTLE_KEY ? null : 'OK',
    );
    redis.pttl.mockImplementation(async (key: string) =>
      key === THROTTLE_KEY ? 700 : -2,
    );
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(wa.send).not.toHaveBeenCalled();
    // Adiado ANTES do claim e da reserva de tier — nada foi consumido.
    expect(campaignsRepo.claimForSend).not.toHaveBeenCalled();
    expect(instancesRepo.reserveSendSlot).not.toHaveBeenCalled();
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(delayedMs).toBeGreaterThanOrEqual(Date.now() + 700 - 50);
  });

  it('envia quando o slot do canal está livre, reservando-o por 1s', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 2000 },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(redis.set).toHaveBeenCalledWith(THROTTLE_KEY, '1', 'PX', 1000, 'NX');
    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it.each(['twilio', 'meta', 'evolution'] as const)(
    'canal %s não consulta o throttle do Zernio (balde é do Zernio)',
    async (provider) => {
      const { processor, prisma, wa, redis } = makeProcessor(
        { dailySendLimit: 250 },
        provider,
      );
      prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
      wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

      await processor.process(makeAntiBanJob());

      expect(redis.set).not.toHaveBeenCalledWith(
        THROTTLE_KEY,
        '1',
        'PX',
        1000,
        'NX',
      );
    },
  );
});

// ── C2: 131049 — cap de MARKETING por destinatário (spec §5.3) ───────────────
// A Meta impõe um teto adaptativo de templates de marketing por usuário em 24h,
// somando TODAS as empresas. Estourou → 131049. Retentar PIORA ("further
// delivery attempts to these users may be unavailable for up to 24 hours"):
// a mensagem morre (fatal) e o DESTINATÁRIO fica bloqueado por 24h em Redis,
// chaveado pelo hash do telefone.
describe('SendMessageProcessor — cap de marketing por destinatário (131049)', () => {
  const KEY = 'optout:131049:hash(+5511999990000)';

  it('grava o bloqueio de 24h do destinatário (chave hasheada) e falha a mensagem sem retry', async () => {
    const { processor, prisma, wa, redis, campaignsService, consent } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError(
        'Cap de marketing atingido',
        '131049',
        'per-user marketing limit',
        true,
      ),
    );

    // fatal → resolve (não re-lança: BullMQ não pode retentar)
    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(consent.hashOf).toHaveBeenCalledWith('+5511999990000');
    expect(redis.set).toHaveBeenCalledWith(KEY, '1', 'EX', 24 * 3600);
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: '131049' }),
      }),
    );
    // É falha do DESTINATÁRIO: não mata a campanha.
    expect(campaignsService.cancel).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('destinatário bloqueado: adia a mensagem até o fim do bloqueio, sem enviar e sem tomar o claim', async () => {
    const { processor, prisma, wa, redis, campaignsRepo } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    redis.pttl.mockResolvedValue(3_600_000); // 1h restante de bloqueio
    const job = makeAntiBanJob();

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(redis.pttl).toHaveBeenCalledWith(KEY);
    expect(wa.send).not.toHaveBeenCalled();
    // Nada foi reivindicado → nada a soltar (e nenhum retry queimado).
    expect(campaignsRepo.claimForSend).not.toHaveBeenCalled();
    const delayedMs = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as number;
    expect(Math.abs(delayedMs - (Date.now() + 3_600_000))).toBeLessThanOrEqual(
      5_000,
    );
  });

  it('sem bloqueio (pttl -2) o envio segue normalmente', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(wa.send).toHaveBeenCalledTimes(1);
  });

  it('131049 no ZERNIO (mesma WABA da Meta) também bloqueia o destinatário', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('cap', '131049', 'per-user cap', true),
    );

    await processor.process(makeAntiBanJob());

    expect(redis.set).toHaveBeenCalledWith(KEY, '1', 'EX', 24 * 3600);
  });

  it('Redis fora ao gravar o bloqueio não muda o desfecho da mensagem (FAILED)', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('cap', '131049', 'per-user cap', true),
    );
    redis.set.mockRejectedValue(new Error('redis down'));

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: '131049' }),
      }),
    );
  });
});

// ── T8: kill-switch — ≥5 falhas FATAIS consecutivas de template/qualidade
// (63040/41/42/49 ou 21610) numa campanha TWILIO cancelam o restante via o
// mecanismo de cancel existente + audit 'campaign.kill_switch'. ──────────────
describe('SendMessageProcessor — kill-switch de campanha TWILIO (T8)', () => {
  it('incrementa o contador consecutivo em falha de template (63041) mas NÃO cancela abaixo do limiar', async () => {
    const { processor, prisma, wa, redis, campaignsService, audit } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Template pausado', '63041', 'paused', true),
    );
    redis.incr.mockResolvedValue(3);

    await processor.process(makeAntiBanJob());

    expect(redis.incr).toHaveBeenCalledWith('campaign:killswitch:camp1');
    expect(campaignsService.cancel).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(
      'campaign.kill_switch',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('cancela a campanha + audit campaign.kill_switch na 5ª falha consecutiva (21610)', async () => {
    const { processor, prisma, wa, redis, campaignsService, audit } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Opt-out', '21610', 'unsubscribed', true),
    );
    redis.incr.mockResolvedValue(5);

    await processor.process(makeAntiBanJob());

    expect(campaignsService.cancel).toHaveBeenCalledWith('camp1');
    expect(audit.log).toHaveBeenCalledWith(
      'campaign.kill_switch',
      'Campaign',
      'camp1',
      expect.objectContaining({ errorCode: '21610', consecutiveFailures: 5 }),
    );
  });

  it('63049 (transiente, throttle de marketing) também conta para o kill-switch', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    const err = new WhatsappSendError('Throttled', '63049', 'meta throttle', false);
    wa.send.mockRejectedValue(err);
    redis.incr.mockResolvedValue(1);

    await expect(processor.process(makeAntiBanJob())).rejects.toBe(err);

    expect(redis.incr).toHaveBeenCalledWith('campaign:killswitch:camp1');
  });

  it('envio bem-sucedido zera o contador consecutivo (DEL da chave)', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(redis.del).toHaveBeenCalledWith('campaign:killswitch:camp1');
  });

  it('falha fatal em canal EVOLUTION NÃO toca o contador do kill-switch', async () => {
    const { processor, prisma, wa, redis, campaignsService } = makeProcessor(
      {},
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('fatal evo', '63041', 'x', true),
    );

    await processor.process(makeAntiBanJob());

    expect(redis.incr).not.toHaveBeenCalled();
    expect(campaignsService.cancel).not.toHaveBeenCalled();
  });

  it('falha no próprio kill-switch (Redis fora) não muda o desfecho da mensagem', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Template pausado', '63041', 'paused', true),
    );
    redis.incr.mockRejectedValue(new Error('redis down'));

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: '63041' }),
      }),
    );
  });
});

// ── C2: kill-switch corrigido (spec §5.3) ───────────────────────────────────
// (a) 132015 dispara com LIMIAR 1 — a Meta pausou o TEMPLATE INTEIRO, a 2ª
//     ocorrência já é desperdício;
// (b) o kill-switch vale para TODOS os provedores cloud (TWILIO/META/ZERNIO),
//     não só TWILIO — Zernio e Meta enviam pela API oficial da Meta e recebem
//     os mesmos 13xxxx;
// (c) ao disparar por 132015, além de cancelar a campanha, o template local vai
//     a PAUSED (o job de sync confirma depois).
describe('SendMessageProcessor — kill-switch por 132015 e provedores cloud (C2)', () => {
  const paused = () =>
    new WhatsappSendError('Template pausado pela Meta', '132015', 'paused', true);

  it('132015 cancela a campanha JÁ NA PRIMEIRA ocorrência (limiar 1, não 5)', async () => {
    const { processor, prisma, wa, redis, campaignsService, audit } =
      makeProcessor({ dailySendLimit: 250 }, 'twilio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(paused());
    redis.incr.mockResolvedValue(1); // PRIMEIRA falha

    await processor.process(makeAntiBanJob());

    expect(campaignsService.cancel).toHaveBeenCalledWith('camp1');
    expect(audit.log).toHaveBeenCalledWith(
      'campaign.kill_switch',
      'Campaign',
      'camp1',
      expect.objectContaining({
        errorCode: '132015',
        consecutiveFailures: 1,
        threshold: 1,
      }),
    );
  });

  it('132015 marca o template local como PAUSED (o job de sync confirma depois)', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(paused());
    redis.incr.mockResolvedValue(1);

    await processor.process(makeAntiBanJob());

    expect(prisma.template.update).toHaveBeenCalledWith({
      where: { id: 'tpl1' },
      data: { status: 'PAUSED' },
    });
  });

  it('63041 (falha do template por destinatário) NÃO tem limiar 1 — segue em 5', async () => {
    const { processor, prisma, wa, redis, campaignsService } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Template pausado', '63041', 'paused', true),
    );
    redis.incr.mockResolvedValue(1);

    await processor.process(makeAntiBanJob());

    expect(campaignsService.cancel).not.toHaveBeenCalled();
    expect(prisma.template.update).not.toHaveBeenCalled();
  });

  it.each(['zernio', 'meta'] as const)(
    'o kill-switch também vale no canal %s (provedor cloud, mesma API da Meta)',
    async (provider) => {
      const { processor, prisma, wa, redis, campaignsService, audit } =
        makeProcessor({ dailySendLimit: 250 }, provider);
      prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
      wa.send.mockRejectedValue(paused());
      redis.incr.mockResolvedValue(1);

      await processor.process(makeAntiBanJob());

      expect(redis.incr).toHaveBeenCalledWith('campaign:killswitch:camp1');
      expect(campaignsService.cancel).toHaveBeenCalledWith('camp1');
      expect(audit.log).toHaveBeenCalledWith(
        'campaign.kill_switch',
        'Campaign',
        'camp1',
        expect.objectContaining({ errorCode: '132015' }),
      );
    },
  );

  it('EVOLUTION (não-oficial) continua FORA do kill-switch', async () => {
    const { processor, prisma, wa, redis, campaignsService } = makeProcessor(
      {},
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(paused());

    await processor.process(makeAntiBanJob());

    expect(redis.incr).not.toHaveBeenCalled();
    expect(campaignsService.cancel).not.toHaveBeenCalled();
  });

  it('envio bem-sucedido em canal ZERNIO zera o contador consecutivo', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 250 },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(redis.del).toHaveBeenCalledWith('campaign:killswitch:camp1');
  });

  // ── ZA3: 131031 — a Meta BLOQUEOU a conta/número (suspensão). ──────────────
  // Não é falha de um destinatário nem de um template: é a conta inteira. Cada
  // envio seguinte é uma rejeição a mais no histórico de qualidade do número.
  // Limiar 1, como o 132015 — mas SEM tocar no template (ele não tem culpa).
  it('131031 (conta bloqueada pela Meta) cancela a campanha na PRIMEIRA ocorrência', async () => {
    const { processor, prisma, wa, redis, campaignsService, audit } =
      makeProcessor({ dailySendLimit: 2000 }, 'zernio');
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError(
        'Número/conta bloqueado pela Meta (suspenso).',
        '131031',
        'account blocked',
        true,
      ),
    );
    redis.incr.mockResolvedValue(1); // PRIMEIRA falha

    await processor.process(makeAntiBanJob());

    expect(campaignsService.cancel).toHaveBeenCalledWith('camp1');
    expect(audit.log).toHaveBeenCalledWith(
      'campaign.kill_switch',
      'Campaign',
      'camp1',
      expect.objectContaining({
        errorCode: '131031',
        consecutiveFailures: 1,
        threshold: 1,
      }),
    );
  });

  it('131031 NÃO marca o template como PAUSED (a conta é que está bloqueada, não o template)', async () => {
    const { processor, prisma, wa, redis } = makeProcessor(
      { dailySendLimit: 2000 },
      'zernio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(
      new WhatsappSendError('Conta bloqueada', '131031', 'blocked', true),
    );
    redis.incr.mockResolvedValue(1);

    await processor.process(makeAntiBanJob());

    expect(prisma.template.update).not.toHaveBeenCalled();
  });

  it('falha ao marcar o template como PAUSED não impede o cancelamento da campanha', async () => {
    const { processor, prisma, wa, redis, campaignsService } = makeProcessor(
      { dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockRejectedValue(paused());
    redis.incr.mockResolvedValue(1);
    prisma.template.update.mockRejectedValue(new Error('db down'));

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(campaignsService.cancel).toHaveBeenCalledWith('camp1');
  });
});

// ── T3: the send is routed to the adapter matching the CHANNEL's provider, and
// the anti-ban path is decided by `instance.provider` (per-channel), not the
// deploy-global WHATSAPP_PROVIDER. ────────────────────────────────────────────
describe('SendMessageProcessor — channel-aware send routing (T3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pacingHelper.acquirePacingLock).mockResolvedValue({
      acquired: true,
    });
    vi.mocked(pacingHelper.releasePacingLock).mockResolvedValue(undefined);
    vi.mocked(pacingHelper.checkAndPauseBurst).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes the send through sendVia with the resolved EVOLUTION channel', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { sendWindowEnabled: false },
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(wa.sendVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'EVOLUTION' }),
      expect.objectContaining({
        toE164: '+5511999990000',
        evolutionInstanceName: 'picoa-dev',
      }),
    );
  });

  it('routes the send through sendVia with the resolved TWILIO channel', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { sendWindowEnabled: false },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'sid', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(wa.sendVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'TWILIO' }),
      expect.objectContaining({ toE164: '+5511999990000' }),
    );
  });

  it('an EVOLUTION channel still runs the anti-ban pipeline (acquires the pacing lock)', async () => {
    const { processor, prisma, wa } = makeProcessor(
      { sendWindowEnabled: false },
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(pacingHelper.acquirePacingLock).toHaveBeenCalledWith(
      expect.anything(),
      'inst-default',
    );
    expect(pacingHelper.releasePacingLock).toHaveBeenCalled();
  });

  it('a TWILIO channel skips the anti-ban pipeline (no pacing lock) and reserves a cloud slot', async () => {
    const { processor, prisma, wa, instancesRepo } = makeProcessor(
      { sendWindowEnabled: false, dailySendLimit: 250 },
      'twilio',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'sid', acceptedAt: new Date() });

    await processor.process(makeAntiBanJob());

    expect(pacingHelper.acquirePacingLock).not.toHaveBeenCalled();
    expect(pacingHelper.releasePacingLock).not.toHaveBeenCalled();
    expect(instancesRepo.reserveSendSlot).toHaveBeenCalledWith(
      'inst-default',
      250,
    );
    // Cloud counts via the reservation, never the Evolution-only counter.
    expect(instancesRepo.incrementSentToday).not.toHaveBeenCalled();
  });
});

// ── Evolution: post-send bookkeeping must not double-count the daily counter ──
describe('SendMessageProcessor — Evolution daily-counter integrity', () => {
  it('does NOT double-count sentToday when the burst pause throws after a successful send', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } = makeProcessor(
      {},
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    // The increment already ran; a LATER step (burst pause) blows up.
    vi.mocked(pacingHelper.checkAndPauseBurst).mockRejectedValueOnce(
      new Error('redis blip'),
    );

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    expect(wa.send).toHaveBeenCalledTimes(1);
    // Exactly ONE increment for one send (the catch must not re-bump it).
    expect(instancesRepo.incrementSentToday).toHaveBeenCalledTimes(1);
    // And no resend path.
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
  });

  it('still retries the increment when markSent threw BEFORE it ran', async () => {
    const { processor, prisma, wa, instancesRepo, campaignsRepo } = makeProcessor(
      {},
      'evolution',
    );
    prisma.message.findUnique.mockResolvedValue(makeAntiBanMessage());
    wa.send.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    campaignsRepo.markSent
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValueOnce(undefined);

    await expect(processor.process(makeAntiBanJob())).resolves.toBeUndefined();

    // markSent threw before the increment, so the catch performs it once.
    expect(instancesRepo.incrementSentToday).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
  });
});

/**
 * O QUE O OPERADOR VIA: campanha enviada, entregue e LIDA — e, no Inbox, uma
 * bolha VAZIA (só hora + ticks) e a linha da conversa sem preview e sem horário.
 * Causa: o worker tinha o corpo do template e as variáveis resolvidas na mão no
 * momento do envio, e jogava os dois fora — a Message ia para o banco com
 * `content` NULL e sem `conversationId`.
 */
describe('outbound de campanha no Inbox (bolha com texto + resumo da conversa)', () => {
  function setup(over: Record<string, unknown> = {}) {
    const mocks = makeProcessor({}, 'evolution');
    mocks.prisma.message.findUnique.mockResolvedValue(
      baseMessage({ variables: { nome: 'Andre' }, ...over }),
    );
    mocks.wa.send.mockResolvedValue({
      providerMessageId: 'wamid.HBg1',
      acceptedAt: new Date('2026-07-11T15:02:00.000Z'),
    });
    return mocks;
  }

  it('grava em Message.content o CORPO RENDERIZADO do template (não um placeholder)', async () => {
    const { processor, campaignsRepo } = setup();

    await processor.process(makeJob());

    // O corpo aprovado é 'Olá {{nome}}' e a variável resolvida é 'Andre'.
    expect(campaignsRepo.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', content: 'Olá Andre' }),
    );
  });

  it('sem corpo renderizável (mídia pura/interativo), cai no placeholder [Template: x] — nunca bolha muda', async () => {
    const { processor, campaignsRepo } = setup({
      campaign: {
        ...baseMessage().campaign,
        template: { ...baseMessage().campaign.template, body: '' },
      },
    });

    await processor.process(makeJob());

    expect(campaignsRepo.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[Template: tpl_hello]' }),
    );
  });

  it('liga a Message a uma Conversation e toca o resumo (preview + horário da lista lateral)', async () => {
    const { processor, chatRepo, chatEvents } = setup();

    await processor.process(makeJob());

    expect(chatRepo.linkOutboundCampaignMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'm1',
        instanceId: 'inst-default',
        contactId: 'c1',
        phoneE164: '+5511999999999',
        content: 'Olá Andre',
        sentAt: new Date('2026-07-11T15:02:00.000Z'),
      }),
    );
    // a inbox aberta precisa ver a bolha aparecer sem dar F5
    expect(chatEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.created',
        conversationId: 'conv-1',
        messageId: 'm1',
      }),
    );
  });

  // A mensagem JÁ FOI COBRADA e entregue. Um erro no espelho da inbox (dado
  // derivado, cosmético) não pode reenviá-la nem rebaixar o status.
  it('se o link com a Conversation falhar, a mensagem permanece SENT e NÃO é reenviada', async () => {
    const { processor, chatRepo, campaignsRepo, wa } = setup();
    chatRepo.linkOutboundCampaignMessage.mockRejectedValue(new Error('db down'));

    await expect(processor.process(makeJob())).resolves.toBeUndefined();

    expect(campaignsRepo.markSent).toHaveBeenCalledTimes(1);
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(campaignsRepo.releaseClaim).not.toHaveBeenCalled();
  });

  /**
   * COALESCÊNCIA DO SSE — um disparo é um FLUXO. Cada evento faz TODA aba de
   * Inbox aberta revalidar a lista de conversas inteira; sem gate, 5.000
   * mensagens = 5.000 refetches por operador. O gate (SET NX EX por canal) deixa
   * passar 1 evento por janela; entre uma janela e outra, o polling da tela (10s
   * / 15s) cobre.
   */
  it('coalesce os eventos SSE do disparo: o 2º envio dentro da janela não publica', async () => {
    const { processor, chatEvents, redis } = setup();
    // 1º envio ganha o gate; o 2º cai na mesma janela (SET NX devolve null).
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null as never);

    await processor.process(makeJob());
    await processor.process(makeJob());

    expect(chatEvents.publish).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'chat:mirror-evt:inst-default', '1', 'EX', 5, 'NX',
    );
  });

  it('se o Redis do gate falhar, publica assim mesmo (o evento é barato; perder a atualização não)', async () => {
    const { processor, chatEvents, redis } = setup();
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    await processor.process(makeJob());

    expect(chatEvents.publish).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── K4: A ÚLTIMA LINHA DE DEFESA, NO ATO DO ENVIO ───────────────────────────
 *
 * O worker é o único ponto que roda POR MENSAGEM no instante do envio, e ele já
 * reavalia supressão, opt-out, consentimento por finalidade e cancelamento da
 * campanha — de propósito, porque SEMANAS podem separar a montagem da audiência
 * do envio. Faltava a pergunta que fecha todos os furos de duplicata mapeados
 * pela auditoria (tick recorrente, reenviar-falhas, campanhas irmãs do mesmo
 * template): **esta pessoa já recebeu?**
 */
describe('K4 — guarda anti-duplicata no ato do envio', () => {
  function setup() {
    const m = makeProcessor();
    m.prisma.message.findUnique.mockResolvedValue(baseMessage());
    m.wa.send.mockResolvedValue({
      providerMessageId: 'provider-xyz',
      acceptedAt: new Date('2026-05-07T12:00:00.000Z'),
    });
    return m;
  }

  it('não envia quando OUTRA linha do mesmo contato já saiu nesta campanha', async () => {
    const m = setup();
    // O tick das 11h criou uma 2ª linha para quem o tick das 10h já enviou.
    m.prisma.message.findFirst.mockResolvedValue({
      id: 'm-irma',
      campaignId: 'camp1',
      status: 'SENT',
    });

    await m.processor.process(makeJob());

    expect(m.wa.send).not.toHaveBeenCalled();
    expect(m.campaignsRepo.claimForSend).not.toHaveBeenCalled();
    // A escrita é CONDICIONAL (ver "o carimbo é condicional", mais abaixo): só
    // pega a linha que ainda está na fila.
    expect(m.prisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', status: { in: ['QUEUED', 'WAITING_INSTANCE'] } },
      data: expect.objectContaining({
        status: 'CANCELLED',
        errorCode: 'duplicate_already_sent',
      }),
    });
  });

  it('o pulo deixa RASTRO: audit com a irmã que causou o bloqueio', async () => {
    const m = setup();
    m.prisma.message.findFirst.mockResolvedValue({
      id: 'm-irma',
      campaignId: 'camp-irma',
      status: 'DELIVERED',
    });

    await m.processor.process(makeJob());

    expect(m.audit.log).toHaveBeenCalledWith(
      'campaign.duplicate_blocked',
      'Message',
      'm1',
      expect.objectContaining({
        campaignId: 'camp1',
        contactId: 'c1',
        blockedByMessageId: 'm-irma',
        blockedByCampaignId: 'camp-irma',
        blockedByStatus: 'DELIVERED',
      }),
    );
  });

  it('o pulo REAVALIA a conclusão da campanha (senão ela trava "Em execução")', async () => {
    const m = setup();
    m.prisma.message.findFirst.mockResolvedValue({
      id: 'm-irma',
      campaignId: 'camp1',
      status: 'SENT',
    });

    await m.processor.process(makeJob());

    // O `not.toHaveBeenCalled` está aqui de propósito: sem ele o teste passaria
    // pelo caminho de SUCESSO (que também reavalia a campanha) e não provaria
    // nada sobre o pulo.
    expect(m.wa.send).not.toHaveBeenCalled();
    expect(m.campaignsService.maybeCompleteCampaign).toHaveBeenCalledWith(
      'camp1',
    );
  });

  it('a pergunta é pela PESSOA e nunca pela própria linha (redisparo reusa o mesmo id)', async () => {
    const m = setup();

    await m.processor.process(makeJob());

    expect(m.prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 'm1' },
          contactId: 'c1',
          direction: 'OUTBOUND',
        }),
      }),
    );
  });

  it('a guarda também olha OUTRAS campanhas do MESMO template (regra do dono)', async () => {
    const m = setup();

    await m.processor.process(makeJob());

    const where = m.prisma.message.findFirst.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    const or = where.OR as Array<Record<string, unknown>>;
    const irmas = or.filter((c) => c.campaign);
    expect(irmas.length).toBeGreaterThan(0);
    for (const clause of irmas) {
      expect(clause.campaign).toMatchObject({
        templateId: 'tpl-1',
        id: { not: 'camp1' },
      });
    }
  });

  it('sem irmã, o envio segue normalmente (a guarda não pode inventar bloqueio)', async () => {
    const m = setup();
    m.prisma.message.findFirst.mockResolvedValue(null);

    await m.processor.process(makeJob());

    expect(m.wa.send).toHaveBeenCalledTimes(1);
  });
});

/**
 * O predicado da guarda, testado direto: é ELE que decide quem bloqueia quem, e
 * com Prisma mockado o `where` é o único lugar onde essa decisão existe.
 */
describe('K4 — duplicateGuardWhere', () => {
  const AGORA = new Date('2026-08-01T11:00:00.000Z');
  const base = {
    messageId: 'm2',
    contactId: 'c1',
    campaignId: 'camp1',
    templateId: 'tpl-1',
    createdAt: AGORA,
  };
  /** As cláusulas que casam irmãs ainda PARADAS na fila. */
  function paradas(where: ReturnType<typeof duplicateGuardWhere>) {
    const or = (where.OR ?? []) as Array<Record<string, unknown>>;
    return or.filter((c) => {
      const status = c.status as { in?: string[] } | undefined;
      return (status?.in ?? []).includes('QUEUED');
    });
  }

  it('cobre a irmã ainda QUEUED — o furo do tick recorrente (C1/C4)', () => {
    // O tick das 11h cria uma 2ª linha para quem ainda está QUEUED do tick das
    // 10h. Se a guarda só olhasse SENT/DELIVERED/READ, os dois envios sairiam.
    expect(paradas(duplicateGuardWhere(base)).length).toBeGreaterThan(0);
  });

  it('a irmã parada só bloqueia se for ANTERIOR — senão as DUAS se cancelam e ninguém recebe', () => {
    for (const clause of paradas(duplicateGuardWhere(base))) {
      expect(clause.OR).toEqual([
        { createdAt: { lt: AGORA } },
        // `createMany` grava milhares de linhas com o MESMO createdAt: sem o
        // desempate por id, o par voltaria a se cancelar mutuamente.
        { createdAt: AGORA, id: { lt: 'm2' } },
      ]);
    }
  });

  it('SENT/DELIVERED/READ e SENDING bloqueiam SEM desempate (a mensagem já saiu)', () => {
    const or = (duplicateGuardWhere(base).OR ?? []) as Array<
      Record<string, unknown>
    >;
    const semDesempate = or.filter((c) => !c.OR);
    expect(semDesempate.length).toBeGreaterThan(0);
    for (const clause of semDesempate) {
      const status = clause.status as { in?: string[] };
      expect(status.in).not.toContain('QUEUED');
      expect(status.in).not.toContain('WAITING_INSTANCE');
    }
  });
});

/**
 * ── K4, 2ª RODADA: A RÉGUA DA GUARDA, LINHA POR LINHA ────────────────────────
 *
 * As cláusulas de `duplicateGuardWhere` que existem SÓ para EVITAR FALSO
 * POSITIVO (FAILED nunca bloqueia, SKIPPED_* nunca bloqueia, campanha CANCELADA
 * do mesmo template só bloqueia o que foi ENTREGUE, INBOUND e mensagem de chat
 * nunca bloqueiam) não tinham nenhum teste. Quem amanhã acrescentasse `FAILED`
 * a `DUPLICATE_BLOCKS_ALWAYS`, ou trocasse `RECEIVED_STATUSES` por
 * `REACHED_STATUSES` na cláusula da campanha cancelada, não veria nada ficar
 * vermelho — e o efeito em produção seria uma faixa de eleitores QUEIMADA para
 * sempre (quem teve número errado, quem pegou queda de canal, quem foi pulado
 * por falta de consentimento e depois consentiu).
 *
 * Com Prisma mockado o `where` é o único lugar onde essa decisão existe, e
 * afirmar sobre a FORMA dele (tem uma cláusula com QUEUED, tem um OR) prova
 * pouco. Então o `where` é AVALIADO aqui contra linhas de mentira, por um
 * matcher mínimo que entende exatamente o subconjunto de Prisma que a guarda
 * usa — e que ESTOURA em qualquer chave ou operador que ele não conheça. Se a
 * guarda passar a usar uma construção nova, este arquivo fica VERMELHO em vez
 * de aprovar em silêncio.
 */
type LinhaFalsa = {
  id: string;
  contactId: string | null;
  campaignId: string | null;
  direction: 'OUTBOUND' | 'INBOUND';
  status: string;
  createdAt: Date;
  /** A campanha da linha (null = mensagem de chat, sem campanha). */
  campaign: { id: string; templateId: string; status: string } | null;
};

function mesmoValor(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** `{ in: [...] }`, `{ not: x }`, `{ lt: date }` ou um escalar cru. */
function casaEscalar(cond: unknown, valor: unknown, campo: string): boolean {
  if (cond === null || cond instanceof Date || typeof cond !== 'object') {
    return mesmoValor(cond, valor);
  }
  const c = cond as Record<string, unknown>;
  const desconhecidos = Object.keys(c).filter(
    (k) => !['in', 'not', 'lt'].includes(k),
  );
  if (desconhecidos.length > 0) {
    throw new Error(
      `matcher não entende o operador ${desconhecidos.join(',')} em "${campo}"`,
    );
  }
  if ('in' in c && !(c.in as unknown[]).some((v) => mesmoValor(v, valor)))
    return false;
  if ('not' in c && mesmoValor(c.not, valor)) return false;
  if ('lt' in c) {
    // `lt` aparece nos DOIS desempates: em `createdAt` (Date) e em `id`
    // (string, o desempate do desempate quando o `createMany` gravou milhares
    // de linhas no mesmo milissegundo).
    const limite = c.lt;
    if (limite instanceof Date) {
      if (!(valor instanceof Date) || valor.getTime() >= limite.getTime())
        return false;
    } else if (typeof limite === 'string') {
      if (typeof valor !== 'string' || valor >= limite) return false;
    } else {
      throw new Error(`matcher não entende "lt" de ${typeof limite} em "${campo}"`);
    }
  }
  return true;
}

function casaCampanha(cond: unknown, campanha: LinhaFalsa['campaign']): boolean {
  if (campanha === null) return false; // mensagem de chat: relação ausente
  const c = cond as Record<string, unknown>;
  for (const [chave, valor] of Object.entries(c)) {
    if (!['id', 'templateId', 'status'].includes(chave)) {
      throw new Error(`matcher não entende "campaign.${chave}"`);
    }
    if (
      !casaEscalar(
        valor,
        (campanha as unknown as Record<string, unknown>)[chave],
        `campaign.${chave}`,
      )
    )
      return false;
  }
  return true;
}

/** O `where` da guarda, avaliado contra uma linha. */
function casaGuarda(where: Record<string, unknown>, linha: LinhaFalsa): boolean {
  const CHAVES = [
    'id',
    'contactId',
    'campaignId',
    'direction',
    'status',
    'createdAt',
  ];
  for (const [chave, valor] of Object.entries(where)) {
    if (chave === 'OR') {
      const alternativas = valor as Array<Record<string, unknown>>;
      if (!alternativas.some((alt) => casaGuarda(alt, linha))) return false;
      continue;
    }
    if (chave === 'campaign') {
      if (!casaCampanha(valor, linha.campaign)) return false;
      continue;
    }
    if (!CHAVES.includes(chave)) {
      throw new Error(`matcher não entende a chave "${chave}" do where`);
    }
    if (
      !casaEscalar(
        valor,
        (linha as unknown as Record<string, unknown>)[chave],
        chave,
      )
    )
      return false;
  }
  return true;
}

describe('K4 — a régua da guarda avaliada contra linhas de verdade', () => {
  const T0 = new Date('2026-08-01T10:00:00.000Z');
  const T1 = new Date('2026-08-01T11:00:00.000Z');
  const T2 = new Date('2026-08-01T12:00:00.000Z');

  const CAMPANHA_VIVA = {
    id: 'campA',
    templateId: 'tplX',
    status: 'RUNNING',
  };
  /** A linha que está sendo enviada AGORA: campanha A, template X, nasceu em T1. */
  const eu = {
    messageId: 'm-eu',
    contactId: 'c1',
    campaignId: 'campA',
    templateId: 'tplX',
    createdAt: T1,
  };
  const where = duplicateGuardWhere(eu) as unknown as Record<string, unknown>;

  function linha(over: Partial<LinhaFalsa> = {}): LinhaFalsa {
    return {
      id: 'm-outra',
      contactId: 'c1',
      campaignId: 'campA',
      direction: 'OUTBOUND',
      status: 'SENT',
      createdAt: T0,
      campaign: CAMPANHA_VIVA,
      ...over,
    };
  }
  const bloqueia = (over: Partial<LinhaFalsa> = {}) =>
    casaGuarda(where, linha(over));

  // ── O que DEVE bloquear ────────────────────────────────────────────────────
  it.each(['SENT', 'DELIVERED', 'READ', 'SENDING'])(
    'irmã %s na MESMA campanha bloqueia, tenha nascido quando tiver',
    (status) => {
      expect(bloqueia({ status, createdAt: T0 })).toBe(true);
      expect(bloqueia({ status, createdAt: T2 })).toBe(true);
    },
  );

  it('irmã ANTERIOR ainda parada na fila bloqueia (o furo do tick recorrente)', () => {
    expect(bloqueia({ status: 'QUEUED', createdAt: T0 })).toBe(true);
    expect(bloqueia({ status: 'WAITING_INSTANCE', createdAt: T0 })).toBe(true);
  });

  it('empate no createdAt: o id MENOR vence — e o par tem UM vencedor só', () => {
    expect(bloqueia({ status: 'QUEUED', createdAt: T1, id: 'm-aa' })).toBe(true);
    expect(bloqueia({ status: 'QUEUED', createdAt: T1, id: 'm-zz' })).toBe(
      false,
    );
  });

  it('outra campanha VIVA do MESMO template bloqueia nas DUAS réguas', () => {
    const irma = {
      campaignId: 'campB',
      campaign: { id: 'campB', templateId: 'tplX', status: 'RUNNING' },
    };
    expect(bloqueia({ ...irma, status: 'SENT' })).toBe(true);
    expect(bloqueia({ ...irma, status: 'QUEUED', createdAt: T0 })).toBe(true);
  });

  it('campanha CANCELADA do mesmo template bloqueia o ENTREGUE — cancelar não desfaz o que chegou', () => {
    const cancelada = {
      campaignId: 'campC',
      campaign: { id: 'campC', templateId: 'tplX', status: 'CANCELLED' },
    };
    expect(bloqueia({ ...cancelada, status: 'DELIVERED' })).toBe(true);
    expect(bloqueia({ ...cancelada, status: 'READ' })).toBe(true);
  });

  /**
   * ★ I9 (revisão de integração) — E BLOQUEIA `SENT` TAMBÉM, PORQUE AS QUATRO
   * CAMADAS TÊM DE DAR A MESMA RESPOSTA.
   *
   * Este teste dizia o CONTRÁRIO, e o motivo que ele dava era bom: o incidente
   * do 9º dígito deixa mensagens presas em `SENT` para sempre. Só que a rede da
   * audiência (`CANCELLED_CAMPAIGN_BLOCKING_STATUSES`) bloqueia `SENT` desde a
   * decisão do dono (C14) — cancelar não cancela o que já está NO PROVEDOR, e
   * aquelas pessoas vão receber. Com a guarda do envio mais frouxa que o
   * recorte, a ÚLTIMA linha de defesa ficava cega justamente para o caso que a
   * auditoria mandou apertar.
   *
   * A saída para o `SENT` preso não é esta guarda ser permissiva: é
   * `releaseUnconfirmedSent` ("o canal morreu, estas nunca chegaram"), que vira
   * aquelas linhas para FAILED em massa — e FAILED não bloqueia em lugar nenhum
   * (ver o `it.each` logo abaixo).
   */
  it('I9 — SENT numa campanha CANCELADA do mesmo template BLOQUEIA (mesma régua do recorte da audiência)', () => {
    expect(
      bloqueia({
        campaignId: 'campC',
        campaign: { id: 'campC', templateId: 'tplX', status: 'CANCELLED' },
        status: 'SENT',
      }),
    ).toBe(true);
  });

  // ── O que NUNCA pode bloquear (é aqui que mora o falso positivo caro) ──────
  /**
   * A fila de uma campanha cancelada é o que o cancelamento de fato cancelou:
   * essas pessoas não receberam nada e não podem ser queimadas.
   */
  it('QUEUED numa campanha CANCELADA do mesmo template NÃO bloqueia — a fila é o que o cancelamento cancela', () => {
    for (const status of ['QUEUED', 'WAITING_INSTANCE']) {
      expect(
        bloqueia({
          campaignId: 'campC',
          campaign: { id: 'campC', templateId: 'tplX', status: 'CANCELLED' },
          status,
          createdAt: T0,
        }),
      ).toBe(false);
    }
  });

  it.each([
    'FAILED',
    'CANCELLED',
    'SKIPPED_NO_CONSENT',
    'SKIPPED_SUPPRESSED',
    'SKIPPED_NO_OPTIN',
  ])(
    'irmã %s NUNCA bloqueia — essa pessoa não recebeu nada, e queimá-la é definitivo',
    (status) => {
      expect(bloqueia({ status, createdAt: T0 })).toBe(false);
      expect(
        bloqueia({
          status,
          createdAt: T0,
          campaignId: 'campB',
          campaign: { id: 'campB', templateId: 'tplX', status: 'RUNNING' },
        }),
      ).toBe(false);
    },
  );

  it('irmã QUEUED mais NOVA não bloqueia — senão as duas se cancelam e ninguém recebe', () => {
    expect(bloqueia({ status: 'QUEUED', createdAt: T2 })).toBe(false);
  });

  it('mensagem RECEBIDA do contato (INBOUND) não bloqueia envio nenhum', () => {
    expect(bloqueia({ direction: 'INBOUND', status: 'RECEIVED' })).toBe(false);
  });

  it('mensagem de CHAT (sem campanha) não bloqueia — ela não é campanha nenhuma', () => {
    expect(bloqueia({ campaignId: null, campaign: null, status: 'SENT' })).toBe(
      false,
    );
  });

  it('campanha de OUTRO template não bloqueia', () => {
    expect(
      bloqueia({
        campaignId: 'campD',
        campaign: { id: 'campD', templateId: 'tplY', status: 'RUNNING' },
        status: 'DELIVERED',
      }),
    ).toBe(false);
  });

  it('linha de OUTRO contato nunca entra na conta', () => {
    expect(bloqueia({ contactId: 'c2', status: 'SENT' })).toBe(false);
  });

  it('a PRÓPRIA linha nunca se bloqueia (é o que deixa o redisparo passar)', () => {
    expect(bloqueia({ id: 'm-eu', status: 'SENT', createdAt: T1 })).toBe(false);
  });
});

/**
 * ── K4 × "Disparar novamente para TODOS" — A INTEGRAÇÃO ──────────────────────
 *
 * O revisor derrubou o pacote com um cenário concreto: merjado SOZINHO, este
 * commit transformaria `POST /campaigns/:id/redispatch {resendToAll:true}` num
 * no-op silencioso, porque na `main` esse botão CRIAVA uma segunda linha por
 * contato — e a segunda linha casa a guarda.
 *
 * O contrato mudou no pacote irmão (`auditoria/campanha`): existe agora um
 * índice único PARCIAL `Message_campaign_contact_live_key` sobre
 * (campaignId, contactId) restrito a OUTBOUND + estados vivos, e
 * `CampaignsRepository.createMessage({ resendReached: true })` RESSUSCITA a
 * linha existente (MESMO id, volta para QUEUED) em vez de criar outra. É por
 * isso que a guarda discrimina por `id: { not: messageId }` e não por
 * "existe alguma irmã".
 *
 * Estes dois testes são a prova de que os DOIS lados se comportam depois da
 * integração. O `findFirst` aqui NÃO devolve um valor fabricado: ele AVALIA o
 * `where` que a produção montou contra um banco de mentira — é o único jeito de
 * um teste com Prisma mockado dizer alguma coisa sobre a decisão.
 */
describe('K4 — a ressurreição legítima passa, a duplicata de verdade não', () => {
  /** Liga o `findFirst` do mock ao matcher: banco de mentira, decisão de verdade. */
  function comBanco(m: ReturnType<typeof makeProcessor>, linhas: LinhaFalsa[]) {
    m.prisma.message.findFirst.mockImplementation(
      (args: { where: Record<string, unknown> }) =>
        Promise.resolve(linhas.find((l) => casaGuarda(args.where, l)) ?? null),
    );
  }

  const CAMPANHA = { id: 'camp1', templateId: 'tpl-1', status: 'RUNNING' };
  const NASCIMENTO = new Date('2026-08-01T10:00:00.000Z');

  /**
   * O HISTÓRICO que o revisor pediu que fosse coberto: o contato tem DUAS
   * linhas antigas nesta campanha — uma FAILED (falha transitória de um lote
   * anterior) e uma CANCELLED (neutralizada pela migration da trava de banco).
   * É o mesmo pano de fundo nos dois testes abaixo; a ÚNICA diferença entre
   * eles é se o "Disparar novamente" reusou a linha ou criou uma segunda.
   */
  const HISTORICO: LinhaFalsa[] = [
    {
      id: 'm-falha-antiga',
      contactId: 'c1',
      campaignId: 'camp1',
      direction: 'OUTBOUND',
      status: 'FAILED',
      createdAt: new Date('2026-07-30T10:00:00.000Z'),
      campaign: CAMPANHA,
    },
    {
      id: 'm-neutralizada',
      contactId: 'c1',
      campaignId: 'camp1',
      direction: 'OUTBOUND',
      status: 'CANCELLED',
      createdAt: new Date('2026-07-31T10:00:00.000Z'),
      campaign: CAMPANHA,
    },
  ];

  function setup() {
    const m = makeProcessor();
    m.prisma.message.findUnique.mockResolvedValue(baseMessage());
    m.wa.send.mockResolvedValue({
      providerMessageId: 'provider-xyz',
      acceptedAt: new Date('2026-05-07T12:00:00.000Z'),
    });
    return m;
  }

  it('RESSURREIÇÃO: a mesma linha volta para QUEUED e o envio SAI, mesmo com histórico do contato', async () => {
    const m = setup();
    // O estado de produção depois do "Disparar novamente para TODOS", COM o
    // pacote irmão: a linha que já tinha sido entregue é a MESMA que volta —
    // id 'm1' preservado, status de novo QUEUED. Não existe segunda linha viva
    // (o índice único parcial do banco não deixaria).
    comBanco(m, [
      {
        id: 'm1',
        contactId: 'c1',
        campaignId: 'camp1',
        direction: 'OUTBOUND',
        status: 'QUEUED',
        createdAt: NASCIMENTO,
        campaign: CAMPANHA,
      },
      ...HISTORICO,
    ]);

    await m.processor.process(makeJob());

    expect(m.wa.send).toHaveBeenCalledTimes(1);
    expect(m.prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('DUPLICATA: MESMO histórico, mas a entrega está numa OUTRA linha (outro id) — não sai', async () => {
    const m = setup();
    // O comportamento da `main` antes do pacote irmão, e o furo que a guarda
    // existe para fechar: a entrega anterior ficou numa linha SEPARADA e esta
    // aqui é uma SEGUNDA para a mesma pessoa. Único delta em relação ao teste
    // acima: o id da linha que carrega o SENT.
    comBanco(m, [
      {
        id: 'm-irma',
        contactId: 'c1',
        campaignId: 'camp1',
        direction: 'OUTBOUND',
        status: 'SENT',
        createdAt: NASCIMENTO,
        campaign: CAMPANHA,
      },
      ...HISTORICO,
    ]);

    await m.processor.process(makeJob());

    expect(m.wa.send).not.toHaveBeenCalled();
    // O balde da tela é o mesmo "Canceladas" do kill-switch, então o que
    // distingue esta recusa é o `errorCode` — e o `errorMessage` precisa NOMEAR
    // a irmã, senão o operador não tem como saber por que a pessoa não recebeu.
    expect(m.prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          errorCode: 'duplicate_already_sent',
          errorMessage: expect.stringContaining('m-irma'),
        }),
      }),
    );
  });
});

/**
 * ── K4: O CARIMBO É CONDICIONAL ─────────────────────────────────────────────
 *
 * O `update` por id era INCONDICIONAL. Um retry gera `jobId` distinto (há
 * `Date.now()` na composição), então o BullMQ NÃO deduplica: dois jobs para o
 * MESMO `messageId` podem rodar em paralelo. Se um deles já reivindicou a linha
 * (SENDING) e está dentro do provedor, o outro carimbava CANCELLED +
 * "Não enviada para não duplicar" POR CIMA de uma mensagem que ESTÁ saindo — a
 * linha passava a mentir, e o eleitor recebeu.
 */
describe('K4 — a guarda não carimba linha que já saiu da fila', () => {
  function setup() {
    const m = makeProcessor();
    m.prisma.message.findUnique.mockResolvedValue(baseMessage());
    m.prisma.message.findFirst.mockResolvedValue({
      id: 'm-irma',
      campaignId: 'camp1',
      status: 'SENT',
    });
    m.wa.send.mockResolvedValue({
      providerMessageId: 'provider-xyz',
      acceptedAt: new Date('2026-05-07T12:00:00.000Z'),
    });
    return m;
  }

  it('a escrita é escopada à linha AINDA na fila (QUEUED/WAITING_INSTANCE)', async () => {
    const m = setup();

    await m.processor.process(makeJob());

    expect(m.prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'm1',
          status: { in: ['QUEUED', 'WAITING_INSTANCE'] },
        },
      }),
    );
  });

  it('se outro worker já reivindicou a linha, NÃO há audit nem reavaliação da campanha', async () => {
    const m = setup();
    m.prisma.message.updateMany.mockResolvedValue({ count: 0 });

    await m.processor.process(makeJob());

    expect(m.wa.send).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalledWith(
      'campaign.duplicate_blocked',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(m.campaignsService.maybeCompleteCampaign).not.toHaveBeenCalled();
  });
});
