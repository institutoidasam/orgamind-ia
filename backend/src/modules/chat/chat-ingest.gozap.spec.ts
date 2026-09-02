import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { ConsentAction, ConsentSource, MessageDirection } from '@prisma/client';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { ProviderRegistry } from '../whatsapp-providers/provider-registry.service';
import { GozapCloudAdapter } from '../whatsapp-providers/adapters/gozap-cloud.adapter';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type { ChatMediaDownloadJob, BotReplyJob } from '../queue/queue.constants';
import type { Env } from '../../shared/config/env.schema';

/**
 * C9/C19/K3 — O CAMINHO INTEIRO, com o adapter REAL do GoZap.
 *
 * Não há mock de parser aqui de propósito: o webhook cru do GoZap entra pelo
 * `ChatIngestService`, atravessa o `WhatsappProvidersService`, o
 * `ProviderRegistry` e o `GozapCloudAdapter` de produção, e o teste olha o que
 * seria ESCRITO no banco. Era exatamente esse trajeto que devolvia `[]` em
 * silêncio — 74 webhooks reais, HTTP 200, inbox vazia.
 *
 * Doutrina do repo: o Prisma é mock, então o mock ignora o `where`. Todas as
 * asserções abaixo são sobre o ARGUMENTO das chamadas, nunca sobre o retorno
 * fabricado.
 */

const DECLARATION =
  'Autorizo o IDASAM a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.';
const EXPECTED = `${DECLARATION} [CARTAZ-MANAUS]`;

const LINK = {
  id: 'l1',
  token: 'CARTAZ-MANAUS',
  purposeKey: 'convite_atividades',
  consentTextVersion: 'optin-v1',
  expectedText: EXPECTED,
};

function make() {
  const prisma = mockDeep<PrismaService>();
  const events = mockDeep<ChatEventsService>();
  const redis = mockDeep<Redis>();
  const mediaQueue = mockDeep<Queue<ChatMediaDownloadJob>>();
  const botQueue = mockDeep<Queue<BotReplyJob>>();
  const consent = mockDeep<ConsentService>();
  const links = mockDeep<OptInLinkService>();

  redis.get.mockResolvedValue(null);
  vi.mocked(prisma.channel.findUnique).mockResolvedValue({
    evolutionInstanceName: null,
    botId: null,
  } as never);
  vi.mocked(prisma.contact.findMany).mockResolvedValue([{ id: 'c1' }] as never);
  vi.mocked(prisma.contact.create).mockResolvedValue({ id: 'c-novo' } as never);
  vi.mocked(prisma.conversation.upsert).mockResolvedValue({
    id: 'conv1',
    lastMessageAt: null,
    lastInboundAt: null,
  } as never);
  vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.message.create).mockResolvedValue({ id: 'm1', media: null } as never);
  vi.mocked(prisma.message.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.conversation.update).mockResolvedValue({} as never);
  consent.record.mockResolvedValue({ eventId: 'e1', created: true });
  consent.rehydrate.mockResolvedValue([]);
  links.matchInbound.mockResolvedValue(null);

  // O adapter REAL, resolvido pelo registry REAL — é isto que faz o teste medir
  // o trajeto de produção e não uma imitação dele.
  const adapter = new GozapCloudAdapter({
    get: () => 'https://acme.gozap.dev',
  } as unknown as ConfigService);
  const registry = new ProviderRegistry(new Map([['GOZAP', adapter]]));
  const wa = new WhatsappProvidersService(
    adapter,
    mockDeep<WhatsappProvidersRepository>(),
    mockDeep<WhatsappInstancesRepository>(),
    registry,
    mockDeep<ConfigService<Env>>(),
  );

  const svc = new ChatIngestService(
    prisma,
    wa,
    events,
    redis,
    mediaQueue,
    botQueue,
    consent,
    links,
  );
  return { svc, prisma, consent, links, events, botQueue, wa };
}

/** O envelope real do GoZap (whatsmeow `events.Message`), capturado em prod. */
function webhook(
  msg: Record<string, unknown> = { conversation: 'Oi, quero saber mais' },
  info: Record<string, unknown> = {},
) {
  return {
    event: 'messages',
    instance_id: 'rffe51e7ef7c8ff',
    timestamp: 1786126513000,
    data: {
      Info: {
        ID: 'GZ_WAMID_1',
        Chat: '123456789012345@lid',
        Sender: '123456789012345@lid',
        SenderAlt: '5592987654321@s.whatsapp.net',
        IsFromMe: false,
        IsGroup: false,
        PushName: 'Maria',
        Timestamp: '2026-08-07T18:15:13Z',
        Type: 'text',
        ...info,
      },
      Message: msg,
    },
  };
}

describe('ChatIngest × GOZAP — o webhook que chegava e sumia', () => {
  it('a resposta do eleitor vira Message INBOUND na conversa do canal (era [] — nada era escrito)', async () => {
    const { svc, prisma, events } = make();

    const result = await svc.ingestFromWebhook(webhook(), 'ch_gozap', 'GOZAP');

    expect(result).toEqual({ parsed: 1, persisted: 1 });
    const [createArgs] = vi.mocked(prisma.message.create).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data).toMatchObject({
      conversationId: 'conv1',
      instanceId: 'ch_gozap',
      contactId: 'c1',
      direction: MessageDirection.INBOUND,
      kind: 'TEXT',
      content: 'Oi, quero saber mais',
      providerMessageId: 'GZ_WAMID_1',
    });
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.created', instanceId: 'ch_gozap' }),
    );
  });

  /**
   * O parser tem de devolver o JID DO TELEFONE, nunca o `@lid` cru do
   * `Info.Chat` — é isso que este caso mede, e só isso.
   *
   * ⚠️ ESTE TESTE NÃO OBSERVA CONVERSA NENHUMA. `prisma.conversation.*` é mock e
   * ignora o `where`; a fixture aqui tem `SenderAlt` na MESMA grafia do cadastro,
   * então as duas chaves coincidem por construção. O caso de produção — a
   * campanha saiu na grafia de 13 díg. e o WhatsApp reporta a resposta na de 12
   * — está em `chat-ingest.identidade.spec.ts`, com um fake que AVALIA o `where`
   * contra um fixture de conversas.
   */
  it('o parser devolve o JID do telefone, não o @lid do Info.Chat', async () => {
    const { svc, prisma } = make();

    await svc.ingestFromWebhook(webhook(), 'ch_gozap', 'GOZAP');

    const [upsertArgs] = vi.mocked(prisma.conversation.upsert).mock.calls[0] as [
      { where: { instanceId_remoteJid: { remoteJid: string } } },
    ];
    expect(upsertArgs.where.instanceId_remoteJid.remoteJid).toBe(
      '5592987654321@s.whatsapp.net',
    );
  });

  /**
   * O AVATAR NÃO PODE BATER NA PORTA DO EVOLUTION.
   *
   * `fetchProfilePictureUrl` resolve SEMPRE o adapter EVOLUTION (é o único que
   * implementa o método) e endereça a instância pelo NOME. Num canal GOZAP não
   * há `evolutionInstanceName`: a chamada nasce condenada — 404/erro de
   * configuração engolido pelo try/catch — e só serve para encher o log de erro
   * do Evolution a cada conversa nova do canal novo. Com o inbound do GoZap
   * vivo, esse bloco passou a rodar de verdade pela primeira vez.
   */
  it('canal sem instância Evolution não vai buscar avatar (a chamada nasceria condenada)', async () => {
    const { svc, prisma, wa } = make();
    const spy = vi
      .spyOn(wa, 'fetchProfilePictureUrl')
      .mockResolvedValue(null as never);

    await svc.ingestFromWebhook(webhook(), 'ch_gozap', 'GOZAP');

    expect(spy).not.toHaveBeenCalled();
    const [upsertArgs] = vi.mocked(prisma.conversation.upsert).mock.calls[0] as [
      { create: Record<string, unknown> },
    ];
    // Sem tentativa, sem carimbo de tentativa.
    expect(upsertArgs.create.profilePicFetchedAt).toBeUndefined();
  });

  it('canal COM instância Evolution continua buscando o avatar (nenhuma regressão)', async () => {
    const { svc, prisma, wa } = make();
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      evolutionInstanceName: 'inst-evo',
      botId: null,
    } as never);
    const spy = vi
      .spyOn(wa, 'fetchProfilePictureUrl')
      .mockResolvedValue('https://cdn/foto.jpg' as never);

    await svc.ingestFromWebhook(webhook(), 'ch_gozap', 'GOZAP');

    expect(spy).toHaveBeenCalledWith('5592987654321@s.whatsapp.net', 'inst-evo');
  });

  /**
   * K3 — num canal GoZap a base SÓ PERDIA audiência: o opt-out roda pelo
   * `parseInboundMessages` (que o adapter sempre teve) e os dois atos de opt-in
   * moram aqui, num caminho que estava morto.
   */
  describe('K3 — o opt-in volta a existir no canal GOZAP', () => {
    it('texto que CASA com o link do cartaz/QR grava o GRANT com a evidência crua', async () => {
      const { svc, consent, links } = make();
      links.matchInbound.mockResolvedValue(LINK);

      await svc.ingestFromWebhook(webhook({ conversation: EXPECTED }), 'ch_gozap', 'GOZAP');

      expect(links.matchInbound).toHaveBeenCalledWith(EXPECTED);
      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c1',
          phoneE164: '+5592987654321',
          purposeKey: 'convite_atividades',
          action: ConsentAction.GRANT,
          source: ConsentSource.WA_LINK,
          channelId: 'ch_gozap',
          evidenceText: EXPECTED,
        }),
      );
    });

    it('toque no botão de aceite grava o GRANT atribuído à campanha da janela', async () => {
      const { svc, prisma, consent } = make();
      vi.mocked(prisma.message.findMany).mockResolvedValue([
        {
          id: 'out1',
          providerMessageId: 'OUT_WAMID',
          content: 'Você autoriza receber nossas mensagens?',
          campaignId: 'camp_1',
          createdAt: new Date('2026-08-07T17:00:00Z'),
          campaign: {
            purposeKey: 'convite_atividades',
            template: { metaName: 'convite', twilioContentSid: null },
          },
        },
      ] as never);

      await svc.ingestFromWebhook(
        webhook({
          buttonsResponseMessage: {
            selectedButtonId: 'optin_yes',
            selectedDisplayText: 'Sim, quero receber',
          },
        }),
        'ch_gozap',
        'GOZAP',
      );

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ConsentAction.GRANT,
          source: ConsentSource.WA_BUTTON,
          purposeKey: 'convite_atividades',
          evidenceText: 'Você autoriza receber nossas mensagens?',
        }),
      );
    });

    /**
     * O erro CARO é o falso positivo: um `ConsentEvent` append-only afirmando
     * que um eleitor autorizou. Um inbound comum abre a janela e nada mais.
     */
    it('inbound comum NÃO grava consentimento nenhum', async () => {
      const { svc, consent } = make();

      await svc.ingestFromWebhook(
        webhook({ conversation: 'quem são vocês?' }),
        'ch_gozap',
        'GOZAP',
      );

      expect(consent.record).not.toHaveBeenCalled();
    });

    it('DIGITAR "Sim, quero receber" não é toque de botão e não grava consentimento', async () => {
      const { svc, consent } = make();

      await svc.ingestFromWebhook(
        webhook({ conversation: 'Sim, quero receber' }),
        'ch_gozap',
        'GOZAP',
      );

      expect(consent.record).not.toHaveBeenCalled();
    });
  });

  it('mensagem de GRUPO não escreve nada (nem Message, nem consentimento)', async () => {
    const { svc, prisma, consent } = make();

    const result = await svc.ingestFromWebhook(
      webhook({ conversation: 'não' }, { IsGroup: true, Chat: '1203630@g.us' }),
      'ch_gozap',
      'GOZAP',
    );

    expect(result).toEqual({ parsed: 0, persisted: 0 });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('recibo de status (messages_update) não vira mensagem de chat', async () => {
    const { svc, prisma } = make();

    const result = await svc.ingestFromWebhook(
      { event: 'messages_update', data: { MessageIDs: ['GZ_WAMID_1'], Type: '' } },
      'ch_gozap',
      'GOZAP',
    );

    expect(result).toEqual({ parsed: 0, persisted: 0 });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('o bot é enfileirado quando o canal GOZAP tem bot (o ramo era morto por falta de INBOUND)', async () => {
    const { svc, prisma, botQueue } = make();
    vi.mocked(prisma.channel.findUnique).mockResolvedValue({
      evolutionInstanceName: null,
      botId: 'bot_1',
    } as never);

    await svc.ingestFromWebhook(webhook(), 'ch_gozap', 'GOZAP');

    expect(botQueue.add).toHaveBeenCalledWith(
      'reply',
      { conversationId: 'conv1', messageId: 'm1' },
      { jobId: 'm1' },
    );
  });
});
