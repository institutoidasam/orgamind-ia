import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import { ZernioCloudAdapter } from '../whatsapp-providers/adapters/zernio-cloud.adapter';

/**
 * O caminho REAL da campanha de opt-in, ponta a ponta: webhook cru da Zernio →
 * adapter (parse de verdade, não mock) → ChatIngestService → ConsentService.
 *
 * Por que este arquivo existe: o spec do chat-ingest mocka
 * `parseInboundChatMessages` e injeta `buttonPayload: 'optin_yes'` na mão — ou
 * seja, testa o ingest assumindo um payload que o canal ZERNIO nunca produz. O
 * envio da Zernio (`POST /inbox/conversations`) não tem campo algum para o
 * payload de um quick_reply, então o literal `optin_yes` jamais sai do orgamind e
 * jamais volta: no tap chega o RÓTULO do botão. A junta entre adapter e ingest
 * era exatamente o ponto cego — e é onde o consentimento sumia.
 *
 * Aqui o adapter é o de verdade. É o único teste que prova que o clique em
 * "Sim, quero receber" vira ConsentEvent — e, sobretudo, que o clique em
 * "Não quero receber" NÃO vira.
 */
describe('opt-in por botão, ponta a ponta (webhook Zernio → consentimento)', () => {
  let prisma: MockProxy<PrismaService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let consent: MockProxy<ConsentService>;
  let links: MockProxy<OptInLinkService>;
  let svc: ChatIngestService;

  const zernio = new ZernioCloudAdapter({
    get: (k: string) =>
      ({
        ZERNIO_API_KEY: 'sk_test_0000000000000000',
        ZERNIO_BASE_URL: 'https://zernio.com/api/v1',
      })[k],
  } as unknown as ConfigService);

  const receivedAt = new Date('2026-07-12T12:00:00.000Z');

  /** Webhook cru de `message.received`. `metadata` presente = TOQUE em botão. */
  const webhook = (opts: { text?: string; buttonPayload?: string }) => ({
    id: 'evt',
    event: 'message.received',
    message: { id: 'msg_in', platformMessageId: 'wamid.IN==', message: opts.text },
    conversation: { id: 'c1', participantId: '5592987654321', participantName: 'Maria' },
    account: { id: 'acc', platform: 'whatsapp' },
    timestamp: receivedAt.toISOString(),
    ...(opts.buttonPayload
      ? { metadata: { buttonPayload: opts.buttonPayload, interactiveType: '' } }
      : {}),
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    wa = mockDeep<WhatsappProvidersService>();
    consent = mockDeep<ConsentService>();
    links = mockDeep<OptInLinkService>();
    const events = mockDeep<ChatEventsService>();
    const redis = { set: vi.fn().mockResolvedValue('OK'), get: vi.fn().mockResolvedValue(null) };
    const queue = { add: vi.fn() } as never;

    svc = new ChatIngestService(
      prisma, wa, events, redis as never, queue, queue, consent, links,
    );

    // O adapter REAL faz o parse — é este o contrato sob teste.
    wa.parseInboundChatMessages.mockImplementation((p: unknown) =>
      zernio.parseInboundChatMessages(p),
    );

    links.matchInbound.mockResolvedValue(null);
    consent.record.mockResolvedValue({ eventId: 'ev1', created: true });
    prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);
    prisma.channel.findUnique.mockResolvedValue(null);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', contactId: 'ct1' } as never);
    prisma.message.create.mockResolvedValue({ id: 'msg1', media: null } as never);
    prisma.conversation.update.mockResolvedValue({} as never);
    // A OUTBOUND que exibiu o pedido: dá a finalidade e o texto de prova. Uma
    // só campanha na janela — o caso do disparo de amanhã.
    prisma.message.findMany.mockResolvedValue([outbound()] as never);
  });

  /** Uma outbound de campanha candidata à atribuição do clique. */
  const outbound = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'out1',
    providerMessageId: 'OUT-wamid',
    content: 'Podemos continuar te enviando novidades da campanha?',
    campaignId: 'cmp_reapresentacao',
    createdAt: new Date('2026-07-10T09:00:00.000Z'),
    campaign: {
      purposeKey: 'campanha_eleitoral',
      template: { metaName: 'reapresentacao_optin', twilioContentSid: null },
    },
    ...over,
  });

  it('(a) tap em "Sim, quero receber" GRAVA o consentimento', async () => {
    await svc.ingestFromWebhook(
      webhook({ text: 'Sim, quero receber', buttonPayload: 'Sim, quero receber' }),
      'i1',
    );

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'ct1',
        phoneE164: '+5592987654321',
        purposeKey: 'campanha_eleitoral',
        action: ConsentAction.GRANT,
        source: ConsentSource.WA_BUTTON,
        evidenceText: 'Podemos continuar te enviando novidades da campanha?',
        occurredAt: receivedAt,
      }),
    );
  });

  it('(b) tap em "Não quero receber" é OPT-OUT — NUNCA grava consentimento', async () => {
    // Contém a substring "quero receber". Um matcher frouxo gravaria aqui um
    // GRANT append-only dizendo que a pessoa autorizou — prova falsa.
    for (const label of ['Não quero receber', 'nao quero receber', 'NÃO QUERO RECEBER']) {
      consent.record.mockClear();
      await svc.ingestFromWebhook(webhook({ text: label, buttonPayload: label }), 'i1');
      expect(consent.record).not.toHaveBeenCalled();
    }
  });

  it('(c) texto livre "sim" DIGITADO não grava consentimento (só o toque conta)', async () => {
    for (const text of ['sim', 'Sim, quero receber', 'quero receber']) {
      consent.record.mockClear();
      await svc.ingestFromWebhook(webhook({ text }), 'i1'); // sem metadata = sem tap
      expect(consent.record).not.toHaveBeenCalled();
    }
  });

  it('(d) rótulo desconhecido/ambíguo NÃO grava (falha para o lado seguro)', async () => {
    for (const label of ['Talvez depois', 'Quero saber mais', 'Falar com a equipe', 'Sim']) {
      consent.record.mockClear();
      await svc.ingestFromWebhook(webhook({ text: label, buttonPayload: label }), 'i1');
      expect(consent.record).not.toHaveBeenCalled();
    }
  });

  it('(e) "Pode enviar" NÃO vira consentimento (autorizar um envio ≠ pedir mensagens)', async () => {
    // O rótulo é texto livre do operador. Um template alheio ("Podemos enviar
    // seu comprovante?" → [Pode enviar]) não pode herdar a finalidade da
    // campanha de opt-in e virar GRANT append-only.
    for (const label of ['Pode enviar', 'Sim, pode enviar', 'Autorizo o envio']) {
      consent.record.mockClear();
      await svc.ingestFromWebhook(webhook({ text: label, buttonPayload: label }), 'i1');
      expect(consent.record).not.toHaveBeenCalled();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ATRIBUIÇÃO — a prova tem que ser da mensagem QUE EXIBIU O BOTÃO.
  //
  // O código pegava a ÚLTIMA outbound de campanha do contato. Tap tardio (a
  // pessoa rola a conversa e toca no "Sim" da mensagem antiga) + uma campanha
  // nova no meio = GRANT carimbado com a finalidade e o TEXTO de outra campanha,
  // que nem botão de opt-in tinha. Prova falsa, append-only.
  // ───────────────────────────────────────────────────────────────────────────
  it('(f) DUAS campanhas na janela: o clique NÃO é atribuído a nenhuma (não grava)', async () => {
    prisma.message.findMany.mockResolvedValue([
      // a mais recente é OUTRA campanha, com outra finalidade e outro corpo
      outbound({
        id: 'out2',
        providerMessageId: 'OUT-B',
        campaignId: 'cmp_agenda',
        content: 'Nosso comício é sábado às 10h.',
        createdAt: new Date('2026-07-12T08:00:00.000Z'),
        campaign: {
          purposeKey: 'agenda_eventos',
          template: { metaName: 'agenda', twilioContentSid: null },
        },
      }),
      outbound(),
    ] as never);

    await svc.ingestFromWebhook(
      webhook({ text: 'Sim, quero receber', buttonPayload: 'Sim, quero receber' }),
      'i1',
    );

    expect(consent.record).not.toHaveBeenCalled();
  });

  it('(g) campanha sem finalidade (purposeKey null) NÃO grava — não se inventa finalidade', async () => {
    prisma.message.findMany.mockResolvedValue([
      outbound({ campaign: { purposeKey: null, template: {} } }),
    ] as never);

    await svc.ingestFromWebhook(
      webhook({ text: 'Sim, quero receber', buttonPayload: 'Sim, quero receber' }),
      'i1',
    );

    expect(consent.record).not.toHaveBeenCalled();
  });

  it('(h) outbound sem corpo renderizado NÃO grava — sem prova não há registro', async () => {
    prisma.message.findMany.mockResolvedValue([outbound({ content: null })] as never);

    await svc.ingestFromWebhook(
      webhook({ text: 'Sim, quero receber', buttonPayload: 'Sim, quero receber' }),
      'i1',
    );

    expect(consent.record).not.toHaveBeenCalled();
  });

  it('(i2) botão TOCADO e não reconhecido GRITA no log (o modo de falha silencioso)', async () => {
    // Se o rótulo do template sair da lista fechada, ou se a Zernio devolver o
    // tap num formato que não prevemos (um índice "0"/"1", um id opaco), o
    // clique não vira nada. Sem este warn, não viraria nem log — foi assim que a
    // colheita inteira ia para o lixo em silêncio. É o alarme a monitorar na 1ª
    // hora do disparo.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await svc.ingestFromWebhook(webhook({ text: 'Bora!', buttonPayload: 'Bora!' }), 'i1');
      expect(consent.record).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ buttonPayload: 'Bora!', buttonLabel: 'Bora!' }),
        expect.stringContaining('BOTÃO TOCADO NÃO RECONHECIDO'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('(i) a evidência diz COMO o clique foi atribuído e a qual campanha', async () => {
    await svc.ingestFromWebhook(
      webhook({ text: 'Sim, quero receber', buttonPayload: 'Sim, quero receber' }),
      'i1',
    );

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          outboundWamid: 'OUT-wamid',
          campaignId: 'cmp_reapresentacao',
          attribution: 'sole-campaign-in-window',
          buttonPayload: 'optin_yes',
          buttonLabel: 'Sim, quero receber',
        }),
      }),
    );
  });
});
