import { describe, it, expect } from 'vitest';
import type { Prisma, MessageStatus } from '@prisma/client';

import {
  BATCH_HANDLED_STATUSES,
  pendingAudienceWhere,
  isHandledInCampaign,
  reachedInCampaignFilter,
  reachedOrInFlightInCampaign,
  unreachedAudienceWhere,
  sameTemplateBlockFilter,
  REACHED_OR_IN_FLIGHT_STATUSES,
  unreachedIdleAudienceWhere,
} from './batch-audience';
import { INDETERMINATE_DELIVERY_CODES } from './marketing-reachability';

const audience: Prisma.ContactWhereInput = { city: 'Manaus' };

describe('reachedInCampaignFilter', () => {
  it('casa só quem RECEBEU (SENT|DELIVERED|READ), OUTBOUND, nesta campanha', () => {
    const f = reachedInCampaignFilter('camp1');
    expect(f).toEqual({
      campaignId: 'camp1',
      direction: 'OUTBOUND',
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
    });
  });
});

describe('reachedOrInFlightInCampaign', () => {
  it('casa quem RECEBEU (SENT|DELIVERED|READ) OU está EM VOO (QUEUED|SENDING|WAITING_INSTANCE), OUTBOUND, nesta campanha', () => {
    const f = reachedOrInFlightInCampaign('camp1');
    expect(f).toEqual({
      campaignId: 'camp1',
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
});

describe('unreachedAudienceWhere', () => {
  const audience: Prisma.ContactWhereInput = { city: 'Manaus' };
  it('exclui só quem RECEBEU — os pulados pelo gate continuam elegíveis', () => {
    const where = unreachedAudienceWhere({
      campaignId: 'c1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const none = (where.AND as Prisma.ContactWhereInput[]).find(
      (c) => c.messages,
    );
    const filter = (none!.messages as { none: Prisma.MessageWhereInput }).none;
    expect(filter.status).toEqual({ in: ['SENT', 'DELIVERED', 'READ'] });
    expect(filter.direction).toBe('OUTBOUND');
  });

  /**
   * C11 (auditoria 2026-08-19) — ENTREGA INDETERMINADA É "POSSIVELMENTE
   * RECEBEU". O recorte `unreached` ignorava FAILED por completo, então o
   * redisparo e o tick criavam uma linha NOVA para quem tinha uma falha
   * `sending_stuck`/`*.indeterminate`/`*.timeout` — cujo POST pode ter saído,
   * sido entregue e cobrado. É a mesma proteção que já bloqueia o botão de
   * retry dessas linhas, que faltava no resolvedor de audiência.
   */
  it('exclui quem tem falha de ENTREGA INDETERMINADA nesta campanha', () => {
    const where = unreachedAudienceWhere({
      campaignId: 'c1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const clauses = where.AND as Prisma.ContactWhereInput[];
    const indeterminada = clauses
      .map((c) => (c.messages as { none: Prisma.MessageWhereInput })?.none)
      .find((n) => n?.status === 'FAILED');
    expect(indeterminada).toEqual({
      campaignId: 'c1',
      direction: 'OUTBOUND',
      status: 'FAILED',
      errorCode: { in: INDETERMINATE_DELIVERY_CODES },
    });
  });
});

describe('pendingAudienceWhere', () => {
  it('preserva a audiência original da campanha', () => {
    const where = pendingAudienceWhere({
      campaignId: 'camp1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    expect(where.AND).toContainEqual(audience);
  });

  it('exclui quem JÁ tem mensagem tratada nesta campanha (o "não repete")', () => {
    const where = pendingAudienceWhere({
      campaignId: 'camp1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const clauses = where.AND as Prisma.ContactWhereInput[];
    const none = clauses.find((c) => c.messages);
    expect(none).toBeDefined();
    const messagesNone = (none!.messages as { none: Prisma.MessageWhereInput })
      .none;
    // Escopado À CAMPANHA: um contato que recebeu OUTRA campanha continua
    // pendente nesta. É o "naquela campanha" do pedido do cliente.
    expect(messagesNone.campaignId).toBe('camp1');
  });

  it('exclui os inalcançáveis para MARKETING quando o template é MARKETING', () => {
    const where = pendingAudienceWhere({
      campaignId: 'camp1',
      audience,
      excludeMarketingUndeliverable: true,
    });
    expect(where.AND).toContainEqual({ marketingUndeliverableAt: null });
  });

  it('NÃO exclui os inalcançáveis numa campanha UTILITY', () => {
    // A Meta é explícita no 130472: "UTILITY TEMPLATES ARE NOT AFFECTED".
    // Excluir essas pessoas de uma campanha de serviço seria deixar de falar com
    // quem a lei e a Meta permitem que a gente fale.
    const where = pendingAudienceWhere({
      campaignId: 'camp1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    expect(where.AND).not.toContainEqual({ marketingUndeliverableAt: null });
  });
});

describe('isHandledInCampaign — quem NÃO volta para um próximo lote', () => {
  const handled = (status: MessageStatus, errorCode?: string | null) =>
    isHandledInCampaign({ status, errorCode: errorCode ?? null });

  it('quem já foi enviado/entregue/lido está tratado', () => {
    expect(handled('SENT')).toBe(true);
    expect(handled('DELIVERED')).toBe(true);
    expect(handled('READ')).toBe(true);
  });

  it('quem está em voo está tratado (não pode ser enfileirado duas vezes)', () => {
    expect(handled('QUEUED')).toBe(true);
    expect(handled('SENDING')).toBe(true);
    expect(handled('WAITING_INSTANCE')).toBe(true);
  });

  it('quem o gate pulou está tratado (foi avaliado nesta campanha)', () => {
    expect(handled('SKIPPED_NO_CONSENT')).toBe(true);
    expect(handled('SKIPPED_SUPPRESSED')).toBe(true);
  });

  it('falha DEFINITIVA está tratada — insistir só queima cota', () => {
    expect(handled('FAILED', '131026')).toBe(true);
    expect(handled('FAILED', '130472')).toBe(true);
    expect(handled('FAILED', '131021')).toBe(true);
  });

  // Fix: o timeout indeterminado do send-message.processor (INDETERMINATE_TIMEOUTS)
  // terminaliza a Message como FAILED sem reenviar NESTE attempt — mas se o
  // código não for tratado como "handled" aqui, o PRÓXIMO LOTE da campanha acha
  // o contato pendente de novo e reenvia. É a MESMA duplicata, só que via lote
  // em vez de retry do BullMQ. `twilio.indeterminate` já estava coberto; esta
  // cobertura é o que fecha o buraco para Zernio/GoZap (o Zernio é o provedor
  // do tráfego REAL do cliente).
  it('timeout indeterminado (twilio/zernio/gozap.indeterminate) está tratado — não pode voltar a pendente no próximo lote', () => {
    expect(handled('FAILED', 'twilio.indeterminate')).toBe(true);
    expect(handled('FAILED', 'zernio.indeterminate')).toBe(true);
    expect(handled('FAILED', 'gozap.indeterminate')).toBe(true);
  });

  // Fix: os sinais CRUS do adapter (`zernio.timeout`/`gozap.timeout`, antes da
  // tradução do processor para o terminal `<provider>.indeterminate`) TAMBÉM
  // estão tratados — não é hipotético. Antes da guarda B3 ser generalizada
  // para todo provedor, ela existia só para a Twilio: um timeout do Zernio
  // era relançado, retentado 5x pelo BullMQ, e a linha FINAL ficava com o
  // código CRU (`@OnWorkerEvent('failed')` grava `err.providerErrorCode` sem
  // tradução). Essas linhas LEGADAS existem hoje no banco e carregam o MESMO
  // risco de entrega duplicada que as novas — se o próximo lote as tratasse
  // como transitórias, reenviaria a quem talvez já tenha recebido.
  it('timeout indeterminado CRU (zernio/gozap.timeout, linhas legadas pré-guarda-generalizada) também está tratado', () => {
    expect(handled('FAILED', 'zernio.timeout')).toBe(true);
    expect(handled('FAILED', 'gozap.timeout')).toBe(true);
  });

  /**
   * C11 (auditoria 2026-08-19) — `sending_stuck` estava na lista que BLOQUEIA
   * os botões de retry (o operador não pode reenviar, "pode já ter sido
   * entregue") e fora da lista que bloqueia o LOTE. O worker morreu entre o
   * claim e o markSent: o POST pode ter saído. O lote seguinte achava o contato
   * pendente e enviava de novo.
   */
  it('worker morto no meio do envio (sending_stuck) está tratado — o POST pode ter saído', () => {
    expect(handled('FAILED', 'sending_stuck')).toBe(true);
  });

  it('falha TRANSITÓRIA volta a ser pendente no próximo lote', () => {
    // É o que permite repetir o lote depois de um incidente (Zernio fora do ar)
    // sem o operador ter que caçar quem faltou — que é exatamente a dor do pedido.
    expect(handled('FAILED', '500')).toBe(false);
    expect(handled('FAILED', null)).toBe(false);
  });

  it('BATCH_HANDLED_STATUSES não inclui FAILED (ele depende do errorCode)', () => {
    expect(BATCH_HANDLED_STATUSES).not.toContain('FAILED');
  });
});

/**
 * A regra "não reenviar o mesmo template ao mesmo contato" (spec
 * 2026-08-12-exclusao-por-template-design.md).
 *
 * O caso que a motivou: o operador dispara 500 com o template T e, logo depois,
 * cria outra campanha com o MESMO T para mais 500. Hoje a mesma pessoa entra nas
 * duas.
 *
 * O detalhe que decide tudo é EM VOO. `REACHED_STATUSES` (SENT|DELIVERED|READ)
 * não inclui QUEUED/WAITING_INSTANCE — e com campanhas disparadas em sequência
 * curta a primeira ainda está na FILA quando a segunda monta a audiência. Sem
 * cobrir os estados em voo, a regra não pega justamente o caso que a originou.
 */
/**
 * C1/C4 — O TICK DO AGENDADOR NÃO PODE REENVIAR PARA QUEM AINDA ESTÁ EM VOO.
 *
 * `unreachedAudienceWhere` exclui só SENT/DELIVERED/READ. Numa campanha
 * recorrente com 13.000 contatos, o tick seguinte encontra milhares de linhas
 * ainda QUEUED do tick anterior (o pacing e o teto de 24h drenam devagar) e cria
 * uma SEGUNDA linha para cada uma — o eleitor recebe duas vezes.
 */
describe('unreachedIdleAudienceWhere — o recorte do TICK', () => {
  it('exclui quem RECEBEU **e quem ainda está EM VOO** (QUEUED/SENDING/WAITING_INSTANCE)', () => {
    const where = unreachedIdleAudienceWhere({
      campaignId: 'c1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const none = (where.AND as Prisma.ContactWhereInput[]).find(
      (c) => c.messages,
    );
    const filter = (none!.messages as { none: Prisma.MessageWhereInput }).none;
    expect(filter).toEqual(reachedOrInFlightInCampaign('c1'));
  });

  it('também exclui a falha de ENTREGA INDETERMINADA (C11) — o tick não reabre o que pode ter chegado', () => {
    const where = unreachedIdleAudienceWhere({
      campaignId: 'c1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const clauses = where.AND as Prisma.ContactWhereInput[];
    const indeterminada = clauses
      .map((c) => (c.messages as { none: Prisma.MessageWhereInput })?.none)
      .find((n) => n?.status === 'FAILED');
    expect(indeterminada?.errorCode).toEqual({
      in: INDETERMINATE_DELIVERY_CODES,
    });
  });

  it('mantém os SKIPPED_* e as falhas elegíveis — quem o gate pulou volta a cada tick (Fase 0)', () => {
    const where = unreachedIdleAudienceWhere({
      campaignId: 'c1',
      audience,
      excludeMarketingUndeliverable: false,
    });
    const none = (where.AND as Prisma.ContactWhereInput[]).find(
      (c) => c.messages,
    );
    const statuses = (
      (none!.messages as { none: Prisma.MessageWhereInput }).none.status as {
        in: MessageStatus[];
      }
    ).in;
    expect(statuses).not.toContain('SKIPPED_NO_CONSENT');
    expect(statuses).not.toContain('SKIPPED_SUPPRESSED');
    expect(statuses).not.toContain('FAILED');
  });
});

describe('sameTemplateBlockFilter — bloqueio entre campanhas do mesmo template', () => {
  it('sem campanha anterior do template, não há o que bloquear', () => {
    expect(
      sameTemplateBlockFilter({ activeCampaignIds: [], cancelledCampaignIds: [] }),
    ).toBeNull();
  });

  it('campanha ATIVA: bloqueia recebido E em voo — inclusive QUEUED', () => {
    const f = sameTemplateBlockFilter({
      activeCampaignIds: ['c1', 'c2'],
      cancelledCampaignIds: [],
    });
    expect(f).toEqual({
      direction: 'OUTBOUND',
      OR: [
        {
          campaignId: { in: ['c1', 'c2'] },
          status: { in: REACHED_OR_IN_FLIGHT_STATUSES },
        },
      ],
    });
    const statuses = (f?.OR as { status: { in: MessageStatus[] } }[])[0].status.in;
    expect(statuses).toContain('QUEUED');
    expect(statuses).toContain('WAITING_INSTANCE');
    expect(statuses).toContain('DELIVERED');
  });

  /**
   * C14 (auditoria 2026-08-19) — DECISÃO DO DONO, 2026-08-19.
   *
   * O comportamento anterior liberava o `SENT` de uma campanha cancelada, com
   * o argumento do incidente do 9º dígito (um SENT que nunca chega). Só que o
   * cancelamento NÃO cancela o que já está SENT: `cancelQueuedMessages` só
   * mexe em QUEUED/WAITING_INSTANCE. Uma mensagem SENT já está NO PROVEDOR e
   * vai ser entregue — o recibo é que ainda não voltou. O operador que cancela
   * a campanha errada e recria a mesma com o mesmo template mandava o texto
   * duas vezes para as mesmas 500 pessoas.
   *
   * A régua nova é a que casa com o que o cancelamento de fato faz: uma
   * campanha cancelada libera exatamente o que foi cancelado (a fila), e nada
   * mais.
   */
  it('campanha CANCELADA: bloqueia o que foi ENTREGUE e o que já está NO PROVEDOR (SENT)', () => {
    const f = sameTemplateBlockFilter({
      activeCampaignIds: [],
      cancelledCampaignIds: ['x1'],
    });
    const ramo = (f?.OR as { status: { in: MessageStatus[] } }[])[0];
    expect(ramo.status.in).toEqual(['DELIVERED', 'READ', 'SENT']);
    // Cancelar LIBERA exatamente o que o cancelamento cancelou: a FILA.
    expect(ramo.status.in).not.toContain('QUEUED');
    expect(ramo.status.in).not.toContain('WAITING_INSTANCE');
  });

  it('os dois tipos convivem, cada um com a sua régua', () => {
    const f = sameTemplateBlockFilter({
      activeCampaignIds: ['a1'],
      cancelledCampaignIds: ['x1'],
    });
    expect(f?.OR).toHaveLength(2);
  });

  it('FAILED e os SKIPPED_* nunca bloqueiam — essas pessoas não receberam nada', () => {
    const f = sameTemplateBlockFilter({
      activeCampaignIds: ['a1'],
      cancelledCampaignIds: ['x1'],
    });
    const todos = (f?.OR as { status: { in: MessageStatus[] } }[]).flatMap(
      (r) => r.status.in,
    );
    for (const s of ['FAILED', 'SKIPPED_NO_CONSENT', 'SUPPRESSED', 'CANCELLED']) {
      expect(todos).not.toContain(s);
    }
  });

  it('sempre OUTBOUND — mensagem recebida do contato não é entrega nossa', () => {
    const f = sameTemplateBlockFilter({
      activeCampaignIds: ['a1'],
      cancelledCampaignIds: [],
    });
    expect(f?.direction).toBe('OUTBOUND');
  });
});
