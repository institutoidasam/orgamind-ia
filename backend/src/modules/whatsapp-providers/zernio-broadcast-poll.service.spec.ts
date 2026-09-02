import { describe, it, expect, vi } from 'vitest';
import { ZernioBroadcastPollService } from './zernio-broadcast-poll.service';

const CHANNEL_ID = 'ch1';
const LOCAL_ID = 'local_1';

/**
 * ZW — o shape REAL de um destinatário do `GET /broadcasts/{id}/recipients`,
 * sondado ao vivo. Sem `messageId` (wamid), sem `sentAt`/`deliveredAt`/`readAt`,
 * sem `errorCode`. É só isto que o reconciliador tem para trabalhar.
 */
type Recip = {
  phone: string;
  status: string | null;
  errorExplanation?: string | null;
};

function harness(
  recipients: Recip[],
  over: {
    messages?: {
      id: string;
      status: string;
      deliveredAt?: Date | null;
      contact: { phoneE164: string };
    }[];
    sendingNow?: boolean;
  } = {},
) {
  const messages = over.messages ?? [
    { id: 'm1', status: 'SENT', contact: { phoneE164: '+5592991110001' } },
    { id: 'm2', status: 'SENT', contact: { phoneE164: '+5592991110002' } },
  ];

  const updates: { id: string; data: Record<string, unknown>; from?: unknown }[] = [];

  const prisma = {
    zernioBroadcast: {
      findUnique: vi.fn(async () => ({
        id: LOCAL_ID,
        zernioId: 'bc_1',
        channelId: CHANNEL_ID,
        status: 'sending',
      })),
      update: vi.fn(async () => ({})),
    },
    message: {
      findMany: vi.fn(async () => messages),
      // ZW — os contadores do espelho saem DAQUI (das NOSSAS Messages, que o
      // webhook mantém em dia), e não dos status da API (que estão congelados).
      groupBy: vi.fn(async () => {
        const byStatus = new Map<string, number>();
        for (const m of messages) {
          byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
        }
        return [...byStatus].map(([status, n]) => ({
          status,
          _count: { _all: n },
        }));
      }),
      // O `count` do updateMany é o que o BANCO responderia: 0 quando o escopo
      // (`status: { in }` / `deliveredAt: null`) não casa a linha. Um mock que
      // devolvesse 1 sempre esconderia justamente as decisões que dependem de a
      // transição ter casado ou não.
      updateMany: vi.fn(
        async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = messages.find(
            (m) => m.id === (a.where.id as string),
          ) as (typeof messages)[number] & { deliveredAt?: Date | null };
          const from = (a.where.status as { in?: string[] })?.in;
          const matches =
            !!row &&
            (from === undefined || from.includes(row.status)) &&
            (a.where.deliveredAt !== null || (row.deliveredAt ?? null) === null);
          updates.push({ id: a.where.id as string, data: a.data, from });
          if (!matches) return { count: 0 };
          if (typeof a.data.status === 'string') row.status = a.data.status;
          if (a.data.deliveredAt) row.deliveredAt = a.data.deliveredAt as Date;
          return { count: 1 };
        },
      ),
    },
    campaign: { findFirst: vi.fn(async () => null) },
  };

  const client = {
    listRecipients: vi.fn(async () => ({
      items: recipients,
      hasMore: false,
      total: recipients.length,
    })),
  };

  const pollQueue = { add: vi.fn(async () => ({ id: 'p' })) };

  const svc = new ZernioBroadcastPollService(
    prisma as never,
    client as never,
    pollQueue as never,
  );

  return { svc, prisma, client, pollQueue, updates };
}

describe('pollBroadcast — o status POR DESTINATÁRIO vira o status da Message', () => {
  // ── ZW — O POLLING VIRA RECONCILIADOR. NÃO É MAIS A FUNDAÇÃO. ────────────
  //
  // Sondagem ao vivo (13/07, produção): o `GET /broadcasts/{id}/recipients`
  // NÃO devolve `messageId` (wamid), NÃO devolve `sentAt`/`deliveredAt`/
  // `readAt` e NÃO devolve `errorCode`. Ele dá `platformIdentifier` (telefone),
  // `status` e `errorExplanation` — e o `status` de lá fica CONGELADO em
  // `pending` (50/50 destinatários ainda `pending` 30 min depois do disparo,
  // com entregas JÁ confirmadas por webhook).
  //
  // Quem sabe o status de verdade, em tempo real e com o wamid, é o WEBHOOK.
  // Este polling passa a ser só a REDE DE SEGURANÇA para o que o webhook
  // perdeu (ele é at-least-once, mas pode ir para dead-letter depois de ~51h).
  it('ZW: NÃO escreve providerMessageId — a API não tem wamid (quem carimba é o webhook)', async () => {
    const h = harness([{ phone: '+5592991110001', status: 'delivered' }]);

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const u = h.updates.find((x) => x.id === 'm1');
    expect(u?.data).toMatchObject({ status: 'DELIVERED' });
    // Inventar um wamid aqui explodiria o @unique de providerMessageId; e o
    // campo que o desenho antigo lia (`messageId`) simplesmente não existe.
    expect(u?.data).not.toHaveProperty('providerMessageId');
  });

  it('ZW: failed => FAILED com a EXPLICAÇÃO, sem ZERAR o errorCode que o webhook gravou', async () => {
    // O `/recipients` não tem `errorCode`. Escrever `errorCode: null` aqui
    // APAGARIA o 131026 que o webhook de `message.failed` gravou — e é esse
    // código que marca o contato como inalcançável-para-MARKETING (30% da base).
    const h = harness([
      {
        phone: '+5592991110002',
        status: 'failed',
        errorExplanation: 'Message undeliverable',
      },
    ]);

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const u = h.updates.find((x) => x.id === 'm2');
    expect(u?.data).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Message undeliverable',
    });
    expect(u?.data).not.toHaveProperty('errorCode');
  });

  it('★ MONOTONICIDADE: um "sent" atrasado NUNCA rebaixa quem já está DELIVERED', async () => {
    // A máquina é monotônica: sent < delivered < read. O polling é assíncrono e
    // pode trazer um status velho depois de um webhook já ter avançado a linha.
    const h = harness([
      { phone: '+5592991110001', status: 'sent' },
    ]);

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    // O update é ESCOPADO por status: só toca linhas ABAIXO de SENT.
    const u = h.updates.find((x) => x.id === 'm1');
    expect(u?.from).toBeDefined();
    expect(u?.from).not.toContain('DELIVERED');
    expect(u?.from).not.toContain('READ');
  });

  it('★ FAILED é terminal e VENCE — mas nunca sobrescreve um SKIPPED (a prova do gate)', async () => {
    const h = harness([
      { phone: '+5592991110001', status: 'failed' },
    ]);

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const u = h.updates.find((x) => x.id === 'm1');
    // Pode vir de qualquer estado NÃO-terminal...
    expect(u?.from).toContain('SENT');
    expect(u?.from).toContain('DELIVERED');
    // ...mas JAMAIS de uma linha do gate, nem de uma já cancelada.
    expect(u?.from).not.toContain('SKIPPED_NO_CONSENT');
    expect(u?.from).not.toContain('SKIPPED_SUPPRESSED');
    expect(u?.from).not.toContain('CANCELLED');
  });

  it('★ "read" NÃO sobrescreve o deliveredAt REAL que o webhook gravou', async () => {
    // O `/recipients` não devolve timestamp nenhum, então o que este serviço
    // carimbaria é a hora da RECONCILIAÇÃO — um chute que pode estar HORAS
    // depois do evento. O webhook traz a hora VERDADEIRA (`statusAt`), e o
    // relatório de entrega da campanha (a prova numa questionamento do TSE) sai
    // desses timestamps. Um "lido" reconciliado não pode reescrever a hora da
    // entrega que já se sabia.
    const h = harness([{ phone: '+5592991110001', status: 'read' }], {
      messages: [
        { id: 'm1', status: 'DELIVERED', contact: { phoneE164: '+5592991110001' } },
      ],
    });

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const calls = (
      h.prisma.message.updateMany.mock.calls as unknown as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][]
    ).map(([a]) => a);
    const advance = calls.find((a) => a.data.status === 'READ');
    expect(advance).toBeDefined();
    // A transição de status não carrega deliveredAt…
    expect(advance!.data).not.toHaveProperty('deliveredAt');
    // …e o preenchimento do deliveredAt (um READ sem entrega registrada mentiria
    // no relatório) só toca a linha em que ele AINDA ESTÁ VAZIO.
    const fill = calls.find((a) => a.data.deliveredAt !== undefined);
    expect(fill).toBeDefined();
    expect(fill!.where.deliveredAt).toBeNull();
  });

  it('★ um "delivered" atrasado sobre uma linha JÁ LIDA não inventa uma entrega DEPOIS da leitura', async () => {
    // O caso que sobrou do achado anterior: a transição de status é recusada
    // (READ não está abaixo de DELIVERED), mas o preenchimento do `deliveredAt`
    // rodava mesmo assim e gravava a hora da RECONCILIAÇÃO — que pode estar 30
    // min depois do `readAt` real. `deliveredAt > readAt` é uma ordenação
    // IMPOSSÍVEL, e é dela que o swim-lanes calcula duração e largura de barra.
    // Só preenchemos quando a transição ACIMA de fato casou a linha.
    const h = harness([{ phone: '+5592991110001', status: 'delivered' }], {
      messages: [
        {
          id: 'm1',
          status: 'READ',
          deliveredAt: null,
          contact: { phoneE164: '+5592991110001' },
        },
      ],
    });

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const wrote = h.updates.find((u) => u.data.deliveredAt !== undefined);
    expect(wrote).toBeUndefined();
  });

  it('"pending" não mexe em nada (a mensagem ainda não saiu)', async () => {
    const h = harness([{ phone: '+5592991110001', status: 'pending' }]);
    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });
    expect(h.updates).toHaveLength(0);
  });

  it('status DESCONHECIDO do Zernio não corrompe a linha — é ignorado', async () => {
    const h = harness([
      { phone: '+5592991110001', status: 'quantum_superposition' },
    ]);
    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });
    expect(h.updates).toHaveLength(0);
  });

  it('destinatário que não é de nenhuma Message nossa é ignorado, sem explodir', async () => {
    const h = harness([
      { phone: '+5599999999999', status: 'delivered' },
    ]);
    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });
    expect(h.updates).toHaveLength(0);
  });

  // ★ ZW — O CONTADOR DO ESPELHO SAI DAS NOSSAS MESSAGES, NÃO DA API.
  //
  // Este é o outro lado da inversão. Se o polling continuasse copiando os
  // contadores da API para o espelho, ele ZERARIA, a cada tick, tudo o que o
  // webhook apurou: a API reporta TODOS os destinatários como `pending`
  // (congelado) enquanto os webhooks já confirmaram entrega e leitura. O
  // resultado na tela seria "0 enviadas" numa campanha que entregou.
  it('ZW: os contadores do espelho vêm das NOSSAS Messages (o webhook é a verdade), não do status congelado da API', async () => {
    // A API diz que está TUDO pending...
    const h = harness(
      [
        { phone: '+5592991110001', status: 'pending' },
        { phone: '+5592991110002', status: 'pending' },
        { phone: '+5592991110003', status: 'pending' },
      ],
      {
        // ...mas as NOSSAS linhas, que o webhook atualizou, dizem outra coisa.
        messages: [
          { id: 'm1', status: 'READ', contact: { phoneE164: '+5592991110001' } },
          { id: 'm2', status: 'DELIVERED', contact: { phoneE164: '+5592991110002' } },
          { id: 'm3', status: 'FAILED', contact: { phoneE164: '+5592991110003' } },
        ],
      },
    );

    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });

    const data = h.prisma.zernioBroadcast.update.mock.calls[0]?.[0]?.data;
    // O funil é MONOTÔNICO por construção: quem leu, recebeu; quem recebeu, saiu.
    // (A API do Zernio devolvia `sentCount: 3` com `deliveredCount: 8` —
    // incoerente. Derivado das Messages, isso não acontece.)
    expect(data).toMatchObject({
      sentCount: 2, // READ + DELIVERED
      deliveredCount: 2, // READ + DELIVERED
      readCount: 1, // READ
      failedCount: 1, // FAILED
    });
  });
});

describe('pollBroadcast — reagendamento', () => {
  it('ainda há gente PENDING => marca outro poll', async () => {
    const h = harness([
      { phone: '+5592991110001', status: 'pending' },
      { phone: '+5592991110002', status: 'delivered' },
    ]);
    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });
    expect(h.pollQueue.add).toHaveBeenCalled();
  });

  it('★ todo mundo em estado TERMINAL => PARA de pollar (não queima o balde à toa)', async () => {
    // O balde é de 60 req/min POR CHAVE e é o MESMO do envio. Um polling que não
    // sabe parar é um polling que rouba vazão da campanha para sempre.
    const h = harness([
      { phone: '+5592991110001', status: 'read' },
      { phone: '+5592991110002', status: 'failed' },
    ]);
    await h.svc.pollBroadcast({ localBroadcastId: LOCAL_ID, channelId: CHANNEL_ID });
    expect(h.pollQueue.add).not.toHaveBeenCalled();
  });

  it('★ desiste depois de MUITAS tentativas (não fica pollando para sempre)', async () => {
    const h = harness([{ phone: '+5592991110001', status: 'pending' }]);
    await h.svc.pollBroadcast({
      localBroadcastId: LOCAL_ID,
      channelId: CHANNEL_ID,
      attempt: 999,
    });
    expect(h.pollQueue.add).not.toHaveBeenCalled();
  });
});
