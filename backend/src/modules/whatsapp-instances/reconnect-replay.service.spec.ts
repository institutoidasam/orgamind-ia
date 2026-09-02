import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ReconnectReplayService } from './reconnect-replay.service';

describe('ReconnectReplayService', () => {
  let svc: ReconnectReplayService;
  let prisma: MockProxy<PrismaService>;
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    queue = { add: vi.fn() };
    svc = new ReconnectReplayService(prisma, queue as any);
  });

  it('reads the exact WAITING_INSTANCE rows, claims them by id, then enqueues exactly those', async () => {
    prisma.message.findMany.mockResolvedValueOnce([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
      { id: 'm2', campaignId: 'c1', contactId: 'co2' },
    ] as any);
    prisma.message.updateMany.mockResolvedValueOnce({ count: 2 } as any);

    await svc.replayWaitingFor('inst-a');

    // The rows to replay must be read (by WAITING_INSTANCE) BEFORE the claim,
    // so the claim + enqueue target the exact cohort — never pre-existing
    // QUEUED-with-live-job rows for the same instance.
    const findOrder = prisma.message.findMany.mock.invocationCallOrder[0];
    const updateOrder = prisma.message.updateMany.mock.invocationCallOrder[0];
    expect(findOrder).toBeLessThan(updateOrder!);

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instanceId: 'inst-a', status: 'WAITING_INSTANCE' },
      }),
    );
    // The claim is scoped to the exact ids we just read (not status='QUEUED').
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] }, status: 'WAITING_INSTANCE' },
      data: { status: 'QUEUED' },
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith('send-message', {
      messageId: 'm1',
      campaignId: 'c1',
      contactId: 'co1',
    });
    expect(queue.add).toHaveBeenCalledWith('send-message', {
      messageId: 'm2',
      campaignId: 'c1',
      contactId: 'co2',
    });
  });

  it('never re-selects rows to enqueue by status=QUEUED (would pick pre-existing campaign rows)', async () => {
    prisma.message.findMany.mockResolvedValueOnce([
      { id: 'w1', campaignId: 'c1', contactId: 'co1' },
    ] as any);
    prisma.message.updateMany.mockResolvedValueOnce({ count: 1 } as any);

    await svc.replayWaitingFor('inst-a');

    // No query may filter by status:'QUEUED' — that filter also matches
    // pre-existing campaign messages (created QUEUED with the same instanceId
    // and a live job), letting the wrong cohort be enqueued and stranding the
    // just-reconnected rows in QUEUED with no job.
    for (const call of prisma.message.findMany.mock.calls) {
      expect((call[0] as any)?.where?.status).not.toBe('QUEUED');
    }
  });

  it('is a no-op when there are no waiting messages (no claim, no enqueue)', async () => {
    prisma.message.findMany.mockResolvedValueOnce([] as any);

    await svc.replayWaitingFor('inst-x');

    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does NOT touch messages of other instances', async () => {
    prisma.message.findMany.mockResolvedValueOnce([] as any);

    await svc.replayWaitingFor('inst-target');

    const call = prisma.message.findMany.mock.calls[0]?.[0];
    expect((call as any)?.where).toEqual({
      instanceId: 'inst-target',
      status: 'WAITING_INSTANCE',
    });
  });

  it('marks a message FAILED and continues when its enqueue throws (no silent QUEUED strand)', async () => {
    prisma.message.findMany.mockResolvedValueOnce([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
      { id: 'm2', campaignId: 'c1', contactId: 'co2' },
      { id: 'm3', campaignId: 'c1', contactId: 'co3' },
    ] as any);
    prisma.message.updateMany
      .mockResolvedValueOnce({ count: 3 } as any) // the atomic claim
      .mockResolvedValueOnce({ count: 1 } as any); // the enqueue-failed write for m2

    queue.add
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);

    // Must not reject — a mid-loop enqueue failure is compensated, not thrown.
    await expect(svc.replayWaitingFor('inst-a')).resolves.toBeUndefined();

    // The loop kept going after m2 failed, so m3 was still attempted.
    expect(queue.add).toHaveBeenCalledTimes(3);

    // The failed row is marked FAILED (enqueue_failed) so it doesn't sit in
    // QUEUED forever with no job. Scoped to status='QUEUED': if some other
    // actor already moved the row on (job made it into the queue, a worker
    // claimed it), this write must not clobber that.
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: 'm2', status: 'QUEUED' },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'enqueue_failed',
      }),
    });
    // One updateMany for the atomic claim + one for the single failed row.
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(2);
    // The unscoped .update must never be used for this write.
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('does not throw and keeps looping when the enqueue-failed write matches no row (row already moved past QUEUED)', async () => {
    prisma.message.findMany.mockResolvedValueOnce([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
      { id: 'm2', campaignId: 'c1', contactId: 'co2' },
    ] as any);
    prisma.message.updateMany
      .mockResolvedValueOnce({ count: 2 } as any) // the atomic claim
      // The enqueue-failed write for m1 matches 0 rows: some other actor
      // already moved it past QUEUED (e.g. a worker claimed it into SENDING).
      .mockResolvedValueOnce({ count: 0 } as any);

    queue.add
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);

    // Must not reject even though the compensating write matched nothing.
    await expect(svc.replayWaitingFor('inst-a')).resolves.toBeUndefined();

    // The loop still continued to m2 after m1's compensating write no-op'd.
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('does NOT enqueue twice when called concurrently (atomic claim)', async () => {
    // Both concurrent calls read the same waiting rows first.
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
      { id: 'm2', campaignId: 'c1', contactId: 'co2' },
    ] as any);
    // Only one call wins the atomic claim (count=2); the other flips 0 and exits.
    prisma.message.updateMany
      .mockResolvedValueOnce({ count: 2 } as any)
      .mockResolvedValueOnce({ count: 0 } as any);

    await Promise.all([
      svc.replayWaitingFor('inst-a'),
      svc.replayWaitingFor('inst-a'),
    ]);

    // Should only enqueue 2 jobs total, not 4.
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});

/**
 * INCIDENTE 2026-08-12/14 — 488 mensagens órfãs.
 *
 * A campanha foi criada apontando para um canal; o canal foi APAGADO (soft
 * delete) e o mesmo número foi reconectado num REGISTRO NOVO, com id novo. As
 * mensagens seguiram apontando para o canal morto: o reconciliador acordava o
 * canal vivo, perguntava "tem mensagem parada para ESTE id?", ouvia não, e as
 * 488 ficavam paradas para sempre. Reconectar o número não resolvia — o vínculo
 * quebrado era com o REGISTRO do canal, não com o WhatsApp.
 *
 * A adoção é deliberadamente CONSERVADORA: só migra quando o canal vivo tem o
 * MESMO provedor e o MESMO número do canal morto. Mesmo número = mesmo
 * remetente, então ninguém do outro lado percebe diferença. Sem essa igualdade
 * a migração mandaria a mensagem por outro número — pior que deixá-la parada.
 */
describe('ReconnectReplayService — adoção de mensagens órfãs', () => {
  let svc: ReconnectReplayService;
  let prisma: MockProxy<PrismaService>;
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    queue = { add: vi.fn() };
    svc = new ReconnectReplayService(prisma, queue as never);
  });

  function canalVivo(over: Record<string, unknown> = {}) {
    prisma.channel.findUnique.mockResolvedValue({
      id: 'novo',
      provider: 'GOZAP',
      phoneE164: '+559286550102',
      isActive: true,
      ...over,
    } as never);
  }

  it('migra as paradas de um canal REMOVIDO com o mesmo número, e as dispara', async () => {
    canalVivo();
    prisma.channel.findMany.mockResolvedValue([{ id: 'morto' }] as never);
    prisma.message.updateMany
      .mockResolvedValueOnce({ count: 488 } as never) // a adoção
      .mockResolvedValueOnce({ count: 488 } as never); // a reivindicação do replay
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
    ] as never);

    await svc.replayWaitingFor('novo');

    // Só canais INATIVOS, MESMO provedor, MESMO número — e nunca ele mesmo.
    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: false,
          provider: 'GOZAP',
          phoneE164: '+559286550102',
          id: { not: 'novo' },
        }),
      }),
    );
    // A migração aponta as paradas para o canal vivo.
    expect(prisma.message.updateMany).toHaveBeenNthCalledWith(1, {
      where: { instanceId: { in: ['morto'] }, status: 'WAITING_INSTANCE' },
      data: { instanceId: 'novo' },
    });
    // E o replay as encontra depois — senão a adoção não teria servido de nada.
    expect(queue.add).toHaveBeenCalled();
  });

  it('canal sem número não adota — não dá para provar que é o mesmo remetente', async () => {
    canalVivo({ phoneE164: null });
    prisma.message.findMany.mockResolvedValue([] as never);

    await svc.replayWaitingFor('novo');

    expect(prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it('sem canal morto com o mesmo número, nada é migrado', async () => {
    canalVivo();
    prisma.channel.findMany.mockResolvedValue([] as never);
    prisma.message.findMany.mockResolvedValue([] as never);

    await svc.replayWaitingFor('novo');

    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * A VARREDURA PELO LADO DAS MENSAGENS — incidente 2026-08-14.
 *
 * O replay sempre foi disparado pelo lado do CANAL: o laço de um provedor
 * percorre os canais dele e, para cada um que está aberto, pergunta "tem
 * mensagem parada aqui?". Isso tem um furo estrutural: os laços têm FILTROS
 * (só GOZAP com token, só canais ativos), e mensagem parada num canal que o
 * laço pula fica invisível PARA SEMPRE. Foi assim que 488 mensagens ficaram
 * paradas por dois dias com o número reconectado.
 *
 * Aqui a pergunta é invertida: parte das MENSAGENS PARADAS, não dos canais.
 * Nenhum filtro de provedor pode esconder uma mensagem de si mesma.
 */
describe('ReconnectReplayService — varredura das paradas (message-side)', () => {
  let svc: ReconnectReplayService;
  let prisma: MockProxy<PrismaService>;
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    queue = { add: vi.fn() };
    svc = new ReconnectReplayService(prisma, queue as never);
  });

  it('solta as paradas de um canal ATIVO e ONLINE que o laço do provedor não visita', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { instanceId: 'ch-esquecido', _count: { _all: 488 } },
    ] as never);
    prisma.channel.findUnique.mockResolvedValue({
      id: 'ch-esquecido',
      name: 'robo',
      provider: 'GOZAP',
      isActive: true,
      phoneE164: '+559286550102',
    } as never);
    // sessionBased exige evento 'open' gravado — e ele existe.
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue({
      state: 'open',
    } as never);
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
    ] as never);
    prisma.message.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.channel.findMany.mockResolvedValue([] as never);

    await svc.sweepParked();

    expect(queue.add).toHaveBeenCalled();
  });

  it('NÃO solta quando o canal está offline — mandar por sessão morta é pior', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { instanceId: 'ch-off', _count: { _all: 10 } },
    ] as never);
    prisma.channel.findUnique.mockResolvedValue({
      id: 'ch-off',
      name: 'robo',
      provider: 'GOZAP',
      isActive: true,
      phoneE164: '+55929',
    } as never);
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue({
      state: 'close',
    } as never);

    await svc.sweepParked();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('canal de provedor OFICIAL não depende de evento de conexão', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { instanceId: 'ch-twilio', _count: { _all: 3 } },
    ] as never);
    prisma.channel.findUnique.mockResolvedValue({
      id: 'ch-twilio',
      name: 'oficial',
      provider: 'TWILIO',
      isActive: true,
      phoneE164: '+5511',
    } as never);
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', campaignId: 'c1', contactId: 'co1' },
    ] as never);
    prisma.message.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.channel.findMany.mockResolvedValue([] as never);

    await svc.sweepParked();

    // Nem consultou evento de conexão: Twilio/Zernio/Meta não geram nenhum.
    expect(prisma.whatsappConnectionEvent.findFirst).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it('canal INATIVO não é despertado aqui — quem cuida disso é a adoção', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { instanceId: 'ch-morto', _count: { _all: 5 } },
    ] as never);
    prisma.channel.findUnique.mockResolvedValue({
      id: 'ch-morto',
      name: 'antigo',
      provider: 'GOZAP',
      isActive: false,
      phoneE164: '+55929',
    } as never);

    await svc.sweepParked();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('sem nenhuma mensagem parada, não faz nada', async () => {
    prisma.message.groupBy.mockResolvedValue([] as never);

    await svc.sweepParked();

    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
  });
});
