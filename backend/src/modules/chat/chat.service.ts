import { Injectable } from '@nestjs/common';
import {
  NotFoundError,
  ChannelNotEvolutionError,
  ConflictError,
  TwilioWindowClosedError,
  TWILIO_WINDOW_CLOSED_MESSAGE,
} from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { toConversationSummary } from './conversation-summary.mapper';
import { SESSION_WINDOW_MS, hasSessionWindow } from './session-window';
import type { ListConversationsQuery, ListMessagesQuery, SendReplyInput } from '../../schemas/contracts/chat.schema';

// How many inbound keys to ack per markMessageAsRead batch. Bounded so a single
// query/request never materializes an unbounded list, while still acking every
// unread message across pages.
const MARK_READ_PAGE_SIZE = 200;

/**
 * Códigos de "fora da janela de 24h" devolvidos pelos provedores cloud: 63016 é
 * o da Twilio; 131047 é o da META (que é o que o Zernio repassa). Ambos mapeiam
 * para a MESMA mensagem PT-BR do guard, para a UI nunca mostrar erro cru em
 * inglês — e o remédio (mandar um template) de fato resolve os dois.
 *
 * 131026 NÃO entra aqui, por mais que o texto da Meta ("Message Undeliverable")
 * sugira. Medição ao vivo registrada em zernio-error-mapper.ts: num broadcast
 * real de 120, 37 falharam e 36 delas foram 131026 — o destinatário DESLIGOU as
 * mensagens de marketing. O remédio é UTILITY, não "mande um template"; dizer
 * "janela fechada" faria o operador disparar template de MARKETING atrás de
 * template contra uma parede, queimando cota e a qualidade de um número cujo
 * display name a Meta já reprovou. Cada mapper (Zernio e Twilio) já tem a sua
 * mensagem para 131026 — deixamos ela passar.
 */
const WINDOW_CLOSED_PROVIDER_CODES = new Set(['63016', '131047']);

/**
 * Falha transitória (429 / 5xx) num canal cloud. O chat NÃO tem reenvio
 * automático — as mensagens dos mappers ("Rate limit do Zernio — retentando.")
 * são escritas para o worker de CAMPANHA, que retenta. Na bolha do inbox elas
 * seriam uma mentira: nada retenta, e o operador vai embora achando que a
 * mensagem saiu. É exatamente o "envio que falha em silêncio" que não podemos
 * ter numa base onde as pessoas que responderam são as mais valiosas.
 */
const CHAT_TRANSIENT_FAILURE_MESSAGE =
  'Não foi possível enviar agora (limite de taxa ou instabilidade do provedor). A mensagem NÃO foi enviada — tente novamente em instantes.';

/**
 * Códigos cujo desfecho é INDETERMINADO: a requisição PARTIU e a resposta se
 * perdeu, então o provedor pode ter aceitado e entregue.
 *
 * Não podem cair em `CHAT_TRANSIENT_FAILURE_MESSAGE`, que afirma "A mensagem
 * NÃO foi enviada" e convida o operador a reenviar. Numa campanha eleitoral, um
 * reenvio sobre um envio que de fato saiu é uma pessoa real recebendo a mesma
 * mensagem duas vezes — e a mentira estaria escrita na bolha, pelo próprio
 * sistema. Aqui a bolha diz a verdade: confira antes de repetir.
 */
const CHAT_INDETERMINATE_CODES = new Set(['gozap.timeout', 'zernio.timeout', 'twilio.timeout']);

const CHAT_INDETERMINATE_MESSAGE =
  'Sem confirmação do provedor: a mensagem PODE ter sido enviada. Confira a conversa no WhatsApp antes de mandar de novo — reenviar pode duplicar.';

/**
 * Recusa CLARA quando o provedor do canal não sabe responder pelo inbox.
 *
 * Antes, um canal assim caía no ramo Evolution e o operador levava
 * "Este canal não está configurado como Evolution" — um erro de implementação
 * vazando para a tela de quem só queria responder uma mensagem.
 */
class ChatProviderNoReplyError extends ConflictError {
  constructor(provider: string) {
    super(
      `O provedor ${provider} deste canal não permite responder pelo inbox. Responda pelo aparelho/painel do provedor, ou use um canal que suporte resposta.`,
      'chat.provider_no_inbox_reply',
    );
  }
}

// The send-conversation row (instance join) as returned by the repo, used by the
// outbound dispatch helper. Derived from the repo so it can never drift.
type OutboundConversation = NonNullable<Awaited<ReturnType<ChatRepository['getConversationForSend']>>>;
// Quoted reply fields after the undefined -> null normalization.
type QuotedFields = { quotedWaMessageId: string | null; quotedPreview: string | null };

@Injectable()
export class ChatService {
  constructor(
    private readonly repo: ChatRepository,
    private readonly events: ChatEventsService,
    private readonly wa: WhatsappProvidersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listConversations(q: ListConversationsQuery, currentUserId: string) {
    // 'me' is resolved here (the repo never sees it) so the filter maps to a
    // concrete assignedUserId equality.
    const resolved = q.assignee === 'me' ? { ...q, assignee: currentUserId } : q;
    return this.repo.listConversations(resolved);
  }

  async listMessages(conversationId: string, q: ListMessagesQuery) {
    // Cheap id-only existence guard — listMessages doesn't need the joined
    // conversation row, so avoid the 3-table-join findConversation here.
    if (!(await this.repo.conversationExists(conversationId))) throw new NotFoundError('Conversation', conversationId);
    return this.repo.listMessages(conversationId, q);
  }

  async getConversation(id: string) {
    const conv = await this.repo.findConversation(id);
    if (!conv) throw new NotFoundError('Conversation', id);
    return toConversationSummary(conv);
  }

  async assignConversation(conversationId: string, userId: string | null, actorUserId: string) {
    const conv = await this.repo.findConversation(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundError('User', userId);
    }
    await this.repo.assignConversation(conversationId, userId);
    // Handoff: atribuir a conversa a um operador pausa o bot (não pausa ao desatribuir).
    if (userId) await this.repo.setBotPaused(conversationId);
    await this.audit.log('conversation.assign', 'Conversation', conversationId, { assignedUserId: userId, assignedBy: actorUserId });
    await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: conv.instanceId });
  }

  async sendReply(conversationId: string, userId: string, input: SendReplyInput) {
    const conv = await this.repo.getConversationForSend(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    // O canal sabe responder? Recusa clara antes de qualquer escrita.
    this.assertChatSendSupported(conv);
    // Janela de 24h (TWILIO/ZERNIO): falha ANTES de criar a mensagem e antes de
    // tocar o provedor — fora da janela um free-form é um 63016/131047
    // garantido, que além de não entregar nada queima cota e qualidade do
    // número.
    this.assertSessionWindowOpen(conv);
    // Normalize the optional quoted fields ONCE (undefined -> null) so the
    // persisted row and the provider call always agree.
    const quoted = {
      quotedWaMessageId: input.quotedWaMessageId ?? null,
      quotedPreview: input.quotedPreview ?? null,
    };
    const messageId = await this.repo.createOutboundMessage({
      conversationId, instanceId: conv.instanceId, contactId: conv.contactId,
      content: input.text, authorUserId: userId, botId: null, ...quoted,
    });
    // Handoff: a resposta manual do operador pausa o bot nesta conversa.
    await this.repo.setBotPaused(conversationId);

    const sent = await this.dispatchOutbound(conv, messageId, input.text, quoted);

    await this.events.publish({ type: 'message.created', conversationId, instanceId: conv.instanceId, messageId });
    if (sent) {
      await this.repo.touchConversationOutbound(conversationId, input.text);
      await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: conv.instanceId });
    }
    const saved = await this.repo.getMessageById(messageId);
    if (!saved) throw new NotFoundError('Message', messageId);
    return saved;
  }

  /**
   * Sends the outbound text to the provider and reconciles the persisted message
   * status. Returns true when the provider accepted it (marked SENT), false when
   * it failed (marked FAILED). Never throws on provider errors — a failed send is
   * a recorded message, not a request failure.
   */
  private async dispatchOutbound(
    conv: OutboundConversation,
    messageId: string,
    text: string,
    quoted: QuotedFields,
  ): Promise<boolean> {
    // Send to the real phone when known, else to the remoteJid JID (works for
    // unresolved @lid — Evolution accepts a full JID in the number field).
    //
    // O FALLBACK NÃO VALE PARA TODO MUNDO. Só o Evolution entende um JID no
    // campo `number`; um adapter cloud faria `digitsOnly()` num `@lid` e
    // mandaria mensagem para um "telefone" INVENTADO a partir de um
    // identificador opaco — propaganda eleitoral para quem ninguém escolheu.
    // Hoje isso é inalcançável (o parser do GoZap só emite mensagem com
    // telefone resolvido, e o espelho da campanha sempre grava `phoneE164`),
    // mas a trava não fica na sorte: o adapter do GoZap RECUSA
    // (`gozap.invalid_recipient`, fatal) o que não for telefone, e é uma bolha
    // FAILED visível — não um envio silencioso para o número errado.
    const recipient = conv.phoneE164 ?? conv.remoteJid;
    // ROTEAMENTO POR CAPACIDADE, não por janela de sessão.
    //
    // Antes o ternário era `hasSessionWindow(provider)`: TWILIO/ZERNIO pelo
    // REGISTRY e TODO O RESTO no ramo Evolution — que exige
    // `evolutionInstanceName` e estoura `ChannelNotEvolutionError`. Foi assim
    // que a resposta por ZERNIO morreu antes, e era assim que a resposta por
    // GOZAP morria agora: um canal cujo ENVIO funciona em produção, testado com
    // mensagem real, devolvia erro técnico ao operador. Janela de 24h é regra
    // da Meta sobre QUANDO se pode responder; não diz nada sobre POR ONDE o
    // texto sai.
    //
    // EVOLUTION continua pelo caminho por `instanceName` (é o único adapter
    // cujo `sendChatText` endereça a instância por nome, e é ele que honra a
    // citação). Todo o resto vai pelo registry, que injeta o remetente/segredo
    // do próprio canal.
    const useRegistry = conv.instance.provider !== 'EVOLUTION';
    try {
      const result = useRegistry
        ? await this.wa.sendChatTextVia(await this.channelForRegistrySend(conv), {
            instanceName: '', toE164: recipient, text, ...quoted,
          })
        : await this.wa.sendChatText({
            instanceName: this.requireEvolutionInstanceName(conv), toE164: recipient, text, ...quoted,
          });
      await this.repo.markChatSent(messageId, conv.instanceId, result.providerMessageId, result.acceptedAt);
      return true;
    } catch (err) {
      // Grava o código CRU do provedor (gozap.timeout, evolution.not_connected…)
      // junto da mensagem já traduzida para PT-BR — sem ele, uma falha relatada
      // pelo operador só era diagnosticável olhando o log da aplicação. Mesma
      // coluna que o caminho de campanha já preenche (ver providerErrorCodeFor).
      await this.repo.markChatFailed(messageId, this.chatFailureMessage(err, useRegistry), this.providerErrorCodeFor(err));
      return false;
    }
  }

  /** O `errorCode` cru do provedor por trás do erro, ou `null` quando o erro não carrega um. */
  private providerErrorCodeFor(err: unknown): string | null {
    return err instanceof WhatsappSendError ? (err.providerErrorCode ?? null) : null;
  }

  /**
   * O canal como o registry precisa vê-lo para o envio de chat.
   *
   * A projeção que o repo devolve (`getConversationForSend`) traz o remetente
   * da Twilio e o accountId do Zernio, mas NÃO o `gozapInstanceToken` — sem ele
   * o adapter do GoZap recusa o envio ("canal sem token de instância"). Em vez
   * de alargar a projeção de toda listagem de conversa, buscamos a coluna
   * SÓ quando o canal é GOZAP: uma consulta a mais por resposta manual num
   * único provider, zero custo para os demais.
   *
   * O que trafega aqui é o CIPHERTEXT do banco; quem decifra (e só em memória,
   * pelo tempo da chamada) é o `WhatsappProvidersService`.
   */
  private async channelForRegistrySend(conv: OutboundConversation) {
    if (conv.instance.provider !== 'GOZAP') return conv.instance;
    const row = await this.prisma.channel.findUnique({
      where: { id: conv.instanceId },
      select: { gozapInstanceToken: true },
    });
    return { ...conv.instance, gozapInstanceToken: row?.gozapInstanceToken ?? null };
  }

  /**
   * O canal SABE responder? Recusa ANTES de criar a mensagem, com texto que o
   * operador entende — em vez de gravar uma bolha FAILED com um erro de
   * implementação ("Este canal não está configurado como Evolution").
   *
   * Fail-closed de propósito: `supportsInboxChatFor` devolve `false` também
   * quando o provider não está configurado neste deploy.
   */
  private assertChatSendSupported(conv: OutboundConversation): void {
    if (!this.wa.supportsInboxChatFor(conv.instance.provider)) {
      throw new ChatProviderNoReplyError(conv.instance.provider);
    }
  }

  /**
   * Guard da janela de atendimento de 24h — canais com janela de sessão da Meta
   * (TWILIO e ZERNIO; ver session-window.ts). Sem inbound registrado, ou com o
   * último inbound além de 24h, o free-form seria rejeitado pela Meta (63016 na
   * Twilio, 131047 no Zernio): falhamos ANTES, com erro PT-BR acionável, em vez
   * de "tentar e ver se dá erro" — o que custaria cota e qualidade do número.
   * EVOLUTION (Baileys) não tem janela e passa reto.
   */
  private assertSessionWindowOpen(conv: OutboundConversation): void {
    if (!hasSessionWindow(conv.instance.provider)) return;
    const last = conv.lastInboundAt?.getTime();
    if (!last || Date.now() - last > SESSION_WINDOW_MS) {
      throw new TwilioWindowClosedError();
    }
  }

  /**
   * Narrow a conversation's Channel to a usable Evolution instance name.
   * Chat sends/reads only support the Evolution provider today — a channel
   * without evolutionInstanceName (Twilio/Zernio/Meta) throws instead of
   * silently using `!` on a now-nullable Prisma field.
   */
  private requireEvolutionInstanceName(conv: OutboundConversation): string {
    if (!conv.instance.evolutionInstanceName) {
      throw new ChannelNotEvolutionError(conv.instanceId);
    }
    return conv.instance.evolutionInstanceName;
  }

  /**
   * Mensagem de falha exibida numa mensagem de chat que ficou FAILED. Chat sends
   * (resposta manual ou do bot) NÃO têm reenvio automático, então a mensagem
   * campanha-orientada do provedor ("reenviando automaticamente") seria enganosa
   * aqui — quando o número está desconectado devolvemos um texto claro e preciso.
   * Para qualquer outro erro mantém-se o comportamento anterior (message crua).
   */
  private chatFailureMessage(err: unknown, isCloudChat = false): string {
    if (
      err instanceof WhatsappSendError &&
      (err.providerErrorCode === 'evolution.not_connected' || err.providerErrorCode === 'evolution.session_closed')
    ) {
      return 'WhatsApp desconectado no momento — reconecte o número em Conectar e envie novamente.';
    }
    // Free-form fora da janela de 24h: 63016 (Twilio) / 131047 (Meta, via
    // Zernio). O guard pré-envio já cobre o caso comum; este é o fallback
    // (corrida com o fechamento da janela ou lastInboundAt divergente) — mesma
    // mensagem do guard, para a UI ser consistente em qualquer provedor.
    if (
      err instanceof WhatsappSendError &&
      err.providerErrorCode !== undefined &&
      WINDOW_CLOSED_PROVIDER_CODES.has(err.providerErrorCode)
    ) {
      return TWILIO_WINDOW_CLOSED_MESSAGE;
    }
    // INDETERMINADO antes de transitório: um timeout de rede não é "não foi
    // enviada", é "não sabemos". Dizer a primeira coisa faria o operador
    // reenviar por cima de uma mensagem que pode ter saído — duplicata numa
    // pessoa real. Este `if` tem de vir ANTES do de falha transitória, porque
    // os códigos de timeout também chegam com `fatal: false`.
    if (
      err instanceof WhatsappSendError &&
      err.providerErrorCode !== undefined &&
      CHAT_INDETERMINATE_CODES.has(err.providerErrorCode)
    ) {
      return CHAT_INDETERMINATE_MESSAGE;
    }
    // Erro transitório (429/5xx) num canal CLOUD: `fatal: false` significa "o
    // worker de campanha vai retentar" — e o texto do mapper diz isso. No chat
    // não há reenvio, então trocamos por uma mensagem honesta e acionável.
    // Só para canais cloud: EVOLUTION não passa pelos mappers com esse
    // contrato e mantém a mensagem crua de sempre (nada regride lá).
    if (isCloudChat && err instanceof WhatsappSendError && !err.fatal) {
      return CHAT_TRANSIENT_FAILURE_MESSAGE;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async markRead(conversationId: string): Promise<void> {
    const conv = await this.repo.getConversationForSend(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    if (conv.unreadCount <= 0) return;
    // Ack EVERY unread inbound on WhatsApp, paging through the conversation so
    // resetting unreadCount to 0 never outruns the messages we actually acked
    // (the old single take:50 left older unread messages unacked upstream).
    // Canal não-Evolution (Twilio/Zernio): não há "mark as read" no provedor —
    // apenas zera o contador local, sem quebrar o inbox com 409.
    if (conv.instance.evolutionInstanceName) {
      let cursor: string | undefined;
      do {
        const { keys, nextCursor } = await this.repo.getUnreadInboundKeys(conversationId, conv.remoteJid, MARK_READ_PAGE_SIZE, cursor);
        if (keys.length > 0) await this.wa.markMessageAsRead(this.requireEvolutionInstanceName(conv), keys);
        cursor = nextCursor ?? undefined;
      } while (cursor);
    }
    await this.repo.resetUnread(conversationId);
    await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: conv.instanceId });
  }

  async sendTyping(conversationId: string, state: 'composing' | 'paused'): Promise<void> {
    const conv = await this.repo.getConversationForSend(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    // Presença é um recurso Evolution/Baileys; no-op nos canais cloud.
    if (!conv.instance.evolutionInstanceName) return;
    await this.wa.sendPresence(this.requireEvolutionInstanceName(conv), conv.phoneE164 ?? conv.remoteJid, state, 3000);
  }

  async pauseBot(conversationId: string): Promise<void> {
    if (!(await this.repo.conversationExists(conversationId))) throw new NotFoundError('Conversation', conversationId);
    await this.repo.setBotPaused(conversationId);
    await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: '' });
  }

  async resumeBot(conversationId: string): Promise<void> {
    if (!(await this.repo.conversationExists(conversationId))) throw new NotFoundError('Conversation', conversationId);
    await this.repo.clearBotPaused(conversationId);
    await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: '' });
  }

  /**
   * Envia uma resposta gerada pelo bot. Espelha sendReply, mas marca a mensagem
   * com botId (não authorUserId) — então NÃO dispara o handoff — e antecede com
   * o indicador "digitando…". Nunca lança em erro de provedor.
   */
  async sendBotReply(conversationId: string, text: string, botId: string): Promise<void> {
    const conv = await this.repo.getConversationForSend(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    const recipient = conv.phoneE164 ?? conv.remoteJid;
    // Humanização: "digitando…" antes de responder (best-effort). Skipped
    // entirely for a non-Evolution channel — no evolutionInstanceName to ping.
    if (conv.instance.evolutionInstanceName) {
      await this.wa.sendPresence(conv.instance.evolutionInstanceName, recipient, 'composing', 1500);
    }
    const messageId = await this.repo.createOutboundMessage({
      conversationId, instanceId: conv.instanceId, contactId: conv.contactId,
      content: text, authorUserId: null, botId, quotedWaMessageId: null, quotedPreview: null,
    });
    // Mesmo roteamento por provider do sendReply (cloud → sendChatTextVia).
    // Sem guard de janela aqui: a resposta do bot segue um inbound imediato
    // (janela recém-aberta); numa corrida rara o 63016/131047 mapeia via
    // chatFailureMessage para a mesma mensagem de janela fechada.
    const sent = await this.dispatchOutbound(conv, messageId, text, { quotedWaMessageId: null, quotedPreview: null });
    await this.events.publish({ type: 'message.created', conversationId, instanceId: conv.instanceId, messageId });
    if (sent) {
      await this.repo.touchConversationOutbound(conversationId, text);
      await this.events.publish({ type: 'conversation.updated', conversationId, instanceId: conv.instanceId });
    }
  }
}
