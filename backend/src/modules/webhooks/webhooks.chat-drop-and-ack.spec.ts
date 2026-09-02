import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import { ChatIngestService } from '../chat/chat-ingest.service';
import { ChatEventsService } from '../chat/chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { TemplatesService } from '../templates/templates.service';

/**
 * Dois defeitos que só aparecem no CAMINHO DE VOLTA do provedor:
 *
 *  - C17: quando um provider não sabe parsear entrada para o CHAT, a mensagem
 *    do eleitor sumia com ZERO rastro — `?.parseInboundChatMessages?.() ?? []`
 *    retorna normalmente, então nem o try/catch (único log do trecho) dispara.
 *    Foi assim que 70 de 74 webhooks reais do GoZap não produziram efeito
 *    nenhum, todos com HTTP 200.
 *  - K6: o ack de entrega de um BROADCAST é casado por telefone + canal + 48h,
 *    SEM filtro de campanha, desempatando por `sentAt desc` — então o
 *    `delivered` de um disparo é carimbado na linha do OUTRO.
 */
describe('WebhooksService — perda silenciosa de chat e ack de broadcast', () => {
  let service: WebhooksService;
  let prisma: MockProxy<PrismaService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let chatIngest: MockProxy<ChatIngestService>;
  let redis: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    wa = mockDeep<WhatsappProvidersService>();
    chatIngest = mockDeep<ChatIngestService>();
    const consent = mockDeep<ConsentService>();
    consent.isSuppressed.mockResolvedValue(false);
    consent.record.mockResolvedValue({ eventId: 'ev1', created: true } as never);
    const templates = mockDeep<TemplatesService>();
    templates.applyZernioTemplateStatus.mockResolvedValue(true);
    const config = mockDeep<ConfigService<Env>>();
    config.get.mockImplementation(() => undefined as never);
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    };
    wa.parseInboundMessages.mockReturnValue([]);
    wa.parseInboundMessagesFor.mockReturnValue([]);
    wa.parseWebhookFor.mockReturnValue([]);
    chatIngest.ingestFromWebhook.mockResolvedValue({ parsed: 0, persisted: 0 } as never);
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as never);
    const repo = mockDeep<WhatsappProvidersRepository>();
    repo.findLastEvent.mockResolvedValue(null);
    repo.createEvent.mockResolvedValue({ id: 'e1' } as never);
    // `vi.spyOn` devolve o MESMO spy quando o método já está espionado, então
    // sem o clear as chamadas de um teste vazariam para o seguinte — e um
    // "não avisa" passaria a ver o aviso do teste anterior.
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    warn.mockClear();

    service = new WebhooksService(
      prisma,
      wa,
      config,
      mockDeep<AuditService>(),
      redis as never,
      repo,
      { maybeCompleteCampaign: vi.fn().mockResolvedValue(undefined) } as never,
      chatIngest,
      mockDeep<ChatEventsService>(),
      { get: vi.fn().mockResolvedValue({ id: 'singleton', name: 'X', legalName: 'X' }) } as never,
      templates,
      { add: vi.fn() } as never,
      consent,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function warnedWith(re: RegExp): { ctx?: Record<string, unknown>; msg: string } | undefined {
    for (const call of warn.mock.calls) {
      const msg = call.find((a) => typeof a === 'string' && re.test(a)) as string | undefined;
      if (msg) {
        const ctx = call.find((a) => a && typeof a === 'object') as Record<string, unknown> | undefined;
        return { ctx, msg };
      }
    }
    return undefined;
  }

  describe('C17 — o descarte de mensagem de entrada não pode ser invisível', () => {
    it('provider que reconhece a entrada mas não a entrega ao chat: LOGA o descarte com contexto', async () => {
      // O opt-out ENXERGA a mensagem (é o caso real do GoZap)…
      wa.parseInboundMessagesFor.mockReturnValue([
        { fromE164: '+5592987654321', text: 'oi', providerMessageId: 'M1', receivedAt: new Date() },
      ]);
      // …e o chat não recebe nada.
      chatIngest.ingestFromWebhook.mockResolvedValue({ parsed: 0, persisted: 0 } as never);

      await service.process({ event: 'messages' }, 'ch_gozap', 'GOZAP');

      const found = warnedWith(/descartad|inbox/i);
      expect(found, 'nenhum aviso emitido para a mensagem descartada').toBeDefined();
      expect(found!.ctx).toMatchObject({ provider: 'GOZAP', instanceId: 'ch_gozap' });
    });

    /**
     * PII NUNCA VAI PARA O LOG. Telefone, nome de perfil e texto de eleitor não
     * entram — o log de produção é lido por gente que não deveria ver isso, e
     * numa campanha eleitoral o próprio "quem escreveu" é dado sensível.
     */
    it('o aviso NÃO carrega telefone nem texto do eleitor', async () => {
      wa.parseInboundMessagesFor.mockReturnValue([
        { fromE164: '+5592987654321', text: 'quero saber do candidato', providerMessageId: 'M1', receivedAt: new Date() },
      ]);
      chatIngest.ingestFromWebhook.mockResolvedValue({ parsed: 0, persisted: 0 } as never);

      await service.process({ event: 'messages' }, 'ch_gozap', 'GOZAP');

      const dump = JSON.stringify(warn.mock.calls);
      expect(dump).not.toContain('5592987654321');
      expect(dump).not.toContain('quero saber do candidato');
    });

    it('recibo de status (nada de entrada) NÃO gera alarme — senão o log vira ruído', async () => {
      wa.parseInboundMessagesFor.mockReturnValue([]);
      chatIngest.ingestFromWebhook.mockResolvedValue({ parsed: 0, persisted: 0 } as never);

      await service.process({ event: 'messages_update' }, 'ch_gozap', 'GOZAP');

      expect(warnedWith(/descartad/i)).toBeUndefined();
    });

    it('quando o chat PARSEIA a mensagem não há alarme (o caminho consertado)', async () => {
      wa.parseInboundMessagesFor.mockReturnValue([
        { fromE164: '+5592987654321', text: 'oi', providerMessageId: 'M1', receivedAt: new Date() },
      ]);
      chatIngest.ingestFromWebhook.mockResolvedValue({ parsed: 1, persisted: 1 } as never);

      await service.process({ event: 'messages' }, 'ch_gozap', 'GOZAP');

      expect(warnedWith(/descartad/i)).toBeUndefined();
    });
  });

  describe('K6 — o ack do broadcast não pode carimbar a campanha errada', () => {
    const ack = {
      providerMessageId: 'wamid.NEW',
      status: 'delivered' as const,
      occurredAt: new Date(),
      recipientPhone: '+5592987654321',
    };

    function candidates(rows: unknown[]) {
      vi.mocked(prisma.message.findUnique).mockResolvedValue(null as never);
      vi.mocked(prisma.message.findMany).mockResolvedValue(rows as never);
      wa.parseWebhookFor.mockReturnValue([ack]);
    }

    function stamps() {
      return vi.mocked(prisma.message.updateMany).mock.calls.filter(
        ([args]) => (args as { data?: { providerMessageId?: string } })?.data?.providerMessageId === 'wamid.NEW',
      );
    }

    /**
     * DUAS campanhas disparadas para a mesma pessoa com MINUTOS de diferença: o
     * ack cabe nas duas e não há como saber de qual é. Aí sim, carimbar seria
     * chutar — e um chute vira prova de entrega da campanha errada.
     */
    it('duas campanhas irmãs disparadas quase juntas: NÃO carimba nenhuma das duas', async () => {
      candidates([
        { id: 'm_B', campaignId: 'camp_B', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() - 120_000), contact: { phoneE164: '+5592987654321' } },
        { id: 'm_A', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() - 300_000), contact: { phoneE164: '+5592987654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      // O carimbo é um updateMany escopado por providerMessageId: null.
      expect(stamps()).toHaveLength(0);
      expect(warnedWith(/ambígu|ambigu/i)).toBeDefined();
    });

    /**
     * O DEFEITO DA 1ª RODADA (revisão adversarial). Como o filtro já exige
     * `providerMessageId: null`, todo candidato ANTIGO é, por definição, uma
     * linha cujo ack SE PERDEU. Recusar sempre que houvesse duas campanhas
     * fazia cada ack perdido ENVENENAR a campanha seguinte para aquela pessoa
     * durante 48h — e o cliente dispara para bases sobrepostas o tempo todo.
     * O número de linhas SENT sem wamid (que o reconciliador ignora para
     * sempre) crescia em vez de encolher, derrubando justamente a prova de
     * entrega que o K6 queria proteger.
     */
    it('órfã de ontem NÃO envenena a campanha de hoje: carimba a que casa com o horário do ack', async () => {
      candidates([
        { id: 'm_hoje', campaignId: 'camp_B', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() - 30_000), contact: { phoneE164: '+5592987654321' } },
        { id: 'm_orfa_ontem', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() - 24 * 3600_000), contact: { phoneE164: '+5592987654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm_hoje', providerMessageId: null } }),
      );
    });

    /**
     * UM ACK NÃO PODE PRECEDER O ENVIO QUE ELE CONFIRMA. A linha disparada
     * DEPOIS do ack é impossível como origem dele — some do desempate em vez
     * de tornar tudo "ambíguo". (É o caso real do disparo lento do Zernio:
     * a campanha de hoje ainda está enfileirando gente enquanto chegam acks
     * da campanha de ontem.)
     */
    it('candidato disparado DEPOIS do ack não é origem possível — não conta como empate', async () => {
      candidates([
        { id: 'm_futura', campaignId: 'camp_B', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() + 600_000), contact: { phoneE164: '+5592987654321' } },
        { id: 'm_plausivel', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(ack.occurredAt.getTime() - 60_000), contact: { phoneE164: '+5592987654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm_plausivel', providerMessageId: null } }),
      );
    });

    /**
     * O desempate é pelo `occurredAt` DO ACK, não pelo relógio de agora: um
     * `delivered` de alguém que estava offline chega horas depois, e o que
     * importa é qual envio ele confirma.
     */
    it('ack atrasado casa com o envio contemporâneo A ELE, não com o mais recente do banco', async () => {
      const atrasado = {
        ...ack,
        occurredAt: new Date(Date.now() - 20 * 3600_000),
      };
      vi.mocked(prisma.message.findUnique).mockResolvedValue(null as never);
      vi.mocked(prisma.message.findMany).mockResolvedValue([
        { id: 'm_recente', campaignId: 'camp_B', status: 'SENT', sentAt: new Date(Date.now() - 3600_000), contact: { phoneE164: '+5592987654321' } },
        { id: 'm_da_epoca', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(atrasado.occurredAt.getTime() - 60_000), contact: { phoneE164: '+5592987654321' } },
      ] as never);
      wa.parseWebhookFor.mockReturnValue([atrasado]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm_da_epoca', providerMessageId: null } }),
      );
    });

    it('candidato ÚNICO continua sendo carimbado (o resgate do broadcast segue vivo)', async () => {
      candidates([
        { id: 'm_unica', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(), contact: { phoneE164: '+5592987654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm_unica', providerMessageId: null },
          data: { providerMessageId: 'wamid.NEW' },
        }),
      );
    });

    /**
     * Duas linhas da MESMA campanha (a mesma pessoa em dois Contacts por causa
     * do 9º dígito) continuam desempatando por `sentAt desc`: a atribuição por
     * CAMPANHA — que é o que a coluna "Campanhas recebidas" e a prova de entrega
     * num questionamento do TSE medem — é inequívoca aí.
     */
    it('duas linhas da MESMA campanha: carimba a mais recente (a campanha é inequívoca)', async () => {
      candidates([
        { id: 'm_9dig', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(), contact: { phoneE164: '+5592987654321' } },
        { id: 'm_8dig', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(Date.now() - 60_000), contact: { phoneE164: '+559287654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm_9dig', providerMessageId: null } }),
      );
    });

    it('a busca de candidatos pede o campaignId e ordena por sentAt desc (asserção sobre o ARGUMENTO)', async () => {
      candidates([
        { id: 'm1', campaignId: 'camp_A', status: 'SENT', sentAt: new Date(), contact: { phoneE164: '+5592987654321' } },
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      const [args] = vi.mocked(prisma.message.findMany).mock.calls[0] as [Record<string, any>];
      // `include` (e não `select`) devolve todos os escalares — inclusive o
      // campaignId de que a desambiguação depende — mantendo a MESMA forma que
      // o caminho por wamid produz.
      expect(args.include?.contact).toBeTruthy();
      expect(args.where.zernioBroadcastId).toEqual({ not: null });
      expect(args.where.providerMessageId).toBeNull();
      expect(args.where.instanceId).toBe('ch_zernio');
      expect(args.orderBy).toEqual({ sentAt: 'desc' });
      // Bounded: nunca materializa uma lista sem teto.
      expect(typeof args.take).toBe('number');
    });
  });
});
