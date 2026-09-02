import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { ConsentAction, MessageDirection, Prisma } from '@prisma/client';
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
 * I13/I14 — A IDENTIDADE NO CAMINHO DE ENTRADA.
 *
 * O eleitor é UMA pessoa com DUAS grafias possíveis (o 9º dígito). A campanha
 * saiu na grafia da planilha (13 díg.); o WhatsApp reporta a resposta na grafia
 * legada (12 díg.). Estes testes exigem que a resposta caia no MESMO Contact e
 * na MESMA Conversation que o disparo — nada aqui pode depender de qual linha o
 * Postgres devolve primeiro.
 *
 * Doutrina do repo: o Prisma é mock e o mock IGNORA o `where`. Por isso os
 * fakes abaixo AVALIAM o `where` recebido contra um fixture — a asserção é
 * sobre o ARGUMENTO da chamada, nunca sobre um retorno fabricado.
 */

/** A pessoa, nas duas grafias. A campanha conhece a de 13; o WhatsApp reporta a de 12. */
const PLANILHA = { id: 'c-13', phoneE164: '+5592987654321' };
const INGEST = { id: 'c-12', phoneE164: '+559287654321' };

/**
 * Ordem de ÍNDICE do Postgres (`Contact_phoneE164_key`): a forma legada de 12
 * dígitos ordena ANTES da moderna. É a ordem que um `findFirst` sem `orderBy`
 * recebe numa tabela de produção — e é o gêmeo ERRADO.
 */
const EM_ORDEM_DE_INDICE = [INGEST, PLANILHA];

type Where = Record<string, any>;

function inArray(clause: unknown, value: string): boolean {
  if (typeof clause === 'string') return clause === value;
  if (clause && typeof clause === 'object' && Array.isArray((clause as any).in)) {
    return ((clause as any).in as string[]).includes(value);
  }
  return false;
}

/** Avalia o `where` de Contact contra uma linha do fixture (o mock não avalia). */
function contactMatches(
  where: Where,
  row: { id: string; phoneE164: string },
): boolean {
  if (where.phoneE164 !== undefined && !inArray(where.phoneE164, row.phoneE164))
    return false;
  if (where.id !== undefined && !inArray(where.id, row.id)) return false;
  return true;
}

type ConvRow = {
  id: string;
  instanceId: string;
  remoteJid: string;
  phoneE164: string | null;
  contactId: string | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
};

/** Avalia o `where` de Conversation (instanceId + OR) contra uma linha do fixture. */
function conversationMatches(where: Where, row: ConvRow): boolean {
  if (where.instanceId_remoteJid !== undefined) {
    return (
      where.instanceId_remoteJid.instanceId === row.instanceId &&
      where.instanceId_remoteJid.remoteJid === row.remoteJid
    );
  }
  if (where.instanceId !== undefined && where.instanceId !== row.instanceId)
    return false;
  if (Array.isArray(where.OR)) {
    return where.OR.some((c: Where) => {
      if (c.contactId !== undefined) return c.contactId === row.contactId;
      if (c.phoneE164 !== undefined)
        return row.phoneE164 !== null && inArray(c.phoneE164, row.phoneE164);
      if (c.remoteJid !== undefined) return inArray(c.remoteJid, row.remoteJid);
      return false;
    });
  }
  return true;
}

function make(
  opts: {
    contacts?: { id: string; phoneE164: string }[];
    conversations?: ConvRow[];
  } = {},
) {
  const contacts = opts.contacts ?? EM_ORDEM_DE_INDICE;
  const conversations = opts.conversations ?? [];

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

  // Os dois caminhos de resolução de contato, ambos alimentados pelo MESMO
  // fixture e ambos avaliando o `where` de verdade.
  vi.mocked(prisma.contact.findFirst).mockImplementation((async (args: any) =>
    contacts.find((c) => contactMatches(args?.where ?? {}, c)) ?? null) as never);
  vi.mocked(prisma.contact.findMany).mockImplementation((async (args: any) =>
    contacts.filter((c) => contactMatches(args?.where ?? {}, c))) as never);
  vi.mocked(prisma.contact.create).mockResolvedValue({ id: 'c-novo' } as never);

  vi.mocked(prisma.conversation.findFirst).mockImplementation((async (args: any) =>
    conversations.find((c) => conversationMatches(args?.where ?? {}, c)) ??
    null) as never);
  vi.mocked(prisma.conversation.findUnique).mockImplementation((async (args: any) =>
    conversations.find((c) => conversationMatches(args?.where ?? {}, c)) ??
    null) as never);
  vi.mocked(prisma.conversation.upsert).mockImplementation((async (args: any) => {
    const found = conversations.find((c) =>
      conversationMatches(args?.where ?? {}, c),
    );
    return found ?? { id: 'conv-NOVA', lastMessageAt: null, lastInboundAt: null };
  }) as never);
  vi.mocked(prisma.conversation.update).mockImplementation((async (args: any) => {
    const found = conversations.find((c) => c.id === args?.where?.id);
    return found ?? {};
  }) as never);
  vi.mocked(prisma.message.create).mockResolvedValue({
    id: 'm1',
    media: null,
  } as never);
  vi.mocked(prisma.message.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never);
  consent.record.mockResolvedValue({ eventId: 'e1', created: true });
  consent.rehydrate.mockResolvedValue([]);
  links.matchInbound.mockResolvedValue(null);

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
  return { svc, prisma, consent, links, events };
}

/** Webhook do GoZap com o remetente na grafia LEGADA (12 díg.) — o caso de produção. */
function webhookLegado(msg: Record<string, unknown> = { conversation: 'Oi' }) {
  return {
    event: 'messages',
    instance_id: 'rffe51e7ef7c8ff',
    timestamp: 1786126513000,
    data: {
      Info: {
        ID: 'GZ_WAMID_1',
        Chat: '123456789012345@lid',
        Sender: '123456789012345@lid',
        SenderAlt: '559287654321@s.whatsapp.net',
        IsFromMe: false,
        IsGroup: false,
        PushName: 'Maria',
        Timestamp: '2026-08-07T18:15:13Z',
        Type: 'text',
      },
      Message: msg,
    },
  };
}

describe('I13 — o inbound resolve o MESMO titular que o resto do sistema', () => {
  it('com os dois gêmeos na base, a mensagem é gravada no contato de 13 dígitos (o que a audiência enxerga)', async () => {
    const { svc, prisma } = make();

    await svc.ingestFromWebhook(webhookLegado(), 'ch_gozap', 'GOZAP');

    const [createArgs] = vi.mocked(prisma.message.create).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.contactId).toBe('c-13');
  });

  it('o GRANT do botão é gravado no contato de 13 dígitos — não no gêmeo do ingest', async () => {
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
      webhookLegado({
        buttonsResponseMessage: {
          selectedButtonId: 'optin_yes',
          selectedDisplayText: 'Sim, quero receber',
        },
      }),
      'ch_gozap',
      'GOZAP',
    );

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-13', action: ConsentAction.GRANT }),
    );
  });

  /**
   * A guarda "CAMPANHA ÚNICA E INEQUÍVOCA" pergunta por contactId. Com o titular
   * partido em dois, ela enxerga METADE da janela: duas campanhas viram uma só,
   * a guarda passa, e o GRANT é gravado com a finalidade da campanha ERRADA —
   * prova falsa num registro append-only.
   */
  it('a janela de atribuição do botão é buscada nos DOIS gêmeos (senão a guarda de ambiguidade fica cega)', async () => {
    const { svc, prisma } = make();

    await svc.ingestFromWebhook(
      webhookLegado({
        buttonsResponseMessage: {
          selectedButtonId: 'optin_yes',
          selectedDisplayText: 'Sim, quero receber',
        },
      }),
      'ch_gozap',
      'GOZAP',
    );

    const [findArgs] = vi.mocked(prisma.message.findMany).mock.calls[0] as [
      { where: { contactId: unknown } },
    ];
    expect(findArgs.where.contactId).toEqual({
      in: expect.arrayContaining(['c-12', 'c-13']),
    });
  });
});

describe('I14 — a resposta pousa na conversa que o disparo abriu', () => {
  /** A conversa que o espelho da campanha criou: JID da grafia GRAVADA (13 díg.). */
  const CONVERSA_DA_CAMPANHA: ConvRow = {
    id: 'conv-campanha',
    instanceId: 'ch_gozap',
    remoteJid: '5592987654321@s.whatsapp.net',
    phoneE164: '+5592987654321',
    contactId: 'c-13',
    lastMessageAt: new Date('2026-08-07T17:00:00Z'),
    lastInboundAt: null,
  };

  it('campanha sai na grafia A, eleitor responde na grafia B: mesma conversa, mesmo contato', async () => {
    const { svc, prisma } = make({
      contacts: [PLANILHA],
      conversations: [CONVERSA_DA_CAMPANHA],
    });

    await svc.ingestFromWebhook(webhookLegado(), 'ch_gozap', 'GOZAP');

    const [createArgs] = vi.mocked(prisma.message.create).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data).toMatchObject({
      conversationId: 'conv-campanha',
      contactId: 'c-13',
      direction: MessageDirection.INBOUND,
    });
    // Uma SEGUNDA conversa nunca pode nascer para a mesma pessoa no mesmo canal.
    expect(prisma.conversation.upsert).not.toHaveBeenCalled();
  });

  /**
   * O reparo de contatos duplicados APAGA a conversa perdedora, e ele roda a
   * cada deploy — bem enquanto os webhooks continuam chegando. Se a conversa
   * resolvida sumir entre a leitura e a escrita, a mensagem do eleitor não pode
   * evaporar da inbox.
   */
  it('conversa resolvida apagada por baixo (P2025): a mensagem ainda entra, na conversa deste JID', async () => {
    const { svc, prisma } = make({
      contacts: [PLANILHA],
      conversations: [CONVERSA_DA_CAMPANHA],
    });
    vi.mocked(prisma.conversation.update).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to update not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    await svc.ingestFromWebhook(webhookLegado(), 'ch_gozap', 'GOZAP');

    expect(prisma.conversation.upsert).toHaveBeenCalled();
    const [createArgs] = vi.mocked(prisma.message.create).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.conversationId).toBe('conv-NOVA');
  });

  it('sem conversa nenhuma, o ingest continua criando a sua (nenhuma regressão)', async () => {
    const { svc, prisma } = make({ contacts: [PLANILHA], conversations: [] });

    await svc.ingestFromWebhook(webhookLegado(), 'ch_gozap', 'GOZAP');

    expect(prisma.conversation.upsert).toHaveBeenCalled();
    const [upsertArgs] = vi.mocked(prisma.conversation.upsert).mock.calls[0] as [
      { where: { instanceId_remoteJid: { remoteJid: string } } },
    ];
    expect(upsertArgs.where.instanceId_remoteJid.remoteJid).toBe(
      '559287654321@s.whatsapp.net',
    );
  });
});
