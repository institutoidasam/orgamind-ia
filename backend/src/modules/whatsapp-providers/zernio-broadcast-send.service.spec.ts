import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ZernioBroadcastSendService,
  INDETERMINATE_DELIVERY_MARK,
} from './zernio-broadcast-send.service';
import { duplicateGuardWhere } from '../campaigns/duplicate-guard';
import { ZernioHttpError } from './zernio-api.client';

const CHANNEL_ID = 'ch1';
const CAMPAIGN_ID = 'camp1';

/** Um canal ZERNIO saudável, com broadcast LIGADO e profileId resolvido. */
function healthyChannel(over: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    provider: 'ZERNIO',
    zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    zernioProfileId: 'prof_1',
    zernioBroadcastEnabled: true,
    zernioBroadcastChunk: 50,
    dailySendLimit: 2000,
    sentTodayResetAt: new Date(),
    ...over,
  };
}

/** O desempate da guarda anti-duplicata é (createdAt, id) — fixo para poder assertar. */
const CREATED_AT = new Date('2026-08-01T12:00:00.000Z');

function makeMessage(
  id: string,
  contactId: string,
  phone: string,
  contactOver: Record<string, unknown> = {},
) {
  return {
    id,
    contactId,
    createdAt: CREATED_AT,
    campaignId: CAMPAIGN_ID,
    instanceId: CHANNEL_ID,
    status: 'QUEUED',
    variables: {},
    contact: { id: contactId, phoneE164: phone, optedOut: false, ...contactOver },
    campaign: {
      id: CAMPAIGN_ID,
      name: 'Campanha MG',
      status: 'RUNNING',
      purposeKey: 'divulgacao',
      override: false,
      overrideJustification: null,
      variableMap: {},
      templateId: 't1',
      template: {
        id: 't1',
        metaName: 'bem_vindo_mg',
        language: 'pt_BR',
        body: 'Olá!',
      },
    },
  };
}

function harness(over: {
  channel?: Record<string, unknown> | null;
  messages?: ReturnType<typeof makeMessage>[];
  suppressed?: Set<string>;
  consented?: Set<string>;
  recentRecipients?: { contactId: string }[];
  /** Irmã VIVA por contato — o que a guarda anti-duplicata encontra no banco. */
  twins?: Record<string, { id: string; campaignId: string; status: string }>;
} = {}) {
  const messages = over.messages ?? [
    makeMessage('m1', 'c1', '+5592991110001'),
    makeMessage('m2', 'c2', '+5592991110002'),
  ];
  const suppressed = over.suppressed ?? new Set<string>();
  const consented =
    over.consented ?? new Set<string>(messages.map((m) => m.contactId));

  const updated: Record<string, unknown>[] = [];

  const prisma = {
    channel: {
      findUnique: vi.fn(async () =>
        over.channel === null ? null : healthyChannel(over.channel ?? {}),
      ),
    },
    message: {
      findMany: vi.fn(async () => messages),
      // A guarda anti-duplicata. Responde pelo ARGUMENTO (`where.contactId`),
      // como o banco faria — um mock que ignorasse o where testaria a si mesmo.
      findFirst: vi.fn(
        async (a: { where: { contactId?: string } }) =>
          over.twins?.[a.where.contactId ?? ''] ?? null,
      ),
      update: vi.fn(async (a: { where: { id: string }; data: unknown }) => {
        updated.push({ id: a.where.id, ...(a.data as object) });
        return {};
      }),
      updateMany: vi.fn(async (a: { where: unknown; data: unknown }) => {
        updated.push({ many: a.where, ...(a.data as object) });
        return { count: 1 };
      }),
      groupBy: vi.fn(async () => over.recentRecipients ?? []),
      // O envio mais antigo da janela rolante — a âncora do re-enfileiramento
      // do excedente (min(sentAt) + 24h). Default: 1h atrás.
      aggregate: vi.fn(async () => ({
        _min: { sentAt: new Date(Date.now() - 60 * 60 * 1000) },
      })),
    },
    zernioBroadcast: {
      create: vi.fn(async (a: { data: { zernioId: string } }) => ({
        id: `local_${a.data.zernioId}`,
        zernioId: a.data.zernioId,
      })),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  };

  const consent = {
    isSuppressed: vi.fn(async (phone: string) => suppressed.has(phone)),
    hasConsent: vi.fn(async (contactId: string) => consented.has(contactId)),
    hashOf: vi.fn((p: string) => `h(${p})`),
  };

  const campaignsRepo = {
    findContactsWithOpenWindow: vi.fn(async () => new Set<string>()),
    claimForSend: vi.fn(async () => 1),
    releaseClaim: vi.fn(async () => 1),
    createSkippedMessage: vi.fn(async () => ({})),
    markMessageEnqueueFailed: vi.fn(async () => ({})),
  };

  const client = {
    createBroadcast: vi.fn(async () => 'bc_zernio_1'),
    addRecipients: vi.fn(async () => ({ added: 2, skipped: 0, chunkUsed: 50 })),
    sendBroadcast: vi.fn(async () => ({
      status: 'sending',
      sent: 0,
      failed: 0,
      recipientCount: 2,
    })),
    cancelBroadcast: vi.fn(async () => true),
    listRecipients: vi.fn(async () => ({ items: [], hasMore: false, total: 0 })),
  };

  const redis = {
    pttl: vi.fn(async () => -2),
    del: vi.fn(async () => 1),
  };

  const sendQueue = { add: vi.fn(async () => ({ id: 'j' })) };
  const pollQueue = { add: vi.fn(async () => ({ id: 'p' })) };
  const dispatchQueue = { add: vi.fn(async () => ({ id: 'd' })) };

  const audit = { log: vi.fn(async () => undefined) };

  const svc = new ZernioBroadcastSendService(
    prisma as never,
    client as never,
    consent as never,
    campaignsRepo as never,
    redis as never,
    sendQueue as never,
    pollQueue as never,
    dispatchQueue as never,
    audit as never,
  );

  return { svc, prisma, client, consent, campaignsRepo, redis, sendQueue, pollQueue, dispatchQueue, audit, updated };
}

describe('dispatchBatch — o GATE roda POR CONTATO, ANTES de montar o broadcast', () => {
  it('★ quem não tem consentimento vira uma linha SKIPPED_NO_CONSENT — a PROVA, por pessoa', async () => {
    const h = harness({ consented: new Set(['c1']) }); // c2 NÃO consentiu

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    // A linha do pulado é gravada NOMINALMENTE, não como contador agregado.
    expect(h.campaignsRepo.createSkippedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c2', reason: 'no_consent' }),
    );

    // E o broadcast sai só com QUEM PODE receber.
    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
  });

  it('★ suprimido (opt-out) NUNCA entra no broadcast', async () => {
    const h = harness({ suppressed: new Set(['+5592991110002']) });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
  });

  /**
   * ★ Decisão do cliente, 25/08/2026 — a barreira de ENVIO por
   * `Contact.optedOut` saiu também do broadcast (risco de LGPD/WhatsApp
   * apresentado e aceito). O booleano é CACHE; a `SuppressionList` por
   * `phoneHash` — a chave durável — continua valendo e é o teste acima que a
   * prova.
   *
   * RED antes desta mudança: `c2` era cancelada com `opted_out` e o broadcast
   * saía só com `+5592991110001`.
   */
  it('★ optedOut sozinho NÃO barra mais — sem SuppressionList o contato ENTRA no broadcast', async () => {
    const h = harness({
      messages: [
        makeMessage('m1', 'c1', '+5592991110001'),
        makeMessage('m2', 'c2', '+5592991110002', { optedOut: true }),
      ],
    });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001', '+5592991110002'],
      50,
    );
    expect(h.updated).not.toContainEqual(
      expect.objectContaining({ errorCode: 'opted_out' }),
    );
  });

  it('★ optedOut + SuppressionList: a lista durável continua cancelando com "opted_out"', async () => {
    const h = harness({
      messages: [
        makeMessage('m1', 'c1', '+5592991110001'),
        makeMessage('m2', 'c2', '+5592991110002', { optedOut: true }),
      ],
      suppressed: new Set(['+5592991110002']),
    });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
    expect(h.updated).toContainEqual(
      expect.objectContaining({ id: 'm2', status: 'CANCELLED', errorCode: 'opted_out' }),
    );
  });

  it('★ optedOut liberado NÃO fura o gate de consentimento — a linha SKIPPED_NO_CONSENT continua', async () => {
    const h = harness({
      messages: [
        makeMessage('m1', 'c1', '+5592991110001'),
        makeMessage('m2', 'c2', '+5592991110002', { optedOut: true }),
      ],
      consented: new Set(['c1']), // c2 NÃO consentiu a finalidade
    });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.campaignsRepo.createSkippedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c2', reason: 'no_consent' }),
    );
    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
  });

  it('gate reprovou TODO MUNDO => NENHUMA chamada ao Zernio (não cria disparo vazio)', async () => {
    const h = harness({ consented: new Set() });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.createBroadcast).not.toHaveBeenCalled();
    expect(h.client.sendBroadcast).not.toHaveBeenCalled();
  });
});

describe('dispatchBatch — falha ALTO E CLARO, nunca em silêncio', () => {
  it('★ canal SEM zernioProfileId => falha antes de qualquer chamada ao Zernio', async () => {
    const h = harness({ channel: { zernioProfileId: null } });

    await expect(
      h.svc.dispatchBatch({
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      }),
    ).rejects.toThrow(/profileId/i);

    expect(h.client.createBroadcast).not.toHaveBeenCalled();
  });

  it('canal sem zernioAccountId => idem', async () => {
    const h = harness({ channel: { zernioAccountId: null } });
    await expect(
      h.svc.dispatchBatch({
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1'],
      }),
    ).rejects.toThrow(/accountId/i);
    expect(h.client.createBroadcast).not.toHaveBeenCalled();
  });
});

describe('dispatchBatch — variáveis por contato NÃO podem ir por broadcast', () => {
  it('★ {{1}} = nome do contato => CAI PARA O 1-a-1, e o Zernio nem é chamado', async () => {
    // O broadcast do Zernio resolve variáveis contra o CRM DELE, e o destinatário
    // adicionado por telefone nasce lá SEM nome: sairia "Olá , tudo bem?".
    const messages = [makeMessage('m1', 'c1', '+5592991110001')];
    messages[0].campaign.variableMap = {
      '1': { source: 'field', field: 'name' },
    } as never;
    const h = harness({ messages });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1'],
    });

    expect(h.client.createBroadcast).not.toHaveBeenCalled();
    // O fallback é o envio 1-a-1 — que monta a variável do NOSSO banco.
    expect(h.sendQueue.add).toHaveBeenCalledTimes(1);
  });

  it('variáveis LITERAIS => vão por broadcast, como customValue', async () => {
    const messages = [makeMessage('m1', 'c1', '+5592991110001')];
    messages[0].campaign.variableMap = {
      '1': { source: 'literal', value: 'Matheus' },
    } as never;
    const h = harness({ messages });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1'],
    });

    expect(h.client.createBroadcast).toHaveBeenCalledWith(
      CHANNEL_ID,
      expect.objectContaining({
        variableMapping: { '1': { field: 'custom', customValue: 'Matheus' } },
      }),
    );
  });
});

describe('dispatchBatch — caminho feliz', () => {
  it('cria → adiciona → dispara, e liga as Messages ao disparo', async () => {
    const h = harness();

    const res = await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.createBroadcast).toHaveBeenCalledTimes(1);
    expect(h.client.addRecipients).toHaveBeenCalledTimes(1);
    expect(h.client.sendBroadcast).toHaveBeenCalledWith(CHANNEL_ID, 'bc_zernio_1');

    // O espelho local nasce com o campaignId — é o que liga o disparo do painel
    // do Zernio à campanha do orgamind.
    expect(h.prisma.zernioBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          zernioId: 'bc_zernio_1',
          campaignId: CAMPAIGN_ID,
          channelId: CHANNEL_ID,
        }),
      }),
    );

    // E o polling é agendado — é ele (não o webhook) a fonte da verdade.
    expect(h.pollQueue.add).toHaveBeenCalled();
    expect(res.sent).toBe(2);
  });

  it('★ o claim (QUEUED→SENDING) roda por mensagem: ninguém envia duas vezes', async () => {
    const h = harness();
    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });
    expect(h.campaignsRepo.claimForSend).toHaveBeenCalledWith('m1');
    expect(h.campaignsRepo.claimForSend).toHaveBeenCalledWith('m2');
  });

  it('★ claim PERDIDO (outra tentativa já pegou) => aquele telefone não entra', async () => {
    const h = harness();
    h.campaignsRepo.claimForSend.mockImplementation(async (id: string) =>
      id === 'm2' ? 0 : 1,
    );

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
  });
});

describe('dispatchBatch — TETO DO TIER (2.000 únicos/24h). Quem conta é o ORGAMIND.', () => {
  it('★ a janela rolante já está cheia => NADA sai, e o lote INTEIRO é re-enfileirado para a próxima janela', async () => {
    const recent = Array.from({ length: 2000 }, (_, i) => ({
      contactId: `outro${i}`,
    }));
    const h = harness({ recentRecipients: recent });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.createBroadcast).not.toHaveBeenCalled();
    // "O excedente entra em fila até o limite resetar": o pedaço que não coube
    // volta para a PRÓPRIA fila, adiado — sem isso as mensagens ficavam QUEUED
    // sem nenhum job e a campanha "Em execução" para sempre.
    expect(h.dispatchQueue.add).toHaveBeenCalledTimes(1);
    const [, payload, opts] = h.dispatchQueue.add.mock.calls[0] as [
      string,
      { messageIds: string[] },
      { delay: number },
    ];
    expect(payload.messageIds).toEqual(['m1', 'm2']);
    expect(opts.delay).toBeGreaterThan(0);
  });

  it('★ cabe só 1 no teto => o broadcast leva 1, e o OUTRO é re-enfileirado para a próxima janela', async () => {
    const recent = Array.from({ length: 1999 }, (_, i) => ({
      contactId: `outro${i}`,
    }));
    const h = harness({ recentRecipients: recent });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
    expect(h.dispatchQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = h.dispatchQueue.add.mock.calls[0] as [
      string,
      { messageIds: string[] },
    ];
    expect(payload.messageIds).toEqual(['m2']);
  });

  it('quando TUDO cabe no teto, nada é re-enfileirado', async () => {
    const h = harness();

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.dispatchQueue.add).not.toHaveBeenCalled();
  });

  it('campanha CANCELADA não re-enfileira nada — o ciclo termina', async () => {
    const messages = [
      makeMessage('m1', 'c1', '+5592991110001'),
      makeMessage('m2', 'c2', '+5592991110002'),
    ];
    for (const m of messages) m.campaign.status = 'CANCELLED';
    const recent = Array.from({ length: 2000 }, (_, i) => ({
      contactId: `outro${i}`,
    }));
    const h = harness({ messages, recentRecipients: recent });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.dispatchQueue.add).not.toHaveBeenCalled();
    expect(h.client.createBroadcast).not.toHaveBeenCalled();
  });

  it('falha ao re-enfileirar NÃO derruba o disparo que coube — e o excedente vira FAILED recuperável, nunca órfão', async () => {
    const recent = Array.from({ length: 1999 }, (_, i) => ({
      contactId: `outro${i}`,
    }));
    const h = harness({ recentRecipients: recent });
    h.dispatchQueue.add.mockRejectedValueOnce(new Error('redis fora'));

    const res = await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    // O que coube saiu…
    expect(res.sent).toBe(1);
    expect(h.client.createBroadcast).toHaveBeenCalledTimes(1);
    // …e o excedente NÃO fica QUEUED sem job (beco sem saída: o redisparo
    // recusa enquanto countInFlight > 0). FAILED com código próprio é o estado
    // que o "Reenviar falhas" da tela recupera.
    expect(h.campaignsRepo.markMessageEnqueueFailed).toHaveBeenCalledWith(
      'm2',
      expect.stringContaining('Reenviar falhas'),
      'zernio.broadcast_requeue_failed',
    );
  });

  it('a âncora do re-enfileiramento é a JANELA ROLANTE: acorda quando o envio mais antigo completa 24h', async () => {
    const recent = Array.from({ length: 2000 }, (_, i) => ({
      contactId: `outro${i}`,
    }));
    const h = harness({ recentRecipients: recent });
    // O envio mais antigo da janela foi há 1h → a janela abre em ~23h.
    // Acordar em qualquer âncora de "reset diário" seria acordar com a janela
    // garantidamente ainda cheia (o bug do ciclo de zero envio).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    h.prisma.message.aggregate.mockResolvedValue({ _min: { sentAt: oneHourAgo } } as never);

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    const [, , opts] = h.dispatchQueue.add.mock.calls[0] as [
      string,
      unknown,
      { delay: number; jobId?: string },
    ];
    const expected = 23 * 60 * 60 * 1000 + 5 * 60_000; // 23h + folga de 5min
    expect(opts.delay).toBeGreaterThan(expected - 60_000);
    expect(opts.delay).toBeLessThan(expected + 60_000);
    // SEM jobId customizado: um id determinístico repetido entre ciclos
    // colidiria com o próprio job e o BullMQ descartaria o excedente em
    // silêncio (handleDuplicatedJob) — QUEUED órfão para sempre.
    expect(opts.jobId).toBeUndefined();
  });

  it('mantém o claim vivo (heartbeat no sendingAt) durante a fase longa de addRecipients', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let releaseAdd!: () => void;
      h.client.addRecipients.mockImplementation(
        () =>
          new Promise((res) => {
            releaseAdd = () =>
              res({ added: 2, skipped: 0, chunkUsed: 50 } as never);
          }),
      );

      const run = h.svc.dispatchBatch({
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      });
      // Deixa o fluxo chegar ao addRecipients (microtasks) e então atravessa
      // a marca dos 4 min com a chamada ainda em voo.
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000);

      // O reconciler mata SENDING parado há 10 min ('sending_stuck') — mas
      // estes telefones JÁ estão entrando no broadcast. O heartbeat renova o
      // sendingAt enquanto o processo vive; se ele morrer, o reconciler age.
      const heartbeatCall = h.prisma.message.updateMany.mock.calls.find(
        ([a]) =>
          (a as { data: Record<string, unknown> }).data.sendingAt !== undefined &&
          (a as { data: Record<string, unknown> }).data.status === undefined,
      );
      expect(heartbeatCall).toBeDefined();

      releaseAdd();
      await vi.runOnlyPendingTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancelForCampaign — o KILL-SWITCH', () => {
  it('★ cancela no Zernio TODO disparo vivo da campanha', async () => {
    const h = harness();
    (h.prisma as never as {
      zernioBroadcast: { findMany: ReturnType<typeof vi.fn> };
    }).zernioBroadcast.findMany = vi.fn(async () => [
      { id: 'l1', zernioId: 'bc_a', channelId: CHANNEL_ID },
      { id: 'l2', zernioId: 'bc_b', channelId: CHANNEL_ID },
    ]);

    const n = await h.svc.cancelForCampaign(CAMPAIGN_ID);

    expect(h.client.cancelBroadcast).toHaveBeenCalledWith(CHANNEL_ID, 'bc_a');
    expect(h.client.cancelBroadcast).toHaveBeenCalledWith(CHANNEL_ID, 'bc_b');
    expect(n).toBe(2);
    // O espelho local vira 'cancelled' — é o que torna o kill-switch idempotente
    // (CANCELLABLE_STATUSES não o pega de novo no próximo disparo do gatilho).
    expect(h.prisma.zernioBroadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'l1' },
        data: { status: 'cancelled' },
      }),
    );
  });

  it('um cancelamento que falha NÃO impede os outros (best-effort)', async () => {
    const h = harness();
    (h.prisma as never as {
      zernioBroadcast: { findMany: ReturnType<typeof vi.fn> };
    }).zernioBroadcast.findMany = vi.fn(async () => [
      { id: 'l1', zernioId: 'bc_a', channelId: CHANNEL_ID },
      { id: 'l2', zernioId: 'bc_b', channelId: CHANNEL_ID },
    ]);
    h.client.cancelBroadcast.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const n = await h.svc.cancelForCampaign(CAMPAIGN_ID);
    expect(h.client.cancelBroadcast).toHaveBeenCalledTimes(2);
    expect(n).toBe(1);
  });
});

describe('dispatchBatch — o POST /send que NÃO RESPONDEU: entrega INDETERMINADA', () => {
  /**
   * ★ O cenário que este bloco existe para impedir.
   *
   * O `POST /broadcasts/{id}/send` do Zernio NÃO aceita `Idempotency-Key`. Se ele
   * dá TIMEOUT, o Zernio pode ter recebido o disparo e estar entregando AGORA —
   * ou pode não ter recebido nada. O sistema NÃO SABE. Devolver o lote para
   * QUEUED é apostar em "não recebeu": quando a aposta erra, o lote inteiro é
   * remontado e milhares de eleitores recebem a mesma propaganda duas vezes.
   *
   * Diante da dúvida, o lote fica FORA de todo caminho de reenvio (SENT, amarrado
   * ao disparo) e quem descobre a verdade é o reconciliador — o webhook e o
   * polling por destinatário, que já existem.
   */
  const timeout = () =>
    new ZernioHttpError(
      undefined,
      undefined,
      'post',
      '/broadcasts/bc_zernio_1/send',
    );

  it('★ timeout no /send: NINGUÉM volta para QUEUED — o lote não pode ser disparado duas vezes', async () => {
    const h = harness();
    h.client.sendBroadcast.mockRejectedValueOnce(timeout());

    const res = await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    // 1. Nenhuma mensagem volta para QUEUED: QUEUED é o estado "pode ser
    //    reivindicado de novo", e reivindicar de novo é reenviar.
    expect(h.campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    // 2. As linhas ficam SENT, amarradas ao disparo — é assim que o webhook as
    //    acha pelo telefone e carimba o wamid.
    const calls = h.prisma.message.updateMany.mock.calls as unknown as [
      { where: { id: { in: string[] } }; data: Record<string, unknown> },
    ][];
    const sent = calls
      .map(([a]) => a)
      .find((a) => a.data.status === 'SENT');
    expect(sent).toBeDefined();
    expect(sent!.where.id.in).toEqual(['m1', 'm2']);
    expect(sent!.data.zernioBroadcastId).toBe('local_bc_zernio_1');
    // 3. O reconciliador é agendado: é ele quem descobre o que o Zernio fez.
    expect(h.pollQueue.add).toHaveBeenCalled();
    // 4. E o lote é contabilizado como INDETERMINADO — não como sucesso mudo.
    expect(res.indeterminate).toBe(2);
  });

  it('★ timeout no /send: NÃO cancela o disparo — cancelar é entregar metade e marcar tudo como enviado', async () => {
    const h = harness();
    h.client.sendBroadcast.mockRejectedValueOnce(timeout());

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    // O cancelamento best-effort era a aposta antiga ("cancelo antes que
    // entregue"). Ele PERDE nos dois lados: se o Zernio está fora (a causa
    // provável do timeout), o cancel falha junto; se está no ar, o cancel aborta
    // no meio um disparo cujas linhas já contam como enviadas.
    expect(h.client.cancelBroadcast).not.toHaveBeenCalled();
  });

  it('5xx no /send é INDETERMINADO do mesmo jeito (o servidor pode ter processado)', async () => {
    const h = harness();
    h.client.sendBroadcast.mockRejectedValueOnce(
      new ZernioHttpError(502, { error: 'bad gateway' }, 'post', '/send'),
    );

    const res = await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.campaignsRepo.releaseClaim).not.toHaveBeenCalled();
    expect(res.indeterminate).toBe(2);
  });

  it('400 no /send é RECUSA NA PORTA: aí sim o lote volta para QUEUED e o rascunho é cancelado', async () => {
    const h = harness();
    h.client.sendBroadcast.mockRejectedValueOnce(
      new ZernioHttpError(400, { error: 'no recipients' }, 'post', '/send'),
    );

    await expect(
      h.svc.dispatchBatch({
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      }),
    ).rejects.toThrow();

    // Uma recusa COM corpo é prova de que nada saiu: retentar é o certo.
    expect(h.campaignsRepo.releaseClaim).toHaveBeenCalledWith('m1');
    expect(h.campaignsRepo.releaseClaim).toHaveBeenCalledWith('m2');
    expect(h.client.cancelBroadcast).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
    );
  });

  it('falha ANTES do /send (addRecipients) volta para QUEUED — o disparo nunca começou', async () => {
    const h = harness();
    h.client.addRecipients.mockRejectedValueOnce(
      new ZernioHttpError(undefined, undefined, 'post', '/recipients'),
    );

    await expect(
      h.svc.dispatchBatch({
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      }),
    ).rejects.toThrow();

    expect(h.client.sendBroadcast).not.toHaveBeenCalled();
    expect(h.campaignsRepo.releaseClaim).toHaveBeenCalledWith('m1');
    expect(h.campaignsRepo.releaseClaim).toHaveBeenCalledWith('m2');
  });
});

/** Todos os `updateMany` que o serviço fez, na ordem. */
function updateManyCalls(h: ReturnType<typeof harness>) {
  return (
    h.prisma.message.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][]
  ).map(([a]) => a);
}

/** O erro que `dispatchBatch` relançou — é ele que carrega quem tem dono. */
async function dispatchAndCatch(
  h: ReturnType<typeof harness>,
  messageIds: string[],
): Promise<unknown> {
  return h.svc
    .dispatchBatch({ campaignId: CAMPAIGN_ID, channelId: CHANNEL_ID, messageIds })
    .then(
      () => {
        throw new Error('era para ter falhado');
      },
      (e: unknown) => e,
    );
}

describe('failOrphanedBatch — QUEUED sem job é beco sem saída', () => {
  it('★ esgotadas as retentativas, o lote devolvido a QUEUED vira FALHA RECUPERÁVEL', async () => {
    const h = harness();

    await h.svc.failOrphanedBatch(
      {
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      },
      new Error('rede caiu'),
    );

    // Sem isto, um dispatch que falhou de vez deixa o lote QUEUED sem NENHUM job
    // para buscá-lo: a campanha fica "Em execução" para sempre e o redisparo
    // recusa (countInFlight conta QUEUED). O código é RETENTÁVEL de propósito —
    // aqui sabemos que nada foi enviado.
    //
    // UMA ida ao banco para o lote inteiro (eram 2.000 updates em série,
    // disparados e esquecidos dentro de um @OnWorkerEvent), escopada a QUEUED:
    // linha que outro ator já levou não é tocada.
    const fail = updateManyCalls(h).find((a) => a.data.status === 'FAILED');
    expect(fail).toBeDefined();
    expect(fail!.where.id).toEqual({ in: ['m1', 'm2'] });
    expect(fail!.where.status).toBe('QUEUED');
    expect(fail!.data.errorCode).toBe('zernio.broadcast_dispatch_failed');
    expect(fail!.data.errorMessage).toEqual(
      expect.stringContaining('Reenviar falhas'),
    );
  });

  it('★ REGRESSÃO: o excedente do teto de 24h TEM job adiado — não pode virar FAILED', async () => {
    // O cenário NORMAL de uma campanha de 13.000 com teto de 2.000/24h: todo
    // lote gera excedente. O excedente é re-enfileirado (dispatchQueue.add com
    // delay) e fica QUEUED DE PROPÓSITO, esperando o job adiado acordar. Se um
    // erro do Zernio (429/502/400 — o dossiê os documenta como frequentes)
    // levasse o lote INTEIRO ao failOrphanedBatch, centenas de mensagens COM
    // DONO virariam falha e o job adiado acordaria para não achar ninguém.
    const messages = [
      makeMessage('m1', 'c1', '+5592991110001'),
      makeMessage('m2', 'c2', '+5592991110002'),
      makeMessage('m3', 'c3', '+5592991110003'),
    ];
    const h = harness({ messages, channel: { dailySendLimit: 1 } });
    h.client.sendBroadcast.mockRejectedValueOnce(
      new ZernioHttpError(400, { error: 'no recipients' }, 'post', '/send'),
    );

    const err = await dispatchAndCatch(h, ['m1', 'm2', 'm3']);

    // O excedente foi entregue a OUTRO dono: um job adiado desta mesma fila.
    const [, payload] = h.dispatchQueue.add.mock.calls[0] as unknown as [
      string,
      { messageIds: string[] },
    ];
    expect(payload.messageIds).toEqual(['m2', 'm3']);

    // …e o último suspiro só pode alcançar o que ficou ÓRFÃO de verdade.
    await h.svc.failOrphanedBatch(
      {
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2', 'm3'],
      },
      err,
    );

    const fail = updateManyCalls(h).find((a) => a.data.status === 'FAILED');
    expect(fail).toBeDefined();
    expect(fail!.where.id).toEqual({ in: ['m1'] });
  });

  it('★ REGRESSÃO: quem foi mandado para o 1-a-1 (cap 131049) também tem dono', async () => {
    // O bloqueado pelo cap de MARKETING da Meta sai do broadcast e entra na fila
    // 1-a-1, que sabe adiar o job até o fim das 24h. Ele continua QUEUED até o
    // processor 1-a-1 dar o claim — matá-lo aqui é tirar a mensagem de uma fila
    // que ia entregá-la.
    const h = harness();
    h.redis.pttl.mockImplementation((async (key: string) =>
      key.includes('+5592991110002') ? 3600_000 : -2) as never);
    h.client.sendBroadcast.mockRejectedValueOnce(
      new ZernioHttpError(400, { error: 'no recipients' }, 'post', '/send'),
    );

    const err = await dispatchAndCatch(h, ['m1', 'm2']);

    expect(h.sendQueue.add).toHaveBeenCalledTimes(1);

    await h.svc.failOrphanedBatch(
      {
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      },
      err,
    );

    const fail = updateManyCalls(h).find((a) => a.data.status === 'FAILED');
    expect(fail).toBeDefined();
    expect(fail!.where.id).toEqual({ in: ['m1'] });
  });

  it('falha ANTES de qualquer entrega a outro dono => o lote INTEIRO é resgatado', async () => {
    // A outra ponta do mesmo achado: escopar demais deixaria QUEUED órfão, que é
    // o bug que este método existe para matar. Canal sem profileId estoura antes
    // do gate — ninguém foi re-enfileirado, ninguém foi para o 1-a-1.
    const h = harness({ channel: { zernioProfileId: null } });

    const err = await dispatchAndCatch(h, ['m1', 'm2']);

    await h.svc.failOrphanedBatch(
      {
        campaignId: CAMPAIGN_ID,
        channelId: CHANNEL_ID,
        messageIds: ['m1', 'm2'],
      },
      err,
    );

    const fail = updateManyCalls(h).find((a) => a.data.status === 'FAILED');
    expect(fail).toBeDefined();
    expect(fail!.where.id).toEqual({ in: ['m1', 'm2'] });
  });
});

describe('★ K4 no BROADCAST — "esta pessoa já recebeu?" também vale aqui', () => {
  /**
   * O worker 1-a-1 (send-message.processor) ganhou a guarda anti-duplicata, mas
   * quando o canal é ZERNIO com broadcast LIGADO o disparo NÃO passa por lá: a
   * campanha enfileira UM job de broadcast e este serviço monta o lote sozinho.
   * O laço de reavaliação daqui espelha os gates do worker (opt-out, supressão,
   * consentimento, cap 131049) — faltava exatamente a pergunta que impede a
   * mesma pessoa de receber a mesma propaganda eleitoral duas vezes.
   */
  it('★ contato com irmã SENT NÃO entra no broadcast — e a linha vira CANCELLED, não some', async () => {
    const h = harness({
      twins: {
        c2: { id: 'irma', campaignId: CAMPAIGN_ID, status: 'SENT' },
      },
    });

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    // O telefone de c2 não vai para o Zernio.
    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001'],
      50,
    );
    // E o pulo é AUDITÁVEL: mesmo status, mesmo errorCode e mesma auditoria do
    // worker 1-a-1 — senão o eleitor sumiria da campanha em silêncio.
    const blocked = h.updated.find((u) => u.id === 'm2');
    expect(blocked).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'duplicate_already_sent',
    });
    expect(h.audit.log).toHaveBeenCalledWith(
      'campaign.duplicate_blocked',
      'Message',
      'm2',
      expect.objectContaining({ blockedByMessageId: 'irma' }),
    );
  });

  it('★ a pergunta é feita com o MESMO predicado do worker (é o argumento que importa)', async () => {
    const h = harness();

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    const [arg] = h.prisma.message.findFirst.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(arg.where).toEqual(
      duplicateGuardWhere({
        messageId: 'm1',
        contactId: 'c1',
        campaignId: CAMPAIGN_ID,
        templateId: 't1',
        createdAt: CREATED_AT,
      }),
    );
    // A linha EM AVALIAÇÃO nunca bloqueia a si mesma (é o que separa duplicata
    // de redisparo legítimo).
    expect(arg.where.id).toEqual({ not: 'm1' });
  });

  it('sem irmã, ninguém é bloqueado — o falso positivo é o dano caro aqui', async () => {
    const h = harness();

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    expect(h.client.addRecipients).toHaveBeenCalledWith(
      CHANNEL_ID,
      'bc_zernio_1',
      ['+5592991110001', '+5592991110002'],
      50,
    );
    expect(h.updated.some((u) => u.errorCode === 'duplicate_already_sent')).toBe(
      false,
    );
  });
});

describe('★ ENTREGA INDETERMINADA — a instrução ao operador precisa ser EXECUTÁVEL', () => {
  const timeoutErr = () =>
    new ZernioHttpError(undefined, undefined, 'post', '/broadcasts/x/send');

  it('★ a linha recebe um MARCADOR estável — é por ele que o produto consegue listá-la', async () => {
    const h = harness();
    h.client.sendBroadcast.mockRejectedValueOnce(timeoutErr());

    await h.svc.dispatchBatch({
      campaignId: CAMPAIGN_ID,
      channelId: CHANNEL_ID,
      messageIds: ['m1', 'm2'],
    });

    const sent = updateManyCalls(h).find((a) => a.data.status === 'SENT');
    expect(sent).toBeDefined();
    // Sem marcador, a linha indeterminada é indistinguível de uma SENT normal
    // (as duas ficam SENT + zernioBroadcastId + providerMessageId nulo até o
    // webhook chegar) e NENHUMA consulta consegue separá-las — a instrução
    // "confira o painel do Zernio" viraria uma ordem que ninguém executa.
    expect(sent!.data.errorMessage).toEqual(
      expect.stringContaining(INDETERMINATE_DELIVERY_MARK),
    );
    // E o texto não pode mandar o operador apertar um botão que não faz nada:
    // essas linhas contam como RECEBIDAS, então "Disparar novamente" (modo
    // padrão, `unreached`) as ignora em silêncio.
    expect(sent!.data.errorMessage).toEqual(
      expect.stringContaining('Disparar novamente'),
    );
  });
});

