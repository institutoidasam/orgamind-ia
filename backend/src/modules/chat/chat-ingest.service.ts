import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { ConsentAction, ConsentSource, MessageDirection, MessageKind, MessageStatus, MediaStatus, Prisma } from '@prisma/client';
import type { ChannelProvider } from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type { InboundChatMessage } from '../whatsapp-providers/ports/message-provider.port';
import { QUEUE_NAMES, type ChatMediaDownloadJob, type BotReplyJob } from '../queue/queue.constants';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import {
  CONVERSATION_OWNER_ORDER,
  conversationOwnerWhere,
  resolveContactByAnyBrForm,
} from './resolve-conversation';

function previewFor(m: InboundChatMessage): string {
  if (m.kind === 'TEXT') return (m.text ?? '').slice(0, 120);
  const label: Record<string, string> = {
    IMAGE: '📷 Imagem', VIDEO: '🎬 Vídeo', AUDIO: '🎤 Áudio', DOCUMENT: '📎 Documento',
    STICKER: '🩹 Figurinha', LOCATION: '📍 Localização', CONTACT: '👤 Contato', UNSUPPORTED: 'Mensagem',
  };
  return m.text ? `${label[m.kind]}: ${m.text}`.slice(0, 120) : label[m.kind] ?? 'Mensagem';
}

/**
 * BACKFILL — mensagens que JÁ ACONTECERAM, lidas da API REST do provedor (o
 * sync do inbox do Zernio), e não um evento ao vivo chegando por webhook.
 *
 * O caminho de persistência é o mesmo; o que muda é tudo que só faz sentido
 * "ao vivo", e cujo efeito colateral num import em massa seria de dano real:
 *
 *  - CONSENTIMENTO: nunca. Um backfill relê ~100 disparos de uma vez; deixar o
 *    reconhecedor de opt-in rodar sobre eles fabricaria consentimento
 *    retroativo em lote — exatamente o bug jurídico (C1) que esta base já
 *    corrigiu. Inbound abre janela, não consente; um inbound IMPORTADO, menos
 *    ainda.
 *  - SUPRIMIDO: não ressuscita. Quem pediu PARAR não volta às listagens do
 *    operador por causa de um import (a SuppressionList é durável e sobrevive
 *    ao Contact, justamente para isso).
 *  - BOT: não dispara. Auto-responder a uma mensagem de dias atrás é pior que
 *    não responder — e um backfill de 100 conversas dispararia 100 respostas.
 *  - AVATAR: não busca no provedor. O sync já traz `participantPicture`, e uma
 *    ida à rede por conversa transformaria o import numa tempestade de chamadas.
 *
 * Monotonicidade: um backfill que encontra uma mensagem ANTIGA que o webhook
 * nunca viu não pode puxar `lastMessageAt`/`lastInboundAt` para trás (a inbox
 * saltaria para o passado e a janela de 24h encolheria). Só avança.
 */
export type IngestOptions = { backfill?: boolean };

/**
 * Até quando, para trás, um clique em botão pode ser atribuído a uma campanha.
 *
 * Não é um prazo de validade do consentimento: é o alcance da BUSCA da mensagem
 * que exibiu o botão. Taps tardios existem (a pessoa rola a conversa dias
 * depois), então a janela é generosa; o que impede a atribuição errada não é o
 * tamanho dela, é a exigência de campanha ÚNICA dentro dela (ver
 * `recordButtonOptIn`). Fechar a janela só evita que uma campanha de anos atrás
 * volte a ser candidata.
 */
const OPT_IN_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class ChatIngestService {
  private readonly logger = new Logger(ChatIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    private readonly events: ChatEventsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD) private readonly mediaQueue: Queue<ChatMediaDownloadJob>,
    @InjectQueue(QUEUE_NAMES.BOT_REPLY) private readonly botQueue: Queue<BotReplyJob>,
    private readonly consent: ConsentService,
    private readonly optInLinks: OptInLinkService,
  ) {}

  /**
   * C3 — o CASAMENTO do inbound com o texto pré-preenchido de um link wa.me/QR
   * (spec §3.1). É o segundo (e último) ato afirmativo que o ingest reconhece
   * como consentimento, ao lado do botão `optin_yes`.
   *
   * A regra inteira em duas linhas:
   *   corpo CASA com o `expectedText` de um OptInLink ativo → GRANT
   *   qualquer outra coisa                                  → só a janela
   *
   * O "qualquer outra coisa" é a correção: era o inbound genérico virando
   * `optInAt` que fabricava consentimento a partir de "quem são vocês?" e de
   * "para de me mandar isso". Aqui, o que autoriza não é o fato de a pessoa ter
   * escrito — é o CONTEÚDO do que ela escreveu, que é a declaração que nomeia o
   * IDASAM e a finalidade, e que chega com um `wamid` verificável na Twilio.
   *
   * `evidenceText` é o texto RECEBIDO, cru — não o `expectedText`. Guardamos os
   * dois: a prova é o que o titular de fato mandou; o esperado é o que ele
   * deveria ter mandado. Se um dia a comparação for questionada, os dois lados
   * dela estão no banco.
   *
   * `source`: CTWA_AD quando o inbound traz o referral de um anúncio (§3.4) —
   * mesmo ato afirmativo, proveniência mais forte (o `ctwaClid` é verificável na
   * Meta) —, WA_LINK caso contrário. Não distinguimos QR_CODE de WA_LINK: o QR
   * carrega EXATAMENTE o mesmo wa.me, e o WhatsApp não nos diz se o titular
   * escaneou ou tocou. Registrar QR_CODE por adivinhação seria inventar
   * evidência; a atribuição real vem do token de origem (um token por cartaz).
   */
  private async recordLinkOptIn(
    m: InboundChatMessage,
    instanceId: string,
    contactId: string,
    phoneE164: string | null,
  ): Promise<void> {
    if (!phoneE164) return;

    const link = await this.optInLinks.matchInbound(m.text);
    if (!link) return; // NÃO CASOU → a janela já foi aberta; nada mais acontece

    const referral = m.referral;
    await this.consent.record({
      contactId,
      phoneE164,
      purposeKey: link.purposeKey,
      action: ConsentAction.GRANT,
      source: referral ? ConsentSource.CTWA_AD : ConsentSource.WA_LINK,
      channelId: instanceId,
      evidenceText: m.text ?? '',
      consentTextVersion: link.consentTextVersion,
      occurredAt: m.receivedAt,
      evidence: {
        inboundWamid: m.providerMessageId,
        text: m.text ?? '',
        expectedText: link.expectedText,
        matched: true,
        originToken: link.token,
        linkId: link.id,
        ...(referral
          ? {
              referralCtwaClid: referral.ctwaClid,
              referralHeadline: referral.headline ?? null,
              referralBody: referral.body ?? null,
              referralSourceId: referral.sourceId ?? null,
              referralSourceUrl: referral.sourceUrl ?? null,
            }
          : {}),
      } as Prisma.InputJsonObject,
    });
  }

  /**
   * Botão "Sim, quero receber" (`optin_yes`) — o ÚNICO ato afirmativo por botão
   * que o ingest reconhece como consentimento (spec §3.5).
   *
   * A finalidade e a prova vêm da OUTBOUND QUE EXIBIU O PEDIDO: `purposeKey` da
   * campanha e `evidenceText` = o corpo RENDERIZADO que a pessoa viu, copiado
   * por valor. Guardar só o nome do template não serve — a Meta permite editar
   * templates, e em 2028 ninguém prova o que foi exibido em 2026.
   *
   * ATRIBUIÇÃO — a parte que o código ANTES não fazia, e que é onde mora a prova
   * falsa. Ele pegava a ÚLTIMA outbound de campanha do contato
   * (`orderBy createdAt desc`) e dela tirava finalidade E prova. Enquanto nenhum
   * tap chegava (o bug do Zernio), isso era inerte. Assim que os taps passam a
   * chegar, vira uma fábrica de prova falsa: taps tardios são comuns — a pessoa
   * rola a conversa e toca no "Sim" da mensagem ANTIGA —, e nesse meio-tempo
   * outra campanha, com outra finalidade, já foi enviada. O GRANT sairia
   * carimbado com a finalidade da campanha B e com o texto de B como "prova",
   * sendo que B nem botão de opt-in tinha. Registro append-only, irreversível,
   * numa campanha eleitoral. É exatamente o que esta feature existe para impedir.
   *
   * Como se atribui agora, em ordem:
   *
   *   1. AMARRAÇÃO EXATA pelo wamid citado. Se o provedor diz a QUAL mensagem o
   *      toque responde (Twilio: `OriginalRepliedMessageSid`), a dúvida acaba —
   *      é aquela outbound, ponto. (Zernio hoje não manda; por isso o passo 2.)
   *
   *   2. CAMPANHA ÚNICA E INEQUÍVOCA. Sem o wamid, o clique só é atribuível se
   *      NÃO HOUVER DÚVIDA sobre qual mensagem o produziu: todas as outbounds de
   *      campanha da janela de atribuição têm que ser da MESMA campanha (mesmo
   *      `campaignId`) e essa campanha precisa ter finalidade. Duas campanhas na
   *      janela = duas mensagens candidatas = não se sabe qual exibiu o botão →
   *      NÃO GRAVA e grita no log.
   *
   * O custo disso é falso-negativo: o titular clicou, o clique não vira registro
   * e ele pode reclicar (ou o operador refaz a colheita). O custo do contrário é
   * uma prova falsa que não se desfaz. Na dúvida: NÃO GRAVAR (regra 1).
   *
   * Sem campanha resolvível não há finalidade, e sem finalidade não há
   * consentimento válido (art. 8º §4º): registramos nada e avisamos. Inventar
   * uma finalidade padrão aqui seria recriar a autorização genérica que esta
   * feature inteira existe para eliminar.
   *
   * I13 — A JANELA É DO TITULAR, NÃO DE UMA LINHA. Enquanto as duas grafias do
   * 9º dígito coexistirem como dois Contact, escopar a busca por UM `contactId`
   * PARTE o conjunto de candidatos ao meio: uma janela que de fato tem duas
   * campanhas pode parecer ter uma só, a guarda "campanha única e inequívoca"
   * passa, e o GRANT sai carimbado com a finalidade e o corpo da campanha
   * ERRADA — exatamente a prova falsa que a guarda existe para impedir. Por
   * isso a varredura é por `twinIds` (todos os gêmeos vivos do titular), e a
   * gravação continua no contato CANÔNICO (`contactId`).
   */
  private async recordButtonOptIn(
    m: InboundChatMessage,
    instanceId: string,
    contactId: string,
    phoneE164: string | null,
    twinIds: string[],
  ): Promise<void> {
    if (!phoneE164) return;
    const ofHolder = { in: twinIds.length ? twinIds : [contactId] };

    const select = {
      id: true,
      providerMessageId: true,
      content: true,
      campaignId: true,
      createdAt: true,
      campaign: {
        select: {
          purposeKey: true,
          template: { select: { metaName: true, twilioContentSid: true } },
        },
      },
    } as const;

    // 1. Amarração EXATA: o toque responde a um wamid conhecido.
    const quoted = m.quotedWaMessageId
      ? await this.prisma.message.findFirst({
          where: {
            contactId: ofHolder,
            instanceId,
            direction: MessageDirection.OUTBOUND,
            campaignId: { not: null },
            providerMessageId: m.quotedWaMessageId,
          },
          select,
        })
      : null;

    // 2. Sem amarração: só atribui se a janela contiver UMA única campanha.
    const since = new Date(m.receivedAt.getTime() - OPT_IN_ATTRIBUTION_WINDOW_MS);
    const candidates = quoted
      ? [quoted]
      : await this.prisma.message.findMany({
          where: {
            contactId: ofHolder,
            instanceId,
            direction: MessageDirection.OUTBOUND,
            campaignId: { not: null },
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select,
        });

    if (candidates.length === 0) {
      this.logger.error(
        { contactId, providerMessageId: m.providerMessageId, sinceISO: since.toISOString() },
        'CLIQUE DE OPT-IN DESCARTADO: nenhuma outbound de campanha na janela de atribuição — não há finalidade nem prova de onde tirar (não se inventa finalidade)',
      );
      return;
    }

    const campaignIds = new Set(candidates.map((c) => c.campaignId));
    if (campaignIds.size > 1) {
      this.logger.error(
        {
          contactId,
          providerMessageId: m.providerMessageId,
          campaignIds: [...campaignIds],
        },
        'CLIQUE DE OPT-IN DESCARTADO: mais de uma campanha na janela — não dá para saber qual mensagem exibiu o botão, e atribuir a errada gravaria prova falsa (append-only, irreversível)',
      );
      return;
    }

    // A outbound-prova: a mais recente da campanha atribuída que tenha corpo
    // renderizado (é ELE que a pessoa viu; sem ele não há prova para guardar).
    const outbound = candidates.find((c) => (c.content ?? '').trim().length > 0);
    const purposeKey = outbound?.campaign?.purposeKey;
    const evidenceText = outbound?.content;
    if (!outbound || !purposeKey || !evidenceText) {
      this.logger.error(
        {
          contactId,
          providerMessageId: m.providerMessageId,
          campaignId: candidates[0].campaignId,
          hasPurposeKey: Boolean(candidates[0].campaign?.purposeKey),
          hasContent: Boolean(candidates[0].content),
        },
        'CLIQUE DE OPT-IN DESCARTADO: campanha sem finalidade (purposeKey) ou outbound sem corpo renderizado — CONFIRA A CAMPANHA ANTES DO DISPARO, todo clique está indo para o lixo',
      );
      return;
    }

    await this.consent.record({
      contactId,
      phoneE164,
      purposeKey,
      action: ConsentAction.GRANT,
      source: ConsentSource.WA_BUTTON,
      channelId: instanceId,
      evidenceText,
      occurredAt: m.receivedAt,
      evidence: {
        inboundWamid: m.providerMessageId,
        outboundWamid: outbound.providerMessageId,
        outboundMessageId: outbound.id,
        campaignId: outbound.campaignId,
        buttonPayload: m.buttonPayload,
        // O RÓTULO CRU que a pessoa tocou. `buttonPayload` chega canonicalizado
        // pelo adapter (é sempre `optin_yes`), então sem isto a prova não diz
        // mais em que botão se clicou — e no Zernio o rótulo é o único sinal que
        // de fato existiu. Guardar os dois: o que o sistema entendeu e o que a
        // pessoa viu.
        buttonLabel: m.text ?? null,
        // COMO a mensagem-prova foi amarrada ao clique. Auditável: quem ler o
        // ConsentEvent daqui a dois anos precisa saber se a prova veio do wamid
        // que o provedor citou ou de a campanha ser a única possível na janela.
        attribution: quoted ? 'reply-wamid' : 'sole-campaign-in-window',
        attributionCandidates: candidates.length,
        templateName: outbound.campaign?.template?.metaName ?? null,
        twilioContentSid: outbound.campaign?.template?.twilioContentSid ?? null,
      } as Prisma.InputJsonObject,
    });
  }

  /**
   * @param provider When given, routes parsing through the channel-aware
   * `parseInboundChatMessagesFor` (resolves the matching adapter from the
   * registry — correct on a multi-provider deploy). Omitted, falls back to
   * the legacy env-selected (`WHATSAPP_PROVIDER`) `parseInboundChatMessages`,
   * which existing Evolution-only callers rely on unchanged.
   */
  async ingestFromWebhook(
    payload: unknown,
    instanceId?: string,
    provider?: ChannelProvider,
  ): Promise<{ parsed: number; persisted: number }> {
    if (!instanceId) return { parsed: 0, persisted: 0 };
    const messages = provider
      ? this.wa.parseInboundChatMessagesFor(provider, payload)
      : this.wa.parseInboundChatMessages(payload);
    const persisted = await this.ingestMessages(messages, instanceId);
    // `parsed` existe para tornar VISÍVEL o modo de falha que custou 70 de 74
    // webhooks reais do GoZap: um adapter sem `parseInboundChatMessages` faz o
    // roteador devolver `[]` — sem exceção, sem log, sem contador — e a
    // resposta do eleitor evapora com HTTP 200. Quem chama compara este número
    // com o que o parser de opt-out enxergou no MESMO payload e grita quando os
    // dois discordam. `persisted` continua sendo o número honesto de linhas
    // novas (duplicata não conta).
    return { parsed: messages.length, persisted };
  }

  /**
   * Ingest de mensagens JÁ PARSEADAS — o MESMO caminho de persistência do
   * webhook (mesma `Conversation`, mesma `Message`, mesma dedupe por
   * `providerMessageId`). É por aqui que o sync do inbox do Zernio traz o que
   * aconteceu FORA do orgamind; um segundo caminho de escrita seria um segundo
   * modelo de conversa, e a inbox deixaria de ser visão única.
   *
   * Devolve quantas mensagens foram DE FATO persistidas — duplicata não conta,
   * que é o que dá ao operador um número honesto ("12 novas") em vez do total
   * relido do provedor.
   */
  async ingestMessages(
    messages: InboundChatMessage[],
    instanceId: string,
    opts: IngestOptions = {},
  ): Promise<number> {
    let persisted = 0;
    for (const m of messages) {
      if (m.isGroup) continue; // 1:1 only
      const ok = m.fromMe
        ? await this.ingestOutboundEcho(m, instanceId, opts)
        : await this.ingestInbound(m, instanceId, opts);
      if (ok) persisted += 1;
    }
    return persisted;
  }

  /**
   * Resolve a message's real phone + display name, harvesting the LID->phone
   * mapping when WhatsApp exposes it. Classic phone JIDs are already real; a
   * @lid resolves via its altJid (persisted to LidPnMap for next time) or a
   * prior mapping, else stays unresolved (null). A pushName equal to the bare
   * LID is not a real name.
   */
  private async resolveContactPhone(
    instanceId: string,
    m: InboundChatMessage,
  ): Promise<{ phoneE164: string | null; name: string | null }> {
    if (!m.remoteJid.endsWith('@lid')) {
      return { phoneE164: m.phoneE164, name: m.pushName ?? null };
    }
    const lidUser = m.remoteJid.split('@')[0];
    const realName = m.pushName && m.pushName !== lidUser ? m.pushName : null;
    if (m.altJid && m.altJid.endsWith('@s.whatsapp.net')) {
      const phone = `+${m.altJid.split('@')[0].replace(/\D/g, '')}`;
      await this.prisma.lidPnMap.upsert({
        where: { instanceId_lid: { instanceId, lid: m.remoteJid } },
        create: { instanceId, lid: m.remoteJid, phoneE164: phone, name: realName },
        update: { phoneE164: phone, ...(realName ? { name: realName } : {}) },
      });
      return { phoneE164: phone, name: realName };
    }
    const map = await this.prisma.lidPnMap.findUnique({
      where: { instanceId_lid: { instanceId, lid: m.remoteJid } },
    });
    return { phoneE164: map?.phoneE164 ?? null, name: realName ?? map?.name ?? null };
  }

  /**
   * Materializa o contato de um inbound cujo telefone não estava na base.
   *
   * `name` é o ProfileName que o WhatsApp mandou — a fonte mais autoritativa do
   * nome de alguém é a própria pessoa, e aqui não há nome do IDASAM a destruir
   * (o contato está NASCENDO).
   *
   * C5.3 — um contato novo não é necessariamente uma PESSOA nova. `ContactConsent`
   * cai por cascata quando o contato é apagado; a trilha (`ConsentEvent`,
   * append-only) sobrevive, porque é chaveada pelo `phoneHash` durável. Quem
   * consentiu, foi excluído numa reimportação e voltou aqui pelo QR renasceria SEM
   * consentimento — e quem tinha dado PARAR renasceria SEM a supressão, que é o
   * lado perigoso. Reidratamos ANTES de qualquer GRANT desta mensagem, para que o
   * `ConsentService` recomponha sobre a história INTEIRA e não sobre um estado
   * derivado pela metade (mesma ordem que a landing pública já usa).
   *
   * Best-effort: uma falha aqui devolve `null` e o ingest segue sem contato —
   * perder a mensagem da inbox é dano maior que perder um contato que a própria
   * pessoa refaz no próximo inbound.
   */
  private async ensureContact(
    phoneE164: string,
    name: string | null,
  ): Promise<{ id: string } | null> {
    try {
      const created = await this.prisma.contact.create({
        data: { phoneE164, name: name ?? null, tags: [] },
        select: { id: true },
      });
      await this.consent.rehydrate(created.id, phoneE164);
      return created;
    } catch (err) {
      // Corrida: o QR de um evento é escaneado por muita gente ao mesmo tempo, e
      // a mesma pessoa manda duas mensagens seguidas. O `@unique` de `phoneE164`
      // é a fonte da verdade — o perdedor apenas relê a linha do vencedor (que já
      // reidratou).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.contact.findUnique({
          where: { phoneE164 },
          select: { id: true },
        });
        if (raced) return raced;
      }
      this.logger.warn({ err }, 'falha ao criar o contato a partir do inbound — a mensagem entra na inbox mesmo assim');
      return null;
    }
  }

  /** @returns true quando a mensagem foi DE FATO gravada (duplicata => false). */
  private async persistChatMessage(
    m: InboundChatMessage,
    instanceId: string,
    opts: { direction: MessageDirection; status: MessageStatus; bumpUnread: boolean; backfill?: boolean },
  ): Promise<boolean> {
    const backfill = opts.backfill === true;
    // Cheap fast-path dedup: short-circuit a recently-seen redelivery WITHOUT
    // touching the DB. The dedup key is only written AFTER the message is
    // persisted (see end of this method), so a crash mid-persist never leaves a
    // key that would silently drop the Evolution redelivery. The authoritative
    // dedup is the providerMessageId @unique constraint below.
    const dedupKey = `chat:inbound:${m.providerMessageId}`;
    if (await this.redis.get(dedupKey)) return false;

    const inst = await this.prisma.channel.findUnique({ where: { id: instanceId }, select: { evolutionInstanceName: true, botId: true } });

    // Resolve the real phone for @lid conversations (harvest the LID->phone
    // mapping when this message carries the alt JID; else reuse a prior mapping;
    // else leave unresolved). Never store the opaque LID as a fake phone.
    const { phoneE164, name } = await this.resolveContactPhone(instanceId, m);
    const isInbound = opts.direction === MessageDirection.INBOUND;

    // I13 — QUEM É O TITULAR, na regra CANÔNICA (a mesma de
    // `ContactsRepository.findByAnyBrForm`, da landing pública e do import).
    //
    // Casar as duas grafias do 9º dígito nunca bastou: enquanto as duas linhas
    // coexistirem, PRECISA haver um desempate, e ele tem de ser o mesmo em todo
    // lugar. O `findFirst` sem `orderBy` que estava aqui devolvia a linha que o
    // ÍNDICE entregasse primeiro — a legada de 12 dígitos —, ou seja, o gêmeo
    // OPOSTO ao que a audiência da campanha e a tela de contatos enxergam. O
    // consentimento (e a revogação) desta mensagem ia parar na linha errada.
    //
    // `twinIds` são TODOS os gêmeos vivos deste titular: quem varre o histórico
    // dele (a janela de atribuição do opt-in por botão) tem de perguntar pelos
    // dois, senão vê metade da janela.
    const resolved = phoneE164
      ? await resolveContactByAnyBrForm(this.prisma, phoneE164)
      : { contact: null, ids: [] as string[] };
    let contact: { id: string } | null = resolved.contact;
    let twinIds = resolved.ids;

    // O KIT DE COLETA TEM DE COLETAR.
    //
    // O ingest só PROCURAVA o contato — nunca o criava. Quem escaneava o QR do
    // cartaz (uma pessoa que, POR DEFINIÇÃO, ainda não está na base) mandava a
    // declaração e… nada. Sem `Contact` não existe `ContactConsent` (a linha é
    // chaveada por `contactId`), e sem `ContactConsent` o gate de campanha pula a
    // pessoa: ela AUTORIZOU e mesmo assim nenhuma campanha a alcançava. O painel
    // marcava `podemReceberHoje: 0` com o cartaz funcionando — o único canal de
    // coleta legítimo da spec (§3.1) não conseguia produzir um destinatário.
    //
    // Todo INBOUND com telefone resolvido agora materializa o contato — não só o
    // que casa com um OptInLink. A DECISÃO para o inbound que NÃO casa:
    //
    //   cria o contato, e NUNCA o consentimento.
    //
    // A conversa já aparece na inbox de qualquer jeito; negar o `Contact` só
    // deixava a base incoerente (uma conversa órfã que o operador não consegue
    // nomear, etiquetar nem atender). Um contato SEM consentimento é inofensivo:
    // o gate exige `ContactConsent` GRANTED e o pula — é exatamente a coorte
    // INTERAGIU (C1) que o schema já prevê ("relação demonstrável, MAS NÃO É
    // CONSENTIMENTO"). O que continua proibido, e é o bug jurídico que esta
    // feature existe para fechar, é gravar CONSENTIMENTO nesse caminho: o
    // consentimento segue vindo só dos dois atos afirmativos abaixo.
    //
    // Sem `phoneE164` (um @lid ainda não mapeado) não se cria nada: guardar o LID
    // opaco como se fosse telefone envenenaria a base com um número inexistente.
    // Ecos OUTBOUND também não coletam — um eco da NOSSA mensagem não é a pessoa
    // falando com o IDASAM.
    //
    // BACKFILL: um import em massa NÃO RESSUSCITA quem pediu PARAR. A supressão
    // é durável e desacoplada do Contact (SuppressionList é chaveada por
    // phoneHash) exatamente para sobreviver a caminhos como este; recriar a
    // linha aqui devolveria a pessoa às listagens e contagens do operador como
    // se a revogação nunca tivesse existido. O webhook AO VIVO não tem esse
    // gate de propósito: receber ≠ enviar, e quem barra o envio é o gate de
    // envio — bloquear a criação lá deixaria a conversa órfã na inbox.
    if (!contact && phoneE164 && isInbound) {
      const suppressed = backfill && (await this.consent.isSuppressed(phoneE164));
      if (!suppressed) {
        contact = await this.ensureContact(phoneE164, name);
        if (contact) twinIds = [contact.id];
      }
    }

    // C1 — INBOUND ABRE JANELA, NUNCA CONSENTIMENTO.
    //
    // O T8 gravava opt-in a partir de QUALQUER inbound de um contato conhecido.
    // Isso fabricava consentimento: quem respondia "não tenho interesse" ou
    // "quem são vocês?" passava a constar no banco como titular que CONSENTIU, e
    // daí em diante passava pelo gate de campanha. A LGPD define consentimento
    // como manifestação "livre, informada e inequívoca... para uma finalidade
    // determinada" (art. 5º XII) e anula as autorizações genéricas (art. 8º §4º)
    // — um inbound não é nenhuma das duas coisas. Pior: o registro seria prova
    // documental, produzida pelo próprio IDASAM, de que o sistema converte
    // qualquer interação (inclusive uma reclamação) em consentimento.
    //
    // O que o inbound faz agora: abre a JANELA de atendimento de 24h
    // (Conversation.lastInboundAt, logo abaixo) — que autoriza RESPONDER, não
    // fazer campanha. O consentimento só vem de ato afirmativo explícito, e
    // existem exatamente DOIS aqui:
    //
    //   1. o botão `optin_yes` dentro da janela (§3.5);
    //   2. o texto que CASA com o pré-preenchido de um link wa.me/QR (§3.1) —
    //      inclusive quando a pessoa chegou por um anúncio CTWA (§3.4).
    //
    // Nada mais. Um inbound que não é nenhum dos dois abre a janela e pronto.
    //
    // Best-effort: uma falha aqui nunca pode derrubar o ingest — perder a
    // mensagem da inbox seria um dano maior que perder um registro de
    // consentimento que o titular pode refazer.
    //
    // BACKFILL nunca chega aqui: reconhecer opt-in sobre ~100 mensagens relidas
    // de uma vez fabricaria consentimento retroativo em lote (ver IngestOptions).
    if (isInbound && contact && !backfill) {
      try {
        if (m.buttonPayload === 'optin_yes') {
          await this.recordButtonOptIn(
            m,
            instanceId,
            contact.id,
            phoneE164,
            twinIds,
          );
        } else {
          // OBSERVABILIDADE — o modo de falha silencioso desta feature.
          //
          // Um BOTÃO foi tocado (o provedor mandou `buttonPayload`), mas ele não
          // é nem `optin_yes` nem `optout`: ou o rótulo do template não está na
          // lista fechada do adapter, ou o provedor devolve o toque num formato
          // que não prevemos (um índice "0"/"1", um id opaco). Nos dois casos o
          // clique não vira NADA — e sem esta linha não viraria nem log. Foi
          // assim que a colheita inteira de opt-in ia para o lixo sem um único
          // aviso. Este warn é o alarme a monitorar na 1ª hora do disparo: se
          // ele aparecer em massa, a colheita está caindo no vazio.
          if (m.buttonPayload && m.buttonPayload !== 'optout') {
            this.logger.warn(
              {
                contactId: contact.id,
                providerMessageId: m.providerMessageId,
                buttonPayload: m.buttonPayload,
                buttonLabel: m.text ?? null,
              },
              'BOTÃO TOCADO NÃO RECONHECIDO: não virou opt-in nem opt-out — se for o botão "Sim, quero receber", o consentimento NÃO está sendo gravado (confira o rótulo do template e o formato do webhook)',
            );
          }
          await this.recordLinkOptIn(m, instanceId, contact.id, phoneE164);
        }
      } catch (err) {
        this.logger.warn({ err, contactId: contact.id }, 'registro de opt-in falhou');
      }
    }

    // Best-effort avatar enrichment: fetch the profile picture URL when the
    // conversation has no picture yet, was never stamped, or the last attempt
    // is older than 24h (U2 — TTL refresh; contacts change their photos).
    // Wrapped in try/catch so errors never block ingest.
    // Backfill não busca avatar: o sync já traz a foto do participante, e uma
    // ida à rede por conversa transformaria o import numa tempestade de chamadas.
    // SÓ EVOLUTION. `wa.fetchProfilePictureUrl` resolve sempre o adapter
    // EVOLUTION e endereça a instância pelo NOME; sem `evolutionInstanceName`
    // (todo canal ZERNIO/TWILIO/GOZAP) a chamada nasce condenada — erro engolido
    // pelo try/catch, log de erro do Evolution poluído a cada conversa nova, e
    // nunca um avatar. Com o inbound do GoZap vivo isto passou a rodar de
    // verdade pela primeira vez.
    // I14 — A CONVERSA DO TITULAR, RESOLVIDA — não a chave fabricada.
    //
    // O upsert abaixo casava por `[instanceId, remoteJid]` EXATO. Na ordem
    // NORMAL de operação do orgamind (dispara primeiro, o eleitor responde depois)
    // isso PARTIA a thread em duas linhas na inbox no canal GoZap: o espelho da
    // campanha criou a conversa com o JID da grafia GRAVADA no Contact (13 díg.,
    // a da planilha) e o WhatsApp reporta a resposta na grafia legada (12 díg.)
    // — chave diferente, conversa nova. O operador via o disparo numa linha e a
    // resposta em outra, com o mesmo contactId nas duas, e nada nunca as juntava
    // (o script de fusão só funde conversas quando funde dois CONTATOS).
    //
    // `resolveConversationForOutbound` já resolvia por variantes; aqui usamos o
    // MESMO critério (`conversationOwnerWhere`) e a mesma ordenação, com o
    // `remoteJid` exato incluído na disjunção — assim a chave única continua
    // sendo sempre candidata e o caso "nenhuma conversa ainda" cai no upsert
    // canônico de antes.
    const owner = await this.prisma.conversation.findFirst({
      where: conversationOwnerWhere({
        instanceId,
        contactId: contact?.id ?? null,
        phoneE164,
        remoteJid: m.remoteJid,
      }),
      orderBy: CONVERSATION_OWNER_ORDER,
      select: {
        id: true,
        remoteJid: true,
        contactId: true,
        profilePicUrl: true,
        profilePicFetchedAt: true,
        lastMessageAt: true,
        lastInboundAt: true,
      },
    });

    let profilePicUrl: string | undefined;
    let profilePicFetchedAt: Date | undefined;
    if (
      phoneE164 &&
      inst?.evolutionInstanceName &&
      m.remoteJid.endsWith('@s.whatsapp.net') &&
      !backfill
    ) {
      try {
        const existing = owner;
        const REFRESH_MS = 24 * 60 * 60 * 1000;
        const due = !existing?.profilePicUrl || !existing?.profilePicFetchedAt ||
          Date.now() - existing.profilePicFetchedAt.getTime() > REFRESH_MS;
        if (due) {
          // Stamp every attempt (success, null, or throw) — this is what
          // throttles private/404 profiles to one attempt per day.
          profilePicFetchedAt = new Date();
          const evolutionName = inst?.evolutionInstanceName ?? undefined;
          const url = await this.wa.fetchProfilePictureUrl(m.remoteJid, evolutionName);
          if (url) profilePicUrl = url;
        }
      } catch {
        // non-fatal; avatar is cosmetic
      }
    }

    // NUNCA ROUBAR A CONVERSA DE OUTRO CONTATO (mesma regra do lado OUTBOUND):
    // quando a linha achada é a da chave exata, o comportamento é o de sempre
    // (ela é, por definição, deste JID); quando ela veio por VARIANTE, só
    // preenchemos o dono se ainda não houver um.
    const mayOwn =
      contact && (!owner || owner.remoteJid === m.remoteJid || !owner.contactId)
        ? contact.id
        : undefined;
    const commonUpdate = {
      phoneE164: phoneE164 ?? undefined,
      waName: name ?? undefined,
      contactId: mayOwn,
      // Only overwrite profilePicUrl with a non-empty URL — a null fetch keeps
      // the cached avatar (same convention as contact-sync applyValidUpdates).
      ...(profilePicUrl ? { profilePicUrl } : {}),
      ...(profilePicFetchedAt ? { profilePicFetchedAt } : {}),
    };
    // lastMessageAt/lastInboundAt vêm junto para o guard de monotonicidade do
    // backfill (uma mensagem antiga não pode puxar a conversa para o passado).
    //
    // Nenhuma conversa do titular ainda: cria a deste JID. `upsert` (e não
    // `create`) porque dois webhooks da mesma pessoa correm juntos aqui.
    const criarADesteJid = () =>
      this.prisma.conversation.upsert({
        where: { instanceId_remoteJid: { instanceId, remoteJid: m.remoteJid } },
        update: commonUpdate,
        create: { instanceId, remoteJid: m.remoteJid, phoneE164, contactId: contact?.id ?? null, waName: name, ...(profilePicUrl ? { profilePicUrl } : {}), ...(profilePicFetchedAt ? { profilePicFetchedAt } : {}) },
        select: { id: true, lastMessageAt: true, lastInboundAt: true },
      });

    let conversation: { id: string; lastMessageAt: Date | null; lastInboundAt: Date | null };
    if (owner) {
      try {
        conversation = await this.prisma.conversation.update({
          where: { id: owner.id },
          data: commonUpdate,
          select: { id: true, lastMessageAt: true, lastInboundAt: true },
        });
      } catch (err) {
        // A conversa sumiu entre a leitura e a escrita. Não é hipotético: o
        // reparo de contatos duplicados (`merge-duplicate-phone-contacts.ts`)
        // APAGA a conversa perdedora, e ele roda a cada deploy — bem enquanto os
        // webhooks continuam chegando. Perder a mensagem da inbox por causa
        // disso seria pior que criar a linha do JID desta mensagem.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2025') throw err;
        conversation = await criarADesteJid();
      }
    } else {
      conversation = await criarADesteJid();
    }

    let message: { id: string; media: { id: string } | null };
    try {
      message = await this.prisma.message.create({
        data: {
          conversationId: conversation.id, instanceId, contactId: contact?.id ?? null,
          direction: opts.direction, kind: m.kind as MessageKind, content: m.text?.slice(0, 65536) ?? null,
          status: opts.status, providerMessageId: m.providerMessageId,
          quotedWaMessageId: m.quotedWaMessageId ?? null, quotedPreview: m.quotedPreview?.slice(0, 4096) ?? null,
          transcript: m.transcript ?? null,
          receivedAt: isInbound ? m.receivedAt : null, sentAt: isInbound ? null : m.receivedAt, createdAt: m.receivedAt,
          ...(m.media && m.kind !== 'TEXT'
            ? { media: { create: { kind: m.kind as MessageKind, status: MediaStatus.PENDING, mimeType: m.media.mimeType ?? null, fileName: m.media.fileName ?? null, sizeBytes: m.media.sizeBytes ?? null, durationSec: m.media.durationSec ?? null, width: m.media.width ?? null, height: m.media.height ?? null } } }
            : {}),
        },
        select: { id: true, media: { select: { id: true } } },
      });
    } catch (err) {
      // providerMessageId @unique is the authoritative dedup: a redelivery that
      // raced past the Redis fast-path collides here. Treat it as a duplicate
      // (record the dedup key, return) rather than crashing the webhook.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        await this.redis.set(dedupKey, '1', 'EX', 72 * 3600);
        return false;
      }
      throw err;
    }

    // Monotonicidade (só o backfill precisa): uma mensagem ANTIGA que o webhook
    // nunca viu não pode puxar o resumo da conversa nem a janela para trás. Ao
    // vivo o evento é sempre o mais novo — nada a comparar.
    const advanceSummary =
      !backfill || !conversation.lastMessageAt || m.receivedAt >= conversation.lastMessageAt;
    const advanceInbound =
      isInbound &&
      (!backfill || !conversation.lastInboundAt || m.receivedAt > conversation.lastInboundAt);

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        ...(advanceSummary
          ? { lastMessageAt: m.receivedAt, lastMessagePreview: previewFor(m), lastMessageDirection: opts.direction }
          : {}),
        // Janela de 24h: todo INBOUND abre/renova a janela (timestamp de
        // recebimento do webhook, nunca Date.now() de processamento). Ecos
        // outbound não contam.
        ...(advanceInbound ? { lastInboundAt: m.receivedAt } : {}),
        ...(opts.bumpUnread ? { unreadCount: { increment: 1 } } : {}),
      },
    });

    await this.events.publish({ type: 'message.created', conversationId: conversation.id, instanceId, messageId: message.id });

    // Auto-resposta: só texto entra aqui; imagem/áudio disparam o bot no fim do
    // download de mídia (quando o arquivo está READY). O processor revalida tudo.
    // Backfill NUNCA dispara o bot: responder automaticamente a uma mensagem de
    // dias atrás é pior que não responder — e um import de 100 conversas soltaria
    // 100 respostas de uma vez sobre pessoas reais.
    if (isInbound && inst?.botId && m.kind === 'TEXT' && !backfill) {
      await this.botQueue.add('reply', { conversationId: conversation.id, messageId: message.id }, { jobId: message.id });
    }

    if (m.media && m.kind !== 'TEXT' && message.media) {
      await this.mediaQueue.add('download', {
        messageMediaId: message.media.id, messageId: message.id, conversationId: conversation.id,
        instanceId, evolutionInstanceName: inst?.evolutionInstanceName ?? '', providerMessageId: m.providerMessageId,
        remoteJid: m.remoteJid, kind: m.kind, mimeType: m.media.mimeType ?? null, fromMe: !isInbound,
        // Twilio: mídia baixada por URL autenticada (MediaUrl0); Evolution não
        // preenche url e continua no caminho por message-key.
        mediaUrl: m.media.url ?? null,
      });
    }

    // Write the dedup key only now — after a fully successful persist — so an
    // earlier failure never blocks the Evolution redelivery from retrying.
    await this.redis.set(dedupKey, '1', 'EX', 72 * 3600);
    return true;
  }

  private async ingestInbound(m: InboundChatMessage, instanceId: string, opts: IngestOptions = {}): Promise<boolean> {
    return this.persistChatMessage(m, instanceId, { direction: MessageDirection.INBOUND, status: MessageStatus.RECEIVED, bumpUnread: true, ...opts });
  }

  private async ingestOutboundEcho(m: InboundChatMessage, instanceId: string, opts: IngestOptions = {}): Promise<boolean> {
    const existing = await this.prisma.message.findUnique({ where: { providerMessageId: m.providerMessageId }, select: { id: true } });
    if (existing) return false; // already persisted by our own send path
    return this.persistChatMessage(m, instanceId, { direction: MessageDirection.OUTBOUND, status: MessageStatus.SENT, bumpUnread: false, ...opts });
  }
}
