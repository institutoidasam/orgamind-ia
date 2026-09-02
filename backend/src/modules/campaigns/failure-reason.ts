import {
  FailureReason,
  type ChannelProvider,
  type Prisma,
} from '@prisma/client';

import {
  MARKETING_UNDELIVERABLE_CODES,
  isPermanentRecipientFailure,
} from './marketing-reachability';

export { FailureReason };

/**
 * F2 — CLASSIFICADOR ÚNICO DE MOTIVO DE FALHA.
 *
 * Hoje `Message.errorCode` mistura TRÊS vocabulários que nada tem em comum
 * entre si:
 *   1. Códigos numéricos da META (Cloud API), repassados tanto pelo adapter
 *      Twilio (`twilio-error-mapper.ts`) quanto pelo Zernio
 *      (`zernio-error-mapper.ts`) — ex.: `131021`, `131026`, `130472`,
 *      `131047`, `131049`, `131050`, `131031`, `132000`-`132016`.
 *   2. Códigos PRÓPRIOS de cada provedor cloud — Twilio (`21xxx`/`63xxx`),
 *      Zernio (`invalid_field_value`, `template_required`,
 *      `linked_account_required`, `account_not_found`, `401`/`403`,
 *      `zernio.timeout`, `zernio.unreachable`, `recipient_opted_out`) e GoZap
 *      (`gozap.invalid_recipient`, `gozap.not_connected`,
 *      `gozap.invalid_payload`, `gozap.quota_exceeded`,
 *      `gozap.unauthorized` — ver `gozap-error-mapper.ts`; classificação por
 *      status HTTP + substring da mensagem, não por código numérico estável).
 *   3. Slugs INTERNOS que o próprio backend grava, sem nenhum provedor
 *      envolvido — `suppressed`, `no_consent`, `campaign_cancelled`,
 *      `enqueue_failed`, `sending_stuck`, `opted_out`,
 *      `antiban.instance_deleted`, `twilio.indeterminate`.
 *
 * `classifyFailure` é o ÚNICO lugar que traduz esse cru para o enum
 * `FailureReason` (fonte da verdade: `schema.prisma`, o comentário de cada
 * variante documenta os mesmos códigos abaixo — mantenha os dois em sincronia).
 * Todo outro código do backend (processor, webhook, repository, filtro,
 * frontend) deve LER o resultado desta função, nunca reclassificar o
 * `errorCode` cru por conta própria.
 *
 * `provider` existe na assinatura para paridade com os outros classificadores
 * do módulo (`classifyTwilioError`/`classifyZernioError`) e para os call-sites
 * do F2/T3, que já têm o provider em mãos. Nenhum código hoje precisa dele
 * para desambiguar (os vocabulários não colidem entre si), mas ele fica
 * disponível para o dia em que precisarem.
 */
export function classifyFailure(
  errorCode: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reservado p/ desambiguação futura entre provedores (nenhum código hoje colide)
  provider?: ChannelProvider,
): FailureReason {
  if (!errorCode) return FailureReason.OUTRO;

  if (SEM_WHATSAPP_CODES.has(errorCode)) return FailureReason.SEM_WHATSAPP;
  if (OPT_OUT_CODES.has(errorCode)) return FailureReason.OPT_OUT;
  // Reusa a constante de marketing-reachability.ts em vez de duplicar
  // '131026'/'130472' aqui — é a MESMA lista, com o MESMO significado.
  if (
    (MARKETING_UNDELIVERABLE_CODES as readonly string[]).includes(errorCode)
  ) {
    return FailureReason.MARKETING_DESLIGADO;
  }
  if (SEM_CONSENTIMENTO_CODES.has(errorCode))
    return FailureReason.SEM_CONSENTIMENTO;
  if (FORA_DA_JANELA_CODES.has(errorCode)) return FailureReason.FORA_DA_JANELA;
  if (LIMITE_DIARIO_CODES.has(errorCode)) return FailureReason.LIMITE_DIARIO;
  if (TELEFONE_INVALIDO_CODES.has(errorCode))
    return FailureReason.TELEFONE_INVALIDO;
  if (TEMPLATE_INDISPONIVEL_CODES.has(errorCode))
    return FailureReason.TEMPLATE_INDISPONIVEL;
  if (CANAL_FORA_CODES.has(errorCode)) return FailureReason.CANAL_FORA;
  if (INDETERMINADO_CODES.has(errorCode)) return FailureReason.INDETERMINADO;

  return FailureReason.OUTRO;
}

// ── Tabela código → motivo ───────────────────────────────────────────────────
// Cada Set abaixo é a fonte de UM ramo de classifyFailure. Mantém 1:1 com o
// comentário da respectiva variante do enum `FailureReason` em schema.prisma.

/** Número não é usuário do WhatsApp (Meta 131021) ou o adapter não achou o
 * destinatário (Twilio 63003, GoZap `gozap.invalid_recipient` — a mensagem
 * de prosa do GoZap mistura "número inválido" com "não existe no WhatsApp";
 * o teste que originou o código descreve o cenário de destinatário
 * inexistente). Nenhuma retentativa conserta. */
const SEM_WHATSAPP_CODES = new Set([
  '131021',
  '63003',
  'gozap.invalid_recipient',
  // Resposta do proprio /chat/check do GoZap (`IsIn: false`) — sem ele a falha
  // aparecia na aba Falhas como "Outro motivo", que nao diz nada ao operador.
  'gozap.not_on_whatsapp',
]);

/**
 * Destinatário optou por sair / bloqueou — vocabulário diverge por provedor
 * E por caminho de escrita dentro do PRÓPRIO backend:
 *   - `131050` — Meta (Twilio e Zernio devolvem o mesmo código numérico).
 *   - `recipient_opted_out` — Zernio, quando o DESTINATÁRIO recusa no ato do
 *     envio (é o que `isPermanentRecipientFailure` reconhece).
 *   - `opted_out` — string DIFERENTE que `send-message.processor.ts` e
 *     `zernio-broadcast-send.service.ts` GRAVAM quando cancelam o envio
 *     porque o contato JÁ estava opted-out (checado ANTES de chamar o
 *     provedor) — mesmo motivo, string diferente da anterior. Ver a mesma
 *     divergência tratada em `isPermanentForContact` abaixo.
 *   - `suppressed` — contato na SuppressionList (gate de consentimento).
 *   - `21610`/`63020`/`63024`/`63032` — Twilio (STOP e variantes de bloqueio
 *     reportadas pela Meta via Twilio).
 */
const OPT_OUT_CODES = new Set([
  '131050',
  'recipient_opted_out',
  'opted_out',
  'suppressed',
  '21610',
  '63020',
  '63024',
  '63032',
]);

/** Gate de consentimento do próprio backend recusou o envio. */
const SEM_CONSENTIMENTO_CODES = new Set(['no_consent']);

/** Fora da janela de 24h de atendimento — precisa de um template aprovado
 * para reabrir a conversa (Meta 131047, Twilio 63016). */
const FORA_DA_JANELA_CODES = new Set(['131047', '63016']);

/** Cap diário de MARKETING do destinatário estourado (Meta 131049, somando
 * todas as empresas). Expira em 24h — por isso não entra na flag durável de
 * marketing-reachability.ts, mas é um FailureReason próprio na Message. */
const LIMITE_DIARIO_CODES = new Set(['131049']);

/** Telefone com formato inválido no cadastro — corrigir o contato, não
 * retentar (Zernio `invalid_field_value`, Twilio 21211/E.164). */
const TELEFONE_INVALIDO_CODES = new Set(['invalid_field_value', '21211']);

/** Template rejeitado, pausado, desativado ou incompatível no provedor —
 * ação no CATÁLOGO, não no destinatário. Meta 132000/132001/132005/132007/
 * 132012/132015/132016 (chegam tanto via Twilio quanto via Zernio), Twilio
 * 63040/63041/63042 (equivalentes Twilio-side), Zernio `template_required`,
 * GoZap `gozap.invalid_payload` (payload/conteúdo rejeitado — "text is
 * required" nas docs do GoZap). */
const TEMPLATE_INDISPONIVEL_CODES = new Set([
  '132000',
  '132001',
  '132005',
  '132007',
  '132012',
  '132015',
  '132016',
  '63040',
  '63041',
  '63042',
  'template_required',
  'gozap.invalid_payload',
]);

/** Canal/conta fora do ar ou desautorizado — nada a ver com o destinatário
 * desta mensagem específica. Slugs internos (`enqueue_failed`,
 * `antiban.instance_deleted`, `campaign_cancelled`,
 * `campaign.default_instance_inactive` — instância padrão da campanha foi
 * soft-deleted e não há outra padrão ativa, ver
 * whatsapp-instance-router.service.ts), Zernio (`401`/`403`
 * credencial/assinatura, `linked_account_required`, `account_not_found`),
 * Meta (`131031` conta/número bloqueado pela Meta), GoZap
 * (`gozap.not_connected` — instância desconectada, `gozap.quota_exceeded` —
 * cota de instâncias/conexões do plano, `gozap.unauthorized` — token
 * ausente/inválido; nenhum dos três é culpa do destinatário desta mensagem). */
const CANAL_FORA_CODES = new Set([
  'enqueue_failed',
  'antiban.instance_deleted',
  'campaign_cancelled',
  'campaign.default_instance_inactive',
  '401',
  '403',
  '131031',
  'linked_account_required',
  'account_not_found',
  'gozap.not_connected',
  'gozap.quota_exceeded',
  'gozap.unauthorized',
]);

/** Falha transitória/ambígua do provedor — não sabemos se entregou (timeout
 * client-side) ou o worker morreu em voo. `sending_stuck` (reconciler).
 * `twilio.indeterminate`/`zernio.indeterminate`/`gozap.indeterminate` são o
 * que o processor GRAVA na Message depois de terminalizar um timeout
 * indeterminado (ver `send-message.processor.ts` — `INDETERMINATE_TIMEOUTS`,
 * a guarda que existia só para a Twilio e foi generalizada para todo
 * provedor); `twilio.timeout`/`zernio.timeout`/`gozap.timeout` são os sinais
 * CRUS do adapter ANTES dessa tradução, mantidos aqui por segurança caso
 * cheguem crus em algum caminho. `zernio.unreachable` é falha de rede do
 * Zernio (sem tradução própria — chega cru mesmo). */
const INDETERMINADO_CODES = new Set([
  'twilio.indeterminate',
  'twilio.timeout',
  'sending_stuck',
  'zernio.timeout',
  'zernio.unreachable',
  'zernio.indeterminate',
  'gozap.timeout',
  'gozap.indeterminate',
]);

/**
 * A MESMA divergência de vocabulário comentada em `OPT_OUT_CODES`, agora para
 * decidir se a falha é DEFINITIVA do destinatário (e portanto vira estado
 * durável no Contact): `isPermanentRecipientFailure` (marketing-reachability.ts)
 * só reconhece `recipient_opted_out` — sem este OR, o caminho MAIS COMUM na
 * prática (contato JÁ suprimido, cancelado com `opted_out` ANTES de tocar o
 * provedor) nunca marcaria `lastFailure*`, mesmo sendo tão definitivo quanto.
 */
function isPermanentForContact(
  errorCode: string | null | undefined,
): errorCode is string {
  return isPermanentRecipientFailure(errorCode) || errorCode === 'opted_out';
}

/**
 * Monta o patch de flag durável do `Contact`, no MOLDE EXATO de
 * `marketing-reachability.ts`: `failureCount` incrementa SEMPRE (é o sinal
 * "este contato dá trabalho", conta toda falha inclusive transitória);
 * `lastFailureReason`/`lastFailureCode`/`lastFailureAt` só entram quando a
 * falha é DEFINITIVA do destinatário — senão um incidente transitório do
 * canal (Zernio fora do ar, timeout) ficaria gravado como se fosse uma
 * característica permanente do contato.
 *
 * Best-effort: quem chama decide se aplica (`contact.update`) e não deixa
 * este patch mudar o desfecho da própria Message.
 */
export function buildContactFailureUpdate(
  errorCode: string | null | undefined,
  provider?: ChannelProvider,
): Prisma.ContactUpdateInput {
  const update: Prisma.ContactUpdateInput = {
    failureCount: { increment: 1 },
  };

  if (isPermanentForContact(errorCode)) {
    update.lastFailureReason = classifyFailure(errorCode, provider);
    update.lastFailureCode = errorCode;
    update.lastFailureAt = new Date();
  }

  return update;
}

/**
 * F2 T7 — rótulo em PT-BR de cada `FailureReason`, para o painel
 * `GET /campaigns/:id/failure-reasons` (o operador lê "Telefone inválido",
 * não o slug do enum). Mantém 1:1 com o comentário de cada variante em
 * `schema.prisma` — se um motivo novo entrar lá, o TS acusa aqui (o tipo é
 * `Record<FailureReason, string>`: falta uma chave não compila).
 */
export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  SEM_WHATSAPP: 'Número não tem WhatsApp',
  OPT_OUT: 'Destinatário optou por sair (opt-out)',
  MARKETING_DESLIGADO: 'Desligou mensagens de marketing',
  SEM_CONSENTIMENTO: 'Sem consentimento para esta finalidade',
  FORA_DA_JANELA: 'Fora da janela de atendimento de 24h',
  LIMITE_DIARIO: 'Limite diário de marketing do destinatário estourado',
  TELEFONE_INVALIDO: 'Telefone inválido',
  TEMPLATE_INDISPONIVEL: 'Template indisponível no provedor',
  CANAL_FORA: 'Canal fora do ar ou desautorizado',
  INDETERMINADO: 'Falha indeterminada — resultado da entrega é desconhecido',
  OUTRO: 'Outro motivo',
};
