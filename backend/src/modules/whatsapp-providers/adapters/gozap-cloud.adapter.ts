import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../shared/redis/redis.module';
import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../../schemas/contracts/whatsapp.schema';
import type {
  ListConfig,
  ButtonsConfig,
  PollConfig,
  TemplateKind,
} from '../../../schemas/contracts/template.schema';
import type {
  MessageProvider,
  InboundMessageEvent,
  InboundChatMessage,
  SendChatTextArgs,
  CheckClock,
} from '../ports/message-provider.port';
import {
  OPT_IN_BUTTON,
  OPT_OUT_BUTTON,
  isZernioOptInButton,
  isZernioOptOutButton,
  squashButton,
} from '../../../schemas/contracts/consent-button.schema';
import { makeProfile } from '../ports/provider-profile';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import { renderTemplateBody } from '../../../shared/template/render-template-body';
import { WhatsappSendError } from '../errors/whatsapp.errors';
import { classifyGozapError } from './gozap-error-mapper';
import { isSameBrazilianSubscriber } from '../../../shared/phone/br-ninth-digit';

/**
 * Shape dos eventos do GoZap — CAPTURADO DE PRODUÇÃO em 2026-08-07, não mais
 * inferido. A doc do GoZap não documenta o corpo do webhook em lugar nenhum
 * (varredura completa: 284 endpoints do openapi, `llms.txt`, coleção Postman —
 * zero exemplos); o formato abaixo veio de `GOZAP_WEBHOOK_DEBUG` na instância
 * real.
 *
 * A hipótese anterior ("convenções Baileys-like") estava ERRADA em dois níveis:
 * o GoZap é **whatsmeow (Go)**, não Baileys, e o payload é o evento whatsmeow
 * CRU, em PascalCase. Todo campo que este arquivo lia (`data.id`,
 * `data.status`, `data.from`, `data.text`, `data.timestamp`) não existe — por
 * isso 100% dos eventos eram descartados em silêncio.
 *
 * Envelope (as três categorias): `{event, instance_id, data, timestamp}`.
 *
 *  - `messages_update` → whatsmeow `events.Receipt`:
 *      `data.MessageIDs: string[]`, `data.Type`, `data.Timestamp` (ISO-8601),
 *      `data.Chat`/`data.Sender` (JID), `data.IsFromMe`, `data.IsGroup`.
 *    `Type` observado: `''`, `'read'`, `'read-self'`. Em whatsmeow o tipo
 *    VAZIO é o recibo de ENTREGA — não há tipo `'sent'` (o "enviado" é o
 *    retorno do POST, não um evento).
 *
 *  - `messages` → whatsmeow `events.Message`:
 *      `data.Info.{ID, Chat, Sender, SenderAlt, IsFromMe, IsGroup, PushName,
 *      Timestamp (ISO-8601), Type}` + `data.Message.conversation`.
 *
 *  - `connection` → `{status, reason}`; `status` observado: `connected`,
 *    `disconnected`, `syncing`.
 *
 * Segue valendo o contrato DEFENSIVO: campo ausente ou de tipo inesperado
 * resulta em `[]`, nunca em exceção — um webhook que derruba o handler faz o
 * provedor retentar e vira tempestade.
 */
const RECEIPT_STATUS: Record<string, NormalizedEvent['status'] | undefined> = {
  // whatsmeow: tipo vazio == recibo de ENTREGA (o mais comum, e o que o mapa
  // anterior não cobria — ele esperava a string 'delivered', que não existe).
  '': 'delivered',
  delivery: 'delivered',
  read: 'read',
  played: 'read',
  // 'read-self' é a NOSSA própria leitura sincronizada de outro aparelho, não
  // a do destinatário. Tratá-lo como 'read' marcaria a mensagem como lida pelo
  // contato só porque o operador abriu o WhatsApp Web. Deliberadamente ausente.
};

/** `2026-08-07T18:15:09Z` → Date; qualquer outra coisa → undefined. */
function parseIsoTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * JID → E.164, SÓ quando o JID carrega mesmo um telefone.
 *
 * O WhatsApp migrou para endereçamento **LID** (`<id>@lid`), e um LID NÃO é um
 * telefone: os dígitos dele são um identificador opaco. A versão anterior fazia
 * `digitsOnly()` cego e produziria um "telefone" inventado a partir de um LID —
 * que, num sistema que dispara campanha, significa mandar mensagem para um
 * desconhecido. Só aceita o domínio `s.whatsapp.net`.
 */
function jidToE164(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid.includes('@')) return undefined;
  const [user, domain] = jid.split('@');
  if (domain !== 's.whatsapp.net') return undefined;
  const digits = (user.split(':')[0] ?? '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return undefined;
  return `+${digits}`;
}

/**
 * O texto de uma mensagem recebida, em TODAS as formas que o eleitor pode usar
 * para pedir para sair.
 *
 * Ler só `conversation` deixaria a RESPOSTA A BOTÃO cair no vazio — e é o
 * próprio orgamind que envia templates BUTTONS/LIST. O eleitor toca "Parar", o
 * evento chega sem `conversation`, o parser devolve `text: undefined`, e nenhum
 * opt-out é registrado: o disparo seguinte reenviaria para quem revogou. O
 * rótulo do botão (`selectedDisplayText` / `title`) é o que casa com o
 * STOP_REGEX — mesmo caminho que `evolution-api.adapter.ts` já usa.
 */
function extractInboundText(
  msg: Record<string, unknown> | undefined,
): string | undefined {
  if (!msg) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  const nested = (key: string, field: string): string | undefined => {
    const node = msg[key];
    return isRecord(node) ? str(node[field]) : undefined;
  };
  return (
    str(msg.conversation) ??
    nested('extendedTextMessage', 'text') ??
    nested('buttonsResponseMessage', 'selectedDisplayText') ??
    nested('templateButtonReplyMessage', 'selectedDisplayText') ??
    nested('listResponseMessage', 'title')
  );
}

/**
 * O `kind` do chat a partir do `data.Message` do whatsmeow.
 *
 * A ordem importa: `conversation`/`extendedTextMessage` e as respostas
 * interativas são TEXTO; os nós de mídia vêm depois; e o que não conhecemos vira
 * `UNSUPPORTED` — que ainda POUSA na inbox como "Mensagem", em vez de sumir. A
 * lacuna que este arquivo fecha foi exatamente uma mensagem sumindo sem rastro;
 * não se fecha um sumiço com outro.
 */
const MEDIA_KIND: ReadonlyArray<[string, InboundChatMessage['kind']]> = [
  ['imageMessage', 'IMAGE'],
  ['videoMessage', 'VIDEO'],
  ['audioMessage', 'AUDIO'],
  ['ptvMessage', 'VIDEO'],
  ['documentMessage', 'DOCUMENT'],
  ['documentWithCaptionMessage', 'DOCUMENT'],
  ['stickerMessage', 'STICKER'],
  ['locationMessage', 'LOCATION'],
  ['liveLocationMessage', 'LOCATION'],
  ['contactMessage', 'CONTACT'],
  ['contactsArrayMessage', 'CONTACT'],
];

const TEXT_NODES = [
  'conversation',
  'extendedTextMessage',
  'buttonsResponseMessage',
  'templateButtonReplyMessage',
  'listResponseMessage',
  'interactiveResponseMessage',
  'reactionMessage',
];

function inboundKind(
  msg: Record<string, unknown> | undefined,
): InboundChatMessage['kind'] {
  if (!msg) return 'UNSUPPORTED';
  for (const node of TEXT_NODES) {
    if (msg[node] !== undefined && msg[node] !== null) return 'TEXT';
  }
  for (const [node, kind] of MEDIA_KIND) {
    if (isRecord(msg[node])) return kind;
  }
  return 'UNSUPPORTED';
}

/** A legenda de uma mídia — o único texto que uma foto/vídeo carrega. */
function extractCaption(
  msg: Record<string, unknown> | undefined,
): string | undefined {
  if (!msg) return undefined;
  for (const [node] of MEDIA_KIND) {
    const n = msg[node];
    if (!isRecord(n)) continue;
    const caption = n.caption ?? n.fileName ?? n.name;
    if (typeof caption === 'string' && caption.trim()) return caption;
  }
  return undefined;
}

/** O `contextInfo` do nó que o carrega (extendedText, mídia, resposta de botão…). */
function findContextInfo(
  msg: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!msg) return undefined;
  for (const value of Object.values(msg)) {
    if (!isRecord(value)) continue;
    if (isRecord(value.contextInfo)) return value.contextInfo;
  }
  return undefined;
}

/**
 * O BOTÃO TOCADO, canonicalizado — e a ASSIMETRIA deliberada entre aceite e
 * recusa.
 *
 * O opt-in por botão é um dos DOIS atos que gravam consentimento
 * (`chat-ingest` casa `buttonPayload === 'optin_yes'`). Num deploy de campanha
 * eleitoral, um falso positivo aqui produz um `ConsentEvent` append-only
 * afirmando que um eleitor autorizou contato — irreversível. Um falso negativo
 * só perde um clique que a pessoa pode repetir. Daí:
 *
 *  - ACEITE (`optin_yes`): SÓ de resposta a BOTÃO (`buttonsResponseMessage`,
 *    `templateButtonReplyMessage`), e ainda assim pela lista FECHADA do projeto
 *    (`isZernioOptInButton`, igualdade de valor inteiro, com precedência
 *    absoluta do opt-out e trava de negação). Uma linha de LISTA não vira
 *    aceite: `rowId`/`title` são texto que um operador digitou num form, e uma
 *    lista de assuntos com a linha "Quero receber novidades" fabricaria um
 *    GRANT que ninguém deu.
 *  - RECUSA (`optout`): de QUALQUER resposta interativa, inclusive linha de
 *    lista. Suprimir demais é o erro barato; seguir metralhando quem pediu para
 *    parar é o caro.
 *
 * E o guard que sustenta os dois: sem um id/rowId de resposta interativa não há
 * TOQUE nenhum — quem DIGITOU "sim, quero receber" nunca chega aqui.
 */
function inboundButtonPayload(
  msg: Record<string, unknown> | undefined,
): string | undefined {
  if (!msg) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const node = (key: string): Record<string, unknown> | undefined =>
    isRecord(msg[key]) ? msg[key] : undefined;

  const buttons = node('buttonsResponseMessage');
  const template = node('templateButtonReplyMessage');
  const list = node('listResponseMessage');
  const single =
    list && isRecord(list.singleSelectReply)
      ? list.singleSelectReply
      : undefined;

  // Id do TOQUE em botão — o `id` que NÓS mandamos em `/send/button`.
  const buttonId = str(buttons?.selectedButtonId) ?? str(template?.selectedId);
  const buttonLabel =
    str(buttons?.selectedDisplayText) ?? str(template?.selectedDisplayText);
  // Id do TOQUE em linha de lista — o `rowId` que NÓS mandamos em `/send/list`.
  const rowId = str(single?.selectedRowId);
  const rowLabel = str(list?.title);

  const rawId = buttonId ?? rowId;
  // NÃO é toque em nada → nada a canonicalizar. É esta linha que impede alguém
  // que DIGITOU "sim" de virar consentimento. Não enfraquecer.
  if (!rawId) return undefined;

  const label = buttonLabel ?? rowLabel;
  // Recusa PRIMEIRO, sempre: "Não quero receber" contém "quero receber".
  if (
    isZernioOptOutButton(rawId, label, squashButton(rawId), squashButton(label))
  ) {
    return OPT_OUT_BUTTON;
  }
  // Aceite: só o TOQUE EM BOTÃO qualifica (ver o bloco acima).
  if (buttonId && isZernioOptInButton(buttonId, buttonLabel))
    return OPT_IN_BUTTON;
  return rawId;
}

type GozapSendResponse = {
  success?: boolean;
  message?: { id?: string; timestamp?: string; sender?: string };
  error?: string;
};

type GozapErrorBody = { error?: string; message?: string };

/** `+55...` → dígitos puros, sem `+`. GoZap recebe `number` sem o prefixo. */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * O destinatário em DÍGITOS, ou uma recusa FATAL antes de qualquer POST.
 *
 * `digitsOnly()` sozinho é cego: `ChatService.dispatchOutbound` manda
 * `conv.phoneE164 ?? conv.remoteJid`, e um `remoteJid` `@lid`
 * (`123456789012345@lid`) viraria o "telefone" 123456789012345 — um número
 * INVENTADO a partir de um identificador opaco, num sistema que dispara
 * propaganda eleitoral. Aceitamos só o que é telefone de verdade: dígitos
 * puros (com ou sem `+`) ou o JID canônico do telefone
 * (`55…@s.whatsapp.net` / `@c.us`). Qualquer outra coisa morre aqui, como
 * falha VISÍVEL, em vez de virar mensagem para um desconhecido.
 */
function sendableDigits(value: string): string {
  const raw = String(value ?? '').trim();
  const at = raw.indexOf('@');
  const local = at >= 0 ? raw.slice(0, at) : raw;
  const domain = at >= 0 ? raw.slice(at + 1).toLowerCase() : '';
  const digits = digitsOnly(local);
  const domainOk =
    domain === '' || domain === 's.whatsapp.net' || domain === 'c.us';
  // Só pontuação de telefone é tolerada no meio (o `digitsOnly` a limpa); uma
  // letra qualquer já denuncia que aquilo não é um número.
  const shapeOk = /^[+()\-.\s\d]+$/.test(local);
  // 8–15: o mínimo plausível de um assinante com país+DDD e o teto do E.164.
  if (!domainOk || !shapeOk || !/^\d{8,15}$/.test(digits)) {
    throw new WhatsappSendError(
      'Destinatário inválido: o GoZap só envia para telefone (este canal entregou um identificador que não é número).',
      'gozap.invalid_recipient',
      undefined,
      true,
    );
  }
  return digits;
}

/** Type guard estrito: objeto simples, não-array, não-nulo. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ritmo padrão do `/chat/check`: 40 consultas por minuto. */
const DEFAULT_CHECK_RATE_PER_MIN = 40;
/** Cache de EXISTÊNCIA por telefone, no Redis. 24h (spec B.5). */
const CHECK_CACHE_PREFIX = 'gozap:check:';
const CHECK_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** O relógio de verdade — substituído nos testes de ritmo. */
const REAL_CHECK_CLOCK: CheckClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * WhatsApp via GoZap (SaaS não-oficial, sessão por QR — mesma família do
 * Evolution/Baileys, mas hospedado por terceiros em vez de self-host). O
 * provider registry wires it by DI token; `implements MessageProvider` dá
 * verificação estrutural contra o port.
 *
 * Capacidades desta fase: só `campaignSend`. O ciclo de vida da sessão
 * (QR/conexão) vive num service dedicado (F-A Task 7), não em métodos deste
 * adapter — declarar `sessionLifecycle` aqui sem implementá-lo quebraria o
 * contrato "capacidade declarada ⇒ método implementado"
 * (`provider-capability-contract.spec.ts`).
 */
@Injectable()
export class GozapCloudAdapter implements MessageProvider {
  readonly name = 'gozap' as const;
  // `statusPolling`: o GoZap guarda o status de cada mensagem e o expõe em
  // `POST /message/find`. Declarar a capacidade liga o sending-reconciler para
  // canais GOZAP — que é a ÚNICA rede de segurança quando o webhook não chega.
  // Incidente 2026-08-07: o webhook estava armado numa URL interna e 281
  // eventos evaporaram; com polling, os acks teriam se resolvido sozinhos.
  // `inboxChat`: RESPONDER pelo inbox. Antes o `ChatService` roteava tudo que
  // não tivesse janela de sessão para o ramo Evolution, e uma resposta manual
  // num canal GOZAP morria em `ChannelNotEvolutionError` — erro técnico na cara
  // do operador, num canal cujo envio funciona em produção. Declarar a
  // capacidade é também o que abre o compositor da inbox no frontend (ele fecha
  // texto e anexo para todo provider sem `inboxChat`).
  readonly profile = makeProfile(PROVIDER_TRAITS.GOZAP, [
    'campaignSend',
    'statusPolling',
    'inboxChat',
  ]);

  private readonly logger = new Logger(GozapCloudAdapter.name);

  /**
   * Cache do número canônico por destinatário. Sem ele, cada mensagem de uma
   * campanha de 10 mil contatos custaria um `/chat/check` a mais no provedor.
   * 6h: o registro de um número no WhatsApp não muda com frequência.
   */
  private static readonly NUMBER_CACHE_MS = 6 * 60 * 60 * 1000;
  private readonly numberCache = new Map<
    string,
    { number: string; at: number }
  >();
  private readonly http: AxiosInstance;
  private readonly checkRatePerMin: number;
  /**
   * ★ Fix round 1 (I2) — instância, NÃO variável local do método.
   *
   * O adapter é um singleton do Nest (uma instância para TODOS os canais
   * GoZap deste deploy — ver `whatsapp-providers.module.ts`). Um `let` local
   * dentro de `checkNumbersOnWhatsapp` fazia CADA CHAMADA (cada lote)
   * recomeçar o ritmo do zero: duas campanhas validando em sequência
   * disparavam a primeira consulta de cada uma sem esperar, e duas chamadas
   * concorrentes não competiam pelo mesmo relógio. Promovido a campo para o
   * ritmo valer ENTRE lotes.
   *
   * Isto pacea TODOS os canais GoZap juntos (hoje só existe uma instância
   * conectada em produção — [[picoa-gozap-limite-1-instancia]] — então é
   * equivalente a pacear por canal). Se um dia houver múltiplos tokens de
   * instância reais, o limite global aqui só pode ser conservador demais
   * (nunca permissivo demais). Um limitador por-canal, com estado
   * compartilhado entre workers via Redis, é assunto da Task 12.
   */
  private lastCheckCallAt: number | null = null;

  constructor(
    config: ConfigService,
    // `@Optional()` na CAUDA: os specs do adapter (e o contrato de
    // capacidades) o constroem posicionalmente com um ConfigService só, e o
    // cache é acelerador — o método funciona igual sem ele.
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    this.http = axios.create({
      baseURL: config.get<string>('GOZAP_BASE_URL') ?? '',
      headers: { 'Content-Type': 'application/json' },
      // Sem Retry-After documentado; 30s segue o mesmo valor usado pelos
      // outros adapters de sessão/cloud (Zernio, Twilio) — generoso o
      // bastante para não confundir latência normal com timeout, mas sem
      // travar o worker indefinidamente.
      timeout: 30_000,
    });
    const rate = Number(config.get('GOZAP_CHECK_RATE_PER_MIN'));
    this.checkRatePerMin =
      Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CHECK_RATE_PER_MIN;
  }

  /**
   * Envia um template pela instância GoZap identificada por
   * `gozapInstanceToken` (o token da instância, não o admin token de
   * gerência — este último não circula pelo envio). Sem token, falha rápido
   * e FATAL em vez de POSTar algo que o GoZap rejeitaria.
   */
  /**
   * O número REGISTRADO no WhatsApp, resolvido por `POST /chat/check`.
   *
   * INCIDENTE 2026-08-07: enviar o E.164 cru (13 dígitos, com o 9º) para uma
   * conta registrada na forma antiga (12 dígitos) faz o WhatsApp ACEITAR e
   * DESCARTAR em silêncio — `Sent` para sempre, sem erro. Medido no mesmo
   * número: 13 dígitos nunca entregou; 12 dígitos entregou em 15s.
   *
   * Duas travas, porque este caminho decide para QUEM a campanha vai:
   *  - o canônico só é aceito se for o mesmo assinante (`isSameBrazilianSubscriber`);
   *    qualquer outra divergência é ignorada e seguimos com o número original —
   *    entregar para a pessoa errada é pior do que não entregar;
   *  - `IsIn: false` vira erro FATAL, não um envio no vácuo: a linha morre como
   *    falha visível em vez de ficar eternamente "enviada".
   *
   * Falha de rede no `/chat/check` NÃO impede o envio (best-effort): cai para o
   * número original, que é o comportamento anterior.
   */
  private async resolveWhatsappNumber(
    toE164: string,
    token: string,
  ): Promise<string> {
    const original = sendableDigits(toE164);
    const cached = this.numberCache.get(original);
    if (cached && Date.now() - cached.at < GozapCloudAdapter.NUMBER_CACHE_MS) {
      return cached.number;
    }

    let contact: { IsIn?: boolean; PhoneNumber?: string } | undefined;
    try {
      const { data } = await this.http.post<{
        contacts?: Array<{ IsIn?: boolean; PhoneNumber?: string }>;
      }>('/chat/check', { numbers: [original] }, { headers: { token } });
      contact = data?.contacts?.[0];
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'gozap: /chat/check falhou — enviando com o número original',
      );
      return original;
    }

    if (contact?.IsIn === false) {
      throw new WhatsappSendError(
        'Número não está registrado no WhatsApp.',
        'gozap.not_on_whatsapp',
        undefined,
        true,
      );
    }

    const canonical = digitsOnly(
      String(contact?.PhoneNumber ?? '').split('@')[0],
    );
    if (!canonical) return original;
    if (!isSameBrazilianSubscriber(original, canonical)) {
      // Aconteceu de verdade durante a investigação: o `/chat/check` devolveu
      // um número que não era o pedido. Registrar e NÃO usar.
      this.logger.warn(
        'gozap: /chat/check devolveu um número que não é o mesmo assinante — ignorado',
      );
      return original;
    }

    this.numberCache.set(original, { number: canonical, at: Date.now() });
    return canonical;
  }

  /**
   * Fix round 1: o cache agora guarda o CANÔNICO junto do flag — não só
   * `'1'`/`'0'`. Sem isto, um cache-hit reconstruía o `jid` a partir de
   * `number` (a entrada) enquanto o cache-miss original o construía a partir
   * do canônico verificado devolvido pelo GoZap — que pode ser TEXTUALMENTE
   * diferente (9º dígito) mesmo sendo o mesmo assinante. Mesma entrada, dois
   * `jid` diferentes dependendo de já estar em cache ou não.
   */
  private async readCheckCache(
    number: string,
  ): Promise<{ exists: boolean; canonical: string } | null> {
    if (!this.redis) return null;
    try {
      const v = await this.redis.get(`${CHECK_CACHE_PREFIX}${number}`);
      if (v === '0') return { exists: false, canonical: number };
      // `'1'` sem canônico não deveria mais existir (o writer sempre grava
      // `1:<canônico>`), mas é um MISS seguro caso apareça — nunca inventa
      // um canônico que não foi verificado.
      if (v === '1') return { exists: true, canonical: number };
      if (v?.startsWith('1:')) {
        const canonical = v.slice(2);
        return { exists: true, canonical: canonical || number };
      }
      return null;
    } catch {
      // Cache indisponível é MISS, nunca erro: o Redis fora do ar não pode
      // parar uma validação que o operador acabou de pedir.
      return null;
    }
  }

  private async writeCheckCache(
    number: string,
    result: { exists: boolean; canonical?: string },
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const value = result.exists ? `1:${result.canonical ?? number}` : '0';
      await this.redis.set(
        `${CHECK_CACHE_PREFIX}${number}`,
        value,
        'EX',
        CHECK_CACHE_TTL_SECONDS,
      );
    } catch {
      // idem: escrever no cache é otimização, nunca requisito.
    }
  }

  /**
   * Fix round 1 (I1) — classifica falha de TRANSPORTE do `/chat/check`.
   *
   * Diferente de `handleSendError` (que classifica por MENSAGEM enviada — uma
   * falha, tenta a próxima linha da campanha): aqui um 401/403 significa que
   * o TOKEN da instância morreu, e cada número restante do lote ia repetir o
   * mesmo erro. Em vez de continuar gastando ritmo (e o risco de bloqueio)
   * numa consulta fadada a falhar, os dois viram um código PRÓPRIO
   * (`gozap.check_unauthorized`) e FATAL — aborta o lote inteiro de uma vez.
   *
   * Em qualquer ramo, o que sai daqui é um `WhatsappSendError` NOVO,
   * construído só com strings FIXAS (nunca com `err.config`, que carrega o
   * corpo da requisição — os telefones — e o header `token` da instância).
   *
   * Fix round 2 (PII) — DIFERENTE de `handleSendError`, este método NUNCA lê
   * `err.response.data`. O corpo de erro do `/chat/check` é texto livre do
   * GoZap (mesmo formato indocumentado do resto do adapter — ver topo do
   * arquivo), e nada garante que ele não ecoe de volta o número consultado
   * (ex.: "número 5592900000001 inválido"). Reaproveitar
   * `handleSendError` aqui logaria esse corpo (`'gozap send failed'`,
   * `providerMessage`) — a regra "nunca logar telefone" vale também para erro.
   * Por isso a classificação além de 401/403 usa só o STATUS HTTP
   * (`classifyGozapError(status, undefined)`), nunca a mensagem do provedor —
   * o custo é perder a granularidade fina (`gozap.not_connected` etc.) nesse
   * caminho; tudo que não é 401/403 cai em `gozap.unknown`, não-fatal.
   */
  private classifyCheckError(err: unknown): never {
    const e = err as { code?: string; response?: { status?: number } };
    if (!e.response) {
      if (
        e.code === 'ECONNREFUSED' ||
        e.code === 'ENOTFOUND' ||
        e.code === 'EAI_AGAIN'
      ) {
        const cat = classifyGozapError(undefined, undefined, e.code);
        this.logger.warn(
          { code: cat.code, netCode: e.code },
          'gozap /chat/check: inacessível — retentando',
        );
        throw new WhatsappSendError(
          cat.message,
          cat.code,
          undefined,
          cat.fatal,
        );
      }
      this.logger.warn(
        { code: 'gozap.timeout' },
        'gozap /chat/check: timeout ou status indeterminado — retentando',
      );
      throw new WhatsappSendError(
        'Timeout ao consultar o GoZap — status indeterminado.',
        'gozap.timeout',
        undefined,
        false,
      );
    }
    const status = e.response.status;
    if (status === 401 || status === 403) {
      this.logger.error(
        { status, code: 'gozap.check_unauthorized' },
        'gozap /chat/check: token rejeitado — abortando a validação do lote',
      );
      throw new WhatsappSendError(
        'Token da instância GoZap inválido/expirado — validação de números interrompida.',
        'gozap.check_unauthorized',
        undefined,
        true,
      );
    }
    // Fix round 2 (PII): classifica só pelo STATUS — nunca por
    // `e.response.data`, que é texto livre do provedor e pode ecoar o
    // número consultado de volta.
    const cat = classifyGozapError(status, undefined);
    this.logger.warn(
      { status, code: cat.code },
      'gozap /chat/check falhou — retentando',
    );
    throw new WhatsappSendError(cat.message, cat.code, undefined, cat.fatal);
  }

  /**
   * ★ VALIDAÇÃO ATIVA DE NÚMEROS (spec B.5) — lenta de propósito.
   *
   * O `/chat/check` do GoZap aceita UM número por chamada no uso que
   * conhecemos (é o mesmo endpoint que `resolveWhatsappNumber` usa no envio).
   * Não existe modo em lote: 13 mil contatos são 13 mil chamadas, e é por isso
   * que o RITMO é o assunto principal deste método.
   *
   * Consulta de existência em massa por número NÃO-OFICIAL é um sinal
   * conhecido de bloqueio, e este cliente já perdeu números antes
   * ([[picoa-whatsapp-delivery-strategy]]). Defesas:
   *   1. ritmo (`GOZAP_CHECK_RATE_PER_MIN`, padrão 40/min = 1 a cada 1500ms),
   *      pausado num CAMPO DE INSTÂNCIA (`lastCheckCallAt`) — não local do
   *      método — para valer ENTRE chamadas, não só dentro de uma (fix
   *      round 1, I1);
   *   2. cache Redis de 24h por telefone — revalidar quem já foi checado hoje
   *      é risco puro, sem informação nova;
   *   3. o relógio é INJETÁVEL, para que o ritmo possa ser TESTADO (um teste
   *      que dorme de verdade seria desligado no primeiro CI lento, e aí o
   *      ritmo deixaria de ser protegido por alguma coisa).
   *
   * A INTERPRETAÇÃO DA RESPOSTA (fix round 1 — C1 e C2, os dois Critical da
   * revisão) é tri-state, igual a `resolveWhatsappNumber`:
   *   - `IsIn === false` → de fato INVÁLIDO. Cacheia, `exists:false`.
   *   - `IsIn === true` MAS o `PhoneNumber` devolvido é de OUTRO assinante
   *     (`!isSameBrazilianSubscriber`) → NÃO confirma (é a resposta de
   *     ALGUÉM, não da pessoa perguntada — aconteceu de verdade na
   *     investigação do 9º dígito). Não cacheia.
   *
   *     Fix round 2 (design ruling): isto vira `exists: null` (não
   *     `exists:false`) — o único consumidor real hoje
   *     (`contact-sync.processor.ts`) trata QUALQUER `exists` falsy como
   *     "inválido confirmado" e grava `whatsappValid:false` de forma
   *     DURÁVEL. Devolver `false` aqui faria a Task 12 gravar "inválido"
   *     permanente a partir de um "não sei" — pior que o bug original, e
   *     pior que jamais ter checado. `null` = incerto; `reason` continua
   *     preenchido (`gozap.check_mismatch`) para quem quiser distinguir de
   *     um "não sei" por outro motivo.
   *   - qualquer outra coisa (corpo sem `contacts`, `contacts: []`, corpo de
   *     erro do provedor com HTTP 200) → DESCONHECIDO. Nunca vira "não
   *     existe" silencioso (isso gravaria uma mentira durável de 24h no
   *     contato); vira `exists: null` para ESTE número, e o laço CONTINUA
   *     para o próximo.
   *
   *     ★ REVISÃO FINAL DA FASE B — antes, este ramo ENCERRAVA o lote inteiro
   *     (motivo original: um `throw` no meio do laço jogava fora até o já
   *     consultado; o fix seguinte passou a devolver o já consultado, mas
   *     ainda parava e marcava TODO o restante como não confirmado). Como
   *     `findIdsForSync` não tem `orderBy`, o mesmo lote se reformava amanhã
   *     com o número-veneno na MESMA posição — um único número burlado
   *     bastava para nunca validar o resto da página. Agora só aquele número
   *     é marcado, e o resto do lote é consultado normalmente (ver o `for`
   *     abaixo).
   *
   * Erro de REDE/HTTP PROPAGA (via `classifyCheckError`, fix round 1 — I1,
   * PII endurecido no fix round 2) e esse sim ENCERRA o lote: marcar
   * "inválido" a partir de uma falha de transporte gravaria uma mentira
   * durável no contato, e essa mentira o excluiria de campanha para sempre —
   * e martelar um canal fora do ar em vez de parar é só gastar risco à toa.
   */
  async checkNumbersOnWhatsapp(
    phonesE164: string[],
    instanceName?: string,
    opts?: { gozapInstanceToken?: string; clock?: CheckClock },
  ): Promise<
    Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
      reason?: string;
    }>
  > {
    if (phonesE164.length === 0) return [];
    const token = opts?.gozapInstanceToken;
    if (!token) {
      throw new WhatsappSendError(
        'Canal GoZap sem token de instância: não dá para validar números.',
        'gozap.no_token',
        undefined,
        true,
      );
    }
    const clock = opts?.clock ?? REAL_CHECK_CLOCK;
    const minIntervalMs = Math.ceil(60_000 / this.checkRatePerMin);

    const out: Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
      reason?: string;
    }> = [];
    // Fix round 2 (minor): a contagem que acompanha o warn de mismatch —
    // NUNCA o número, só "quantos até agora neste lote".
    let mismatchCount = 0;

    // Laço INDEXADO (não `for..of`): quando o lote encerra no meio (200
    // irreconhecível, abaixo) é preciso saber exatamente QUAIS números ficaram
    // sem resposta para devolvê-los como "não sei" em vez de omiti-los.
    for (let i = 0; i < phonesE164.length; i += 1) {
      const phone = phonesE164[i];
      // Um valor que nem é telefone não pode derrubar o lote inteiro de 50: ele
      // É o caso "número inválido" que esta validação existe para encontrar.
      let number: string;
      try {
        number = sendableDigits(phone);
      } catch {
        out.push({
          exists: false,
          jid: null,
          number: phone.replace(/^\+/, ''),
        });
        continue;
      }

      const cached = await this.readCheckCache(number);
      if (cached !== null) {
        out.push({
          exists: cached.exists,
          jid: cached.exists ? `${cached.canonical}@s.whatsapp.net` : null,
          number,
        });
        continue;
      }

      // Fix round 1 (I2): pausa num CAMPO DE INSTÂNCIA, não numa variável
      // local — o ritmo tem de valer entre chamadas de `checkNumbersOnWhatsapp`
      // (lotes/campanhas diferentes), não só dentro de uma.
      if (this.lastCheckCallAt !== null) {
        const wait = minIntervalMs - (clock.now() - this.lastCheckCallAt);
        if (wait > 0) await clock.sleep(wait);
      }
      this.lastCheckCallAt = clock.now();

      let data:
        | { contacts?: Array<{ IsIn?: boolean; PhoneNumber?: string }> }
        | undefined;
      try {
        const resp = await this.http.post<{
          contacts?: Array<{ IsIn?: boolean; PhoneNumber?: string }>;
        }>('/chat/check', { numbers: [number] }, { headers: { token } });
        data = resp.data;
      } catch (err) {
        this.classifyCheckError(err);
      }

      const contact = data?.contacts?.[0];

      if (contact && contact.IsIn === false) {
        await this.writeCheckCache(number, { exists: false });
        out.push({ exists: false, jid: null, number });
        continue;
      }

      if (contact && contact.IsIn === true) {
        const rawCanonical = digitsOnly(
          String(contact.PhoneNumber ?? '').split('@')[0],
        );
        if (rawCanonical && !isSameBrazilianSubscriber(number, rawCanonical)) {
          // C1 (Critical, fix round 1) + design ruling (fix round 2): o
          // `/chat/check` respondeu, mas com o número de OUTRO assinante — o
          // mesmo tipo de resposta estranha já visto de verdade na
          // investigação do 9º dígito (`resolveWhatsappNumber`, acima). Não
          // confirma, não cacheia, nunca constrói um JID a partir do número
          // estranho, e vira `exists: null` (incerto) — não `false`
          // (inválido confirmado), para não virar uma mentira DURÁVEL no
          // contato quando a Task 12 gravar o resultado.
          mismatchCount += 1;
          this.logger.warn(
            { instanceName, mismatchCount },
            'gozap /chat/check: IsIn:true mas de outro assinante — ignorado (não confirma, não cacheia)',
          );
          out.push({
            exists: null,
            jid: null,
            number,
            reason: 'gozap.check_mismatch',
          });
          continue;
        }
        const canonical = rawCanonical || number;
        await this.writeCheckCache(number, { exists: true, canonical });
        out.push({
          exists: true,
          jid: `${canonical}@s.whatsapp.net`,
          number,
        });
        continue;
      }

      // C2 (Critical, fix round 1): HTTP 200 mas SEM `IsIn` reconhecível
      // (`contacts` ausente/vazio, ou um corpo de erro do provedor). Nunca
      // pode virar `exists:false` — isso gravaria 24h de cache (e, no
      // consumidor, um "inválido" DURÁVEL no contato) a partir de uma
      // resposta que a gente nem entendeu.
      //
      // ★ REVISÃO FINAL DA FASE B (importante) — a versão anterior ENCERRAVA
      // o lote inteiro aqui (motivo original: um `throw` no meio do laço
      // jogava fora até o já consultado). Mas `findIdsForSync` não tem
      // `orderBy`: sem seleção aleatória, o MESMO lote se reforma amanhã com
      // este número-veneno na MESMA posição, e todo mundo depois dele nunca
      // chega a ser consultado de verdade — um único número burlado (HTTP
      // 200, corpo que só ELE produziu) bastava para nunca validar o resto
      // da página, para sempre.
      //
      // Agora só ESTE número vira `exists: null` (não confirmado, nunca
      // "inválido") e o laço CONTINUA para o próximo — ainda pausado pelo
      // ritmo (`lastCheckCallAt`, no topo do laço) e ainda cacheando cada
      // veredito de verdade, número a número. Quem ainda ENCERRA o lote é a
      // falha de TRANSPORTE/auth (`classifyCheckError`, acima) — ali nada
      // daquele número foi checado, e martelar um canal fora do ar É gastar
      // risco à toa; aqui o canal respondeu, só não entendemos a resposta
      // DESTE número específico.
      this.logger.warn(
        { instanceName, consultados: out.length },
        'gozap /chat/check: resposta não reconhecida (sem "IsIn") para um número — marcado como não confirmado, lote continua com os próximos',
      );
      out.push({
        exists: null,
        jid: null,
        number,
        reason: 'gozap.check_unknown_response',
      });
      continue;
    }

    return out;
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const token = input.gozapInstanceToken;
    if (!token) {
      throw new WhatsappSendError(
        'Canal GoZap sem token de instância: configure o token da instância conectada para enviar.',
        'gozap.no_token',
        undefined,
        true,
      );
    }
    const number = await this.resolveWhatsappNumber(input.toE164, token);
    const kind = input.kind ?? 'TEXT';
    const interp = (s: string) => renderTemplateBody(s, input.variables);
    const { path, body } = this.buildRequest(kind, number, input, interp);

    try {
      const { data } = await this.http.post<GozapSendResponse>(path, body, {
        headers: { token },
      });
      const id = data?.message?.id;
      if (!id) {
        throw new WhatsappSendError(
          'GoZap aceitou o envio mas não retornou message.id.',
          'gozap.no_message_id',
          JSON.stringify(data ?? {}).slice(0, 200),
          true,
        );
      }
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) {
      if (err instanceof WhatsappSendError) throw err;
      this.handleSendError(err);
    }
  }

  /**
   * Builders por `TemplateKind` — molde: Evolution (o outro provider
   * Baileys-like desta base) para a forma dos builders, mas o corpo de cada
   * endpoint é o do GoZap (`/send/text`, `/send/list`, `/send/button`,
   * `/send/poll`), não o do Evolution.
   */
  private buildRequest(
    kind: TemplateKind,
    number: string,
    input: SendTemplateInput,
    interp: (s: string) => string,
  ): { path: string; body: Record<string, unknown> } {
    switch (kind) {
      case 'TEXT':
        return {
          path: '/send/text',
          body: { number, text: interp(input.body ?? input.templateName) },
        };
      case 'LIST': {
        const cfg = input.interactiveConfig as ListConfig;
        return {
          path: '/send/list',
          body: {
            number,
            text: interp(cfg.description),
            buttonText: interp(cfg.buttonText),
            footer: cfg.footerText ? interp(cfg.footerText) : undefined,
            sections: cfg.sections.map((s) => ({
              title: interp(s.title),
              rows: s.rows.map((r) => ({
                title: interp(r.title),
                description: r.description ? interp(r.description) : '',
                rowId: r.rowId,
              })),
            })),
          },
        };
      }
      case 'BUTTONS': {
        const cfg = input.interactiveConfig as ButtonsConfig;
        return {
          path: '/send/button',
          body: {
            number,
            text: interp(cfg.description),
            footer: cfg.footerText ? interp(cfg.footerText) : undefined,
            buttons: cfg.buttons.map((b) => ({
              id: b.buttonId,
              text: interp(b.title),
              type: 'reply',
            })),
          },
        };
      }
      case 'POLL': {
        const cfg = input.interactiveConfig as PollConfig;
        return {
          path: '/send/poll',
          body: {
            number,
            name: interp(cfg.question),
            options: cfg.options.map(interp),
            selectableCount: cfg.selectableOptionsCount,
          },
        };
      }
      default:
        throw new WhatsappSendError(
          `Unsupported template kind: ${kind as string}`,
          'gozap.unsupported_kind',
          undefined,
          true,
        );
    }
  }

  /**
   * Classifica a falha de envio. Duas famílias sem resposta HTTP, mais uma
   * com resposta:
   *  - SEM resposta e `e.code` em ECONNREFUSED/ENOTFOUND/EAI_AGAIN: a
   *    conexão NUNCA se estabeleceu — o POST nunca chegou ao GoZap. Sem
   *    ambiguidade: retentar é seguro. Vira `gozap.unreachable` via
   *    `classifyGozapError` (mesmo padrão do `zernio.unreachable`).
   *  - SEM resposta, qualquer outro caso (ECONNABORTED/timeout, ECONNRESET,
   *    socket hang up, DNS instável sem código estável, etc.): a requisição
   *    PARTIU e a resposta se perdeu — status INDETERMINADO. Mesmo padrão do
   *    `twilio.timeout` deste repositório: NUNCA reenviar automaticamente
   *    (reenviar cegamente duplica a mensagem para uma pessoa real). Fica
   *    `fatal: false` (não é recusa definitiva do destinatário), mas o
   *    código `gozap.timeout` é o que a camada de retry usa para NÃO
   *    reagendar — a decisão de reenvio automático fica a jusante.
   *
   *    Distinguir as duas é o que a revisão da Task 5 elevou de Minor: o
   *    processor terminaliza `gozap.timeout` (não reenvia por NENHUM
   *    caminho) — juntar os dois faria uma instabilidade passageira do GoZap
   *    matar a campanha inteira, mesmo quando é certo que o POST nunca saiu.
   *  - COM resposta HTTP: delega a `classifyGozapError` (Task 4) — não
   *    reimplementa a classificação por substring aqui.
   */
  private handleSendError(err: unknown): never {
    const e = err as {
      code?: string;
      response?: { status?: number; data?: GozapErrorBody };
      message?: string;
    };
    if (!e.response) {
      if (
        e.code === 'ECONNREFUSED' ||
        e.code === 'ENOTFOUND' ||
        e.code === 'EAI_AGAIN'
      ) {
        const cat = classifyGozapError(undefined, undefined, e.code);
        this.logger.warn(
          { code: cat.code, netCode: e.code },
          'gozap unreachable — retentando',
        );
        throw new WhatsappSendError(
          cat.message,
          cat.code,
          e.message,
          cat.fatal,
        );
      }
      throw new WhatsappSendError(
        'Timeout ao falar com o GoZap — status indeterminado, não reenviar automaticamente.',
        'gozap.timeout',
        e.message ?? 'network error',
        false,
      );
    }
    const status = e.response.status;
    const providerMessage = e.response.data?.error ?? e.response.data?.message;
    const cat = classifyGozapError(status, providerMessage);
    this.logger.error(
      { status, providerMessage, code: cat.code, fatal: cat.fatal },
      'gozap send failed',
    );
    throw new WhatsappSendError(
      cat.message,
      cat.code,
      providerMessage,
      cat.fatal,
    );
  }

  /**
   * PROVISÓRIO — ver nota no topo do arquivo sobre o formato indocumentado
   * do webhook GoZap. Interpretação assumida: `{event: 'messages_update',
   * data: {id, status, timestamp}}`, `status` textual (Baileys-like) e
   * `timestamp` em segundos Unix. Qualquer desvio desse shape (campo
   * ausente, tipo errado, status desconhecido) faz o evento ser IGNORADO
   * (`[]`), nunca lança.
   */
  /**
   * Status ATUAL de uma mensagem, por `POST /message/find` (campo `status` do
   * registro do GoZap — valores observados: `Sent`, `Read`, `Received`).
   *
   * `Sent` devolve `status: undefined` DE PROPÓSITO: no GoZap ele significa
   * "aceito, ainda não entregue", e é exatamente o estado em que uma mensagem
   * não-entregue fica presa. Devolver `undefined` mantém a linha em SENT e faz
   * o reconciliador voltar depois — nunca inventa uma entrega que não houve.
   */
  async fetchMessageStatus(providerMessageId: string): Promise<{
    status?: NormalizedEvent['status'];
    rawStatus: string;
    errorCode?: string;
  }> {
    const { data } = await this.http.post<{
      messages?: Array<{ status?: string; error?: string }>;
    }>('/message/find', { messageid: providerMessageId, limit: 1 });
    const row = data?.messages?.[0];
    const rawStatus = row?.status ?? '';
    const error = row?.error || undefined;
    const normalized =
      rawStatus.toLowerCase() === 'read'
        ? ('read' as const)
        : rawStatus.toLowerCase() === 'delivered'
          ? ('delivered' as const)
          : error
            ? ('failed' as const)
            : undefined;
    return {
      status: normalized,
      rawStatus,
      ...(error ? { errorCode: error } : {}),
    };
  }

  parseWebhook(payload: unknown): NormalizedEvent[] {
    try {
      if (!isRecord(payload)) return [];
      // Só o recibo carrega status. Um `messages` que caia aqui por engano não
      // pode virar ack (o envelope traz a categoria em `event`).
      if (payload.event !== 'messages_update') return [];
      const data = payload.data;
      if (!isRecord(data)) return [];

      const ids = Array.isArray(data.MessageIDs)
        ? data.MessageIDs.filter(
            (v): v is string => typeof v === 'string' && !!v,
          )
        : [];
      if (ids.length === 0) return [];

      // `Type` ausente e `Type: ''` são a MESMA coisa em whatsmeow: entrega.
      const rawType =
        typeof data.Type === 'string' ? data.Type.toLowerCase() : '';
      const status = RECEIPT_STATUS[rawType];
      if (!status) return []; // 'read-self' e tipos desconhecidos: ignorados

      const occurredAt = parseIsoTimestamp(data.Timestamp) ?? new Date();
      // Um recibo pode referenciar VÁRIAS mensagens de uma vez — o campo é uma
      // lista, e ler só um `id` singular (como antes) perderia o resto do lote.
      return ids.map((providerMessageId) => ({
        providerMessageId,
        status,
        occurredAt,
      }));
    } catch (err) {
      // Nunca deixa um payload hostil derrubar o handler de webhook (o
      // provedor retentaria e viraria tempestade). Loga e trata como
      // "nada para processar".
      this.logger.warn(
        { err },
        'gozap parseWebhook: payload inesperado, ignorado',
      );
      return [];
    }
  }

  /**
   * `messages` → whatsmeow `events.Message` (shape capturado, ver topo).
   *
   * Alimenta o handler de STOP/opt-out, então um falso positivo aqui
   * DESCADASTRA a pessoa errada. Por isso duas recusas explícitas:
   *
   *  - `Info.IsFromMe` → ignora. É o eco das nossas próprias mensagens (e das
   *    que o operador manda pelo celular); tratá-las como recebidas faria o
   *    próprio "PARAR" do template disparar o opt-out do destinatário.
   *  - remetente só em `@lid` → ignora. O LID não é telefone; derivar dígitos
   *    dele (o que o código anterior fazia) suprime um número aleatório.
   */
  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    try {
      if (!isRecord(payload)) return [];
      if (payload.event !== 'messages') return [];
      const data = payload.data;
      if (!isRecord(data)) return [];
      const info = isRecord(data.Info) ? data.Info : undefined;
      if (!info) return [];
      if (info.IsFromMe === true) return [];
      // GRUPO → ignora. Em grupo, `SenderAlt` é o telefone do PARTICIPANTE, e o
      // canal pareado é o aparelho do cliente, cheio de grupos reais. Sem esta
      // linha, qualquer pessoa escrevendo "não" em qualquer grupo casa o
      // STOP_REGEX (`webhooks.service.ts`, que aceita `nao|não` soltos) e o
      // orgamind grava um REVOKE GLOBAL + SuppressionList para um terceiro que
      // nunca pediu nada — um registro jurídico de revogação FABRICADO, num
      // deploy de campanha eleitoral. Opt-out só vale em conversa 1:1.
      if (info.IsGroup === true) return [];

      const id = typeof info.ID === 'string' ? info.ID : undefined;
      // `SenderAlt` é a forma-telefone do remetente numa sessão LID; `Sender`
      // já vem em `@s.whatsapp.net` nas sessões antigas. Nunca inventa.
      const fromE164 = jidToE164(info.SenderAlt) ?? jidToE164(info.Sender);
      if (!id || !fromE164) return [];

      const msg = isRecord(data.Message) ? data.Message : undefined;
      const text = extractInboundText(msg);

      const receivedAt = parseIsoTimestamp(info.Timestamp) ?? new Date();
      return [{ fromE164, text, providerMessageId: id, receivedAt }];
    } catch (err) {
      this.logger.warn(
        { err },
        'gozap parseInboundMessages: payload inesperado, ignorado',
      );
      return [];
    }
  }

  /**
   * ★ `messages` → a mensagem para a INBOX (chat), o elo que faltava.
   *
   * O GoZap CHAMA o nosso webhook em produção — 74 POSTs em 52h, todos 200,
   * autenticados, canal resolvido — e mesmo assim nada aparecia na inbox: este
   * método NÃO EXISTIA. Como `parseInboundChatMessages` é OPCIONAL no port e o
   * roteador faz `?.parseInboundChatMessages?.(payload) ?? []`, toda resposta de
   * eleitor virava lista vazia, sem exceção, sem log, sem contador. E, como os
   * DOIS atos de opt-in (o texto que casa com o link/QR e o toque no botão)
   * moram no `ChatIngestService`, alimentado só por aqui, num canal GoZap a base
   * SÓ PERDIA audiência — o opt-out roda pelo `parseInboundMessages`, que
   * sempre funcionou.
   *
   * O envelope é o MESMO de `parseInboundMessages` (whatsmeow `events.Message`),
   * mas o retorno NÃO dá para reaproveitar: `InboundChatMessage` exige
   * `remoteJid`, `isGroup`, `fromMe` e `kind`, que aquele parser descarta.
   *
   * AS TRÊS RECUSAS, mantidas de propósito (as duas primeiras seguem o mesmo
   * motivo do opt-out; a terceira é ainda mais forte aqui):
   *
   *  - `IsFromMe` → o eco das NOSSAS próprias mensagens. O espelho da campanha
   *    já põe a bolha do disparo na conversa (`mirrorToInbox`), e a resposta
   *    manual do inbox grava a sua própria linha: aceitar o eco só abriria a
   *    porta para uma segunda linha da mesma mensagem.
   *  - GRUPO → o canal pareado é o APARELHO DO CLIENTE, cheio de grupos reais.
   *    Além do ruído na inbox, um "não" dito por qualquer pessoa num grupo já
   *    virou (no caminho do opt-out) uma revogação GLOBAL fabricada para um
   *    terceiro. Conversa de campanha é 1:1.
   *  - remetente só em `@lid` → o LID é um identificador OPACO, não um telefone.
   *    Derivar dígitos dele criaria um Contact com um número inventado numa base
   *    que DISPARA campanha — mandar propaganda eleitoral para um desconhecido.
   *
   * `remoteJid` é o JID CANÔNICO DO TELEFONE, não o `Info.Chat` cru. Não é
   * capricho: `ChatIngestService.persistChatMessage` dá upsert na Conversation
   * pela chave EXATA `[instanceId, remoteJid]`, enquanto o espelho da campanha
   * (`resolveConversationForOutbound`) criou a conversa com o JID do telefone.
   * Em produção o `Info.Chat` do GoZap é um `@lid` — devolvê-lo cru partiria a
   * thread em duas linhas na inbox (a bolha do disparo numa, a resposta na
   * outra). Como só chegamos aqui com telefone resolvido, o JID canônico existe
   * sempre e não há nada de inventado nele.
   *
   * Contrato defensivo do arquivo: campo ausente/tipo errado → `[]`, nunca
   * exceção — um webhook que derruba o handler faz o provedor retentar e vira
   * tempestade.
   */
  parseInboundChatMessages(payload: unknown): InboundChatMessage[] {
    try {
      if (!isRecord(payload)) return [];
      if (payload.event !== 'messages') return [];
      const data = payload.data;
      if (!isRecord(data)) return [];
      const info = isRecord(data.Info) ? data.Info : undefined;
      if (!info) return [];
      if (info.IsFromMe === true) return [];
      if (info.IsGroup === true) return [];

      const id = typeof info.ID === 'string' ? info.ID : undefined;
      const phoneE164 = jidToE164(info.SenderAlt) ?? jidToE164(info.Sender);
      if (!id || !phoneE164) {
        // O ÚNICO DESCARTE QUE O ALARME DO WEBHOOK NÃO ENXERGA.
        //
        // `WebhooksService.warnSilentChatDrop` só grita quando
        // `parseInboundMessages` reconheceu a mensagem — e aquele parser aplica
        // ESTA MESMA recusa, devolvendo `[]` também. Os dois concordam em zero
        // e o alarme cala: a resposta do eleitor evapora com HTTP 200 e nenhum
        // rastro, que é exatamente o incidente que este parser existe para
        // acabar. O WhatsApp está migrando para endereçamento LID; no dia em
        // que o GoZap parar de mandar `SenderAlt`, isso vale para TODA resposta.
        //
        // A recusa continua certa (LID é identificador opaco, derivar telefone
        // dele fabricaria destinatário). O que faltava era deixar rastro — e
        // ele vai SEM PII: nada de telefone, JID, nome de perfil ou texto.
        this.logger.warn(
          {
            instanceId:
              typeof payload.instance_id === 'string'
                ? payload.instance_id
                : undefined,
            reason: !id ? 'sem_id_de_mensagem' : 'remetente_sem_telefone',
            // Só o DOMÍNIO do JID ('lid' / 's.whatsapp.net'), que é o que diz
            // se a causa é a migração para LID. O identificador em si não entra.
            senderDomain:
              typeof info.Sender === 'string'
                ? info.Sender.split('@')[1]
                : undefined,
            hasSenderAlt:
              typeof info.SenderAlt === 'string' && info.SenderAlt.length > 0,
          },
          'gozap: mensagem de entrada DESCARTADA — sem id ou sem telefone do remetente; ela NÃO chega na inbox e nenhum outro alarme a enxerga (se aparecer em massa, o canal parou de mandar SenderAlt e toda resposta de eleitor está se perdendo)',
        );
        return [];
      }

      const msg = isRecord(data.Message) ? data.Message : undefined;
      const kind = inboundKind(msg);
      const buttonPayload = inboundButtonPayload(msg);
      // Texto na ordem de fidelidade: o que a pessoa escreveu (ou o rótulo que
      // ela tocou), depois a legenda da mídia, e por último o id do toque — sem
      // ele uma bolha de botão ficaria em branco na inbox.
      const text =
        extractInboundText(msg) ?? extractCaption(msg) ?? buttonPayload;

      const ctx = findContextInfo(msg);
      const quotedWaMessageId =
        typeof ctx?.stanzaId === 'string' && ctx.stanzaId
          ? ctx.stanzaId
          : undefined;
      const quotedPreview = isRecord(ctx?.quotedMessage)
        ? (extractInboundText(ctx.quotedMessage) ??
          extractCaption(ctx.quotedMessage))
        : undefined;

      return [
        {
          providerMessageId: id,
          remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`,
          phoneE164,
          // O primário JÁ é o JID do telefone, então não há JID alternativo a
          // registrar (`altJid` existe para o caso inverso: primário `@lid`).
          altJid: null,
          isGroup: false,
          fromMe: false,
          pushName:
            typeof info.PushName === 'string' && info.PushName
              ? info.PushName
              : undefined,
          kind,
          text,
          buttonPayload,
          // MÍDIA DE PROPÓSITO AUSENTE. O GoZap não expõe download de mídia por
          // este adapter, e o job de download só sabe buscar por chave do
          // Evolution (`getMediaBase64`) ou por URL autenticada da Twilio.
          // Emitir `media` criaria a MessageMedia e enfileiraria um job
          // condenado: TODA mídia do GoZap nasceria FAILED, com retentativa.
          // O `kind` correto já dá ao operador a bolha honesta ("📷 Imagem") e a
          // legenda; o arquivo, ele abre no aparelho.
          quotedWaMessageId,
          quotedPreview,
          receivedAt: parseIsoTimestamp(info.Timestamp) ?? new Date(),
        },
      ];
    } catch (err) {
      this.logger.warn(
        { err },
        'gozap parseInboundChatMessages: payload inesperado, ignorado',
      );
      return [];
    }
  }

  /**
   * A RESPOSTA MANUAL DO INBOX (texto livre) por um canal GOZAP.
   *
   * Antes, `ChatService.dispatchOutbound` roteava pelo `hasSessionWindow` do
   * provider: TWILIO/ZERNIO pelo registry, e TODO O RESTO no ramo Evolution —
   * que exige `evolutionInstanceName` e estourava `ChannelNotEvolutionError`
   * num canal GoZap. Erro técnico na tela, num canal cujo envio é real e já foi
   * testado com mensagem de verdade em produção.
   *
   * O MESMO `/chat/check` do `sendTemplate`, e pelo MESMO motivo. A 1ª versão
   * deste método pulava a resolução, dizendo que "aqui o destinatário é a
   * conversa que a própria pessoa abriu, então o número já é o registrado".
   * É FALSO para toda conversa nascida do ESPELHO DA CAMPANHA: o espelho passa
   * `message.contact.phoneE164` — o número do CADASTRO, 13 dígitos com o 9º —
   * e é ele que fica gravado em `Conversation.phoneE164`, que é o que
   * `ChatService.dispatchOutbound` entrega aqui. Numa conta registrada com 12
   * dígitos, o WhatsApp ACEITA, devolve `message.id` e DESCARTA em silêncio
   * (incidente 2026-08-07): a bolha vira SENT e o eleitor não recebe nada.
   * Erro visível é ruim; sucesso falso na tela de quem atende eleitor é pior.
   * O custo é uma chamada por destinatário NOVO — `resolveWhatsappNumber` tem
   * cache por número e a trava do `isSameBrazilianSubscriber` contra um
   * "canônico" de outra pessoa.
   *
   * `quotedWaMessageId` é ignorado: o GoZap não documenta campo de citação em
   * `/send/text`. Prefere-se enviar sem a citação a inventar um campo que o
   * provedor descartaria (ou pior, recusaria).
   */
  async sendChatText(args: SendChatTextArgs): Promise<SendResult> {
    const token = args.gozapInstanceToken;
    if (!token) {
      throw new WhatsappSendError(
        'Canal GoZap sem token de instância: configure o token da instância conectada para responder pelo inbox.',
        'gozap.no_token',
        undefined,
        true,
      );
    }
    // FORA do try: a recusa do destinatário e a do `/chat/check` já são
    // `WhatsappSendError` prontas — passar pelo `handleSendError` as
    // reclassificaria como erro de rede.
    const number = await this.resolveWhatsappNumber(args.toE164, token);
    try {
      const { data } = await this.http.post<GozapSendResponse>(
        '/send/text',
        { number, text: args.text },
        { headers: { token } },
      );
      const id = data?.message?.id;
      if (!id) {
        throw new WhatsappSendError(
          'GoZap aceitou o envio mas não retornou message.id.',
          'gozap.no_message_id',
          JSON.stringify(data ?? {}).slice(0, 200),
          true,
        );
      }
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) {
      if (err instanceof WhatsappSendError) throw err;
      this.handleSendError(err);
    }
  }
}
