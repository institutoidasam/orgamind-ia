import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { ConsentAction, ConsentSource, Prisma } from '@prisma/client';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type { ChatMediaDownloadJob, BotReplyJob } from '../queue/queue.constants';

/**
 * C3 — o casamento do inbound com o texto esperado (spec §3.1).
 *
 * A regra que estes testes travam, e que é a razão de a feature existir:
 *
 *   inbound que CASA com o texto de um link ativo  → GRANT, com evidência
 *   inbound que NÃO casa (qualquer outro)          → SÓ ABRE A JANELA
 *
 * O segundo caso é o coração da correção. O orgamind gravava opt-in a partir de
 * QUALQUER inbound de contato conhecido — quem respondia "não tenho interesse"
 * passava a constar como titular que CONSENTIU. Um inbound é uma interação, não
 * uma manifestação "livre, informada e inequívoca... para uma finalidade
 * determinada" (LGPD art. 5º XII).
 */

const DECLARATION =
  'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.';
const EXPECTED = `${DECLARATION} [FEIRA-MANAUS-2026]`;

const LINK = {
  id: 'l1',
  token: 'FEIRA-MANAUS-2026',
  purposeKey: 'convite_atividades',
  consentTextVersion: 'optin-v1',
  expectedText: EXPECTED,
};

function make() {
  const prisma = mockDeep<PrismaService>();
  const wa = mockDeep<WhatsappProvidersService>();
  const events = mockDeep<ChatEventsService>();
  const redis = mockDeep<Redis>();
  const mediaQueue = mockDeep<Queue<ChatMediaDownloadJob>>();
  const botQueue = mockDeep<Queue<BotReplyJob>>();
  const consent = mockDeep<ConsentService>();
  const links = mockDeep<OptInLinkService>();

  redis.get.mockResolvedValue(null);
  prisma.channel.findUnique.mockResolvedValue({
    evolutionInstanceName: 'picoa-x',
    botId: null,
  } as never);
  // contato CONHECIDO — é justamente o caso em que o bug antigo fabricava opt-in
  prisma.contact.findMany.mockResolvedValue([{ id: 'c1' }] as never);
  prisma.contact.create.mockResolvedValue({ id: 'c-novo' } as never);
  prisma.contact.findUnique.mockResolvedValue(null as never);
  prisma.conversation.upsert.mockResolvedValue({ id: 'conv1' } as never);
  prisma.conversation.findUnique.mockResolvedValue(null as never);
  prisma.message.create.mockResolvedValue({ id: 'm1', media: null } as never);
  prisma.conversation.update.mockResolvedValue({} as never);
  consent.record.mockResolvedValue({ eventId: 'e1', created: true });
  consent.rehydrate.mockResolvedValue([]);
  links.matchInbound.mockResolvedValue(null);

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
  return { svc, wa, prisma, consent, links };
}

function inbound(text: string, extra: Record<string, unknown> = {}) {
  return {
    providerMessageId: 'SMwamid1',
    remoteJid: '5592987654321@s.whatsapp.net',
    phoneE164: '+5592987654321',
    isGroup: false,
    fromMe: false,
    kind: 'TEXT',
    text,
    transcript: null,
    media: null,
    quotedWaMessageId: null,
    quotedPreview: null,
    pushName: 'Maria',
    altJid: null,
    receivedAt: new Date('2026-07-11T12:00:00Z'),
    ...extra,
  };
}

describe('ChatIngest — casamento wa.me/QR (spec §3.1)', () => {
  it('CASA → grava GRANT na finalidade do link, com a evidência completa', async () => {
    const { svc, wa, consent, links } = make();
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(links.matchInbound).toHaveBeenCalledWith(EXPECTED);
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c1',
        phoneE164: '+5592987654321',
        purposeKey: 'convite_atividades',
        action: ConsentAction.GRANT,
        source: ConsentSource.WA_LINK,
        channelId: 'i1',
        // a prova é o TEXTO RECEBIDO, cru — não o que achamos que ele seria
        evidenceText: EXPECTED,
        consentTextVersion: 'optin-v1',
        occurredAt: new Date('2026-07-11T12:00:00Z'),
      }),
    );
    const evidence = consent.record.mock.calls[0][0].evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({
      inboundWamid: 'SMwamid1',
      text: EXPECTED,
      expectedText: EXPECTED,
      matched: true,
      originToken: 'FEIRA-MANAUS-2026',
      linkId: 'l1',
    });
  });

  /** O TESTE DA CORREÇÃO. Não casou → janela, e só. */
  it('NÃO CASA ("oi") → abre a janela e NÃO consente', async () => {
    const { svc, wa, consent, links, prisma } = make();
    links.matchInbound.mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([inbound('oi')] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).not.toHaveBeenCalled();
    // …mas a JANELA de atendimento de 24h abre normalmente
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastInboundAt: new Date('2026-07-11T12:00:00Z') }),
      }),
    );
  });

  it('NÃO CASA ("não tenho interesse") → NÃO consente (era isto que fabricava opt-in)', async () => {
    const { svc, wa, consent, links } = make();
    links.matchInbound.mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound('não tenho interesse, para de me mandar isso'),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).not.toHaveBeenCalled();
  });

  it('token de um link inexistente/desativado → matchInbound devolve null → NÃO consente', async () => {
    const { svc, wa, consent, links } = make();
    links.matchInbound.mockResolvedValue(null); // o serviço não resolveu o token
    wa.parseInboundChatMessages.mockReturnValue([
      inbound(`${DECLARATION} [TOKEN-QUE-NAO-EXISTE]`),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).not.toHaveBeenCalled();
  });

  /**
   * §3.4 — o referral do anúncio ATRIBUI o ato afirmativo ao CTWA. O que consente
   * continua sendo o texto que casa; o `ctwaClid` diz de onde a pessoa veio (e é
   * evidência verificável na Meta, não auto-declarada).
   */
  it('CASA + referral de CTWA → source=CTWA_AD, com o ctwaClid na evidência', async () => {
    const { svc, wa, consent, links } = make();
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound(EXPECTED, {
        referral: {
          ctwaClid: 'ctwa_abc123',
          headline: 'Cursos do IDASAM',
          body: 'Inscreva-se',
          sourceId: '120210000000',
          sourceUrl: 'https://fb.me/anuncio',
        },
      }),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: ConsentSource.CTWA_AD }),
    );
    expect(consent.record.mock.calls[0][0].evidence).toMatchObject({
      referralCtwaClid: 'ctwa_abc123',
      referralHeadline: 'Cursos do IDASAM',
      referralBody: 'Inscreva-se',
      referralSourceId: '120210000000',
      referralSourceUrl: 'https://fb.me/anuncio',
    });
  });

  /**
   * O clique no anúncio consente AQUELA CONVERSA, não marketing contínuo
   * (§3.4). Sem o ato afirmativo (o texto que casa), o CTWA abre a janela/FEP e
   * nada mais — exatamente como qualquer outro inbound.
   */
  it('referral de CTWA SEM texto que casa → NÃO consente (o anúncio não é opt-in)', async () => {
    const { svc, wa, consent, links } = make();
    links.matchInbound.mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound('oi, vi o anúncio', { referral: { ctwaClid: 'ctwa_abc123' } }),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).not.toHaveBeenCalled();
  });

  it('uma falha do consentimento NUNCA derruba o ingest (best-effort)', async () => {
    const { svc, wa, consent, links, prisma } = make();
    links.matchInbound.mockResolvedValue(LINK);
    consent.record.mockRejectedValue(new Error('boom'));
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    // Não rejeita E a mensagem entra na inbox: o ingest devolve a contagem
    // (`{parsed, persisted}`), que é o que torna VISÍVEL o descarte silencioso
    // de um provider sem parser de chat. `toBeUndefined` aqui congelava o
    // retorno `void` antigo, não o comportamento sob teste.
    await expect(svc.ingestFromWebhook({}, "i1")).resolves.toEqual({
      parsed: 1,
      persisted: 1,
    });
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('eco OUTBOUND nosso não é casado com link nenhum (só INBOUND consente)', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.message.findUnique.mockResolvedValue(null as never);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound(EXPECTED, { fromMe: true, providerMessageId: 'SMecho' }),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(links.matchInbound).not.toHaveBeenCalled();
    expect(consent.record).not.toHaveBeenCalled();
  });
});

/**
 * O KIT DE COLETA TEM DE COLETAR.
 *
 * O furo: o ingest só PROCURAVA o contato (`findFirst` por phoneE164), nunca o
 * criava. Quem escaneava o QR do cartaz — uma pessoa que, por definição, ainda
 * NÃO está na base — mandava a declaração, a conversa aparecia na inbox… e
 * nenhum `Contact` nascia. Sem `Contact` não há `ContactConsent` (a linha é
 * chaveada por `contactId`), e sem `ContactConsent` o gate de campanha pula a
 * pessoa: ela autorizou e mesmo assim nenhuma campanha a alcança. O painel
 * mostrava `podemReceberHoje: 0` com o cartaz funcionando.
 *
 * Ou seja: o único canal de coleta legítimo que a feature construiu (§3.1) não
 * conseguia produzir um destinatário. O opt-in por link/QR agora CRIA o contato.
 */
describe('ChatIngest — o inbound MATERIALIZA o contato (senão o opt-in não endereça ninguém)', () => {
  it('CASA de número DESCONHECIDO → cria o Contact e grava o GRANT COM o contactId', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never); // ninguém na base
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    // o contato NASCE, com o ProfileName do WhatsApp como nome
    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneE164: '+5592987654321', name: 'Maria' }),
      }),
    );
    // …e o GRANT é gravado COM o contactId — é isto que materializa o
    // ContactConsent e põe a pessoa na base endereçável.
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-novo',
        phoneE164: '+5592987654321',
        purposeKey: 'convite_atividades',
        action: ConsentAction.GRANT,
      }),
    );
  });

  /**
   * C5.3 — o contato é novo, a PESSOA pode não ser. A trilha (`ConsentEvent`) é
   * durável por `phoneHash`; o `ContactConsent` cai por cascata. Reidratamos
   * ANTES do GRANT desta mensagem, para que ele recomponha sobre a história
   * inteira e não sobre um estado derivado pela metade — a mesma ordem que a
   * landing pública já usa.
   */
  it('contato NOVO → reidrata a trilha do phoneHash ANTES de gravar o GRANT', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.rehydrate).toHaveBeenCalledWith('c-novo', '+5592987654321');
    expect(consent.rehydrate.mock.invocationCallOrder[0]).toBeLessThan(
      consent.record.mock.invocationCallOrder[0],
    );
  });

  /**
   * A DECISÃO do inbound que NÃO casa: cria o contato, e NUNCA o consentimento.
   *
   * A conversa já aparece na inbox — negar o `Contact` só deixava a base
   * incoerente (uma conversa órfã que o operador não consegue nomear, etiquetar
   * nem atender direito). Um contato SEM consentimento é inofensivo: o gate de
   * campanha exige `ContactConsent` GRANTED e o pula. É exatamente a coorte
   * INTERAGIU (C1) que o schema já prevê — "relação demonstrável, MAS NÃO É
   * CONSENTIMENTO".
   */
  it('NÃO CASA de número DESCONHECIDO → cria o contato mas NÃO grava consentimento', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    links.matchInbound.mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([inbound('oi, quero saber mais')] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneE164: '+5592987654321' }),
      }),
    );
    // O BUG JURÍDICO que a feature inteira existe para fechar: um inbound
    // qualquer NÃO é manifestação "livre, informada e inequívoca".
    expect(consent.record).not.toHaveBeenCalled();
    // a conversa recém-criada aponta para o contato recém-criado
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ contactId: 'c-novo' }),
      }),
    );
  });

  /**
   * Suprimido (deu PARAR) que escaneia o QR e manda a declaração. NÃO inventamos
   * caminho: o contato é criado, a reidratação repõe o estado revogado da trilha
   * e o ato vai para o `ConsentService.record`, que É quem conhece a precedência
   * do §2.7 (um GRANT posterior ao REVOKE global levanta a supressão — regra 4 —
   * porque este ato vem do WhatsApp do próprio titular, com `wamid` verificável,
   * ao contrário do formulário público, que não prova posse do número).
   *
   * O que este teste trava: o ingest NÃO escreve `ContactConsent`, `optedOut` nem
   * a `SuppressionList` por conta própria. Um segundo caminho de escrita é
   * exatamente como o consentimento fabricado voltaria.
   */
  it('número SUPRIMIDO que manda a declaração → delega ao ConsentService (não escreve estado derivado por fora)', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    consent.rehydrate.mockResolvedValue([]); // a trilha traz o REVOKE global de volta
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-novo', action: ConsentAction.GRANT }),
    );
    // nenhum atalho: o estado derivado é do ConsentService, e só dele
    expect(prisma.contactConsent.upsert).not.toHaveBeenCalled();
    expect(prisma.contactConsent.update).not.toHaveBeenCalled();
    expect(prisma.suppressionList.deleteMany).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('contato JÁ existente → não recria nem reidrata (a reidratação é só do nascimento)', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([{ id: 'c1' }] as never);
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(consent.rehydrate).not.toHaveBeenCalled();
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c1' }),
    );
  });

  /**
   * O QR de um evento é escaneado por muita gente ao mesmo tempo, e a mesma
   * pessoa pode mandar duas mensagens em sequência: duas ingestões correm para
   * criar o mesmo telefone. O `@unique` de `phoneE164` é a fonte da verdade — o
   * perdedor relê a linha em vez de estourar.
   */
  it('corrida na criação (P2002) → relê o contato vencedor e segue com o GRANT', async () => {
    const { svc, wa, consent, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    prisma.contact.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '5',
      }) as never,
    );
    prisma.contact.findUnique.mockResolvedValue({ id: 'c-vencedor' } as never);
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-vencedor' }),
    );
  });

  /** Perder a mensagem da inbox é dano maior que perder um contato que a pessoa refaz. */
  it('falha ao criar o contato NUNCA derruba o ingest — a mensagem entra na inbox', async () => {
    const { svc, wa, links, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    prisma.contact.create.mockRejectedValue(new Error('boom') as never);
    links.matchInbound.mockResolvedValue(LINK);
    wa.parseInboundChatMessages.mockReturnValue([inbound(EXPECTED)] as never);

    // Não rejeita E a mensagem entra na inbox: o ingest devolve a contagem
    // (`{parsed, persisted}`), que é o que torna VISÍVEL o descarte silencioso
    // de um provider sem parser de chat. `toBeUndefined` aqui congelava o
    // retorno `void` antigo, não o comportamento sob teste.
    await expect(svc.ingestFromWebhook({}, "i1")).resolves.toEqual({
      parsed: 1,
      persisted: 1,
    });
    expect(prisma.message.create).toHaveBeenCalled();
  });

  /**
   * Só o INBOUND coleta. Um eco da NOSSA mensagem não é a pessoa falando com o
   * IDASAM — criar contato a partir dele seria o sistema "coletando" de si mesmo.
   */
  it('eco OUTBOUND de número desconhecido → NÃO cria contato', async () => {
    const { svc, wa, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    prisma.message.findUnique.mockResolvedValue(null as never);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound('mensagem nossa', { fromMe: true, providerMessageId: 'SMecho2' }),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  /**
   * Um @lid sem mapeamento não tem telefone real. Criar contato com o LID opaco
   * como se fosse telefone envenenaria a base com um número que não existe.
   */
  it('telefone não resolvido (@lid sem mapeamento) → NÃO cria contato', async () => {
    const { svc, wa, prisma } = make();
    prisma.contact.findMany.mockResolvedValue([] as never);
    prisma.lidPnMap.findUnique.mockResolvedValue(null as never);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound('oi', { remoteJid: '123456@lid', phoneE164: null, altJid: null }),
    ] as never);

    await svc.ingestFromWebhook({}, 'i1');

    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});
