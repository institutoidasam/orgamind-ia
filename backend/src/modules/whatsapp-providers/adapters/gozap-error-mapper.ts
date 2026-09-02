/**
 * Classifies GoZap (unofficial WhatsApp SaaS) send errors into a stable
 * category so the send pipeline knows whether to (a) fail fast vs. retry, and
 * (b) auto-opt-out the contact. Same purpose as `twilio-error-mapper.ts`, but
 * a DIFFERENT and more fragile input shape.
 *
 * Twilio returns a stable numeric application error code (21211, 63003...)
 * that we key off directly. GoZap does NOT: its docs list "common errors" as
 * free-form prose ("text is required", "Instância desconectada", "Número
 * inválido / não existe no WhatsApp", "quota exceeded"). There is no stable
 * machine-readable code, so we classify by HTTP status + a substring match on
 * the message. This is intrinsically fragile — if GoZap changes their error
 * text, the substring silently stops matching and the error reclassifies to
 * `gozap.unknown` (non-fatal/retryable) instead of whatever it used to be.
 * That's why the `default` branch below is non-fatal and preserves the raw
 * provider message verbatim: every error whose text drifted lands there, and
 * it must fail safe (retry, don't burn the contact) rather than fail loud
 * (mark FAILED/opt-out on a guess).
 *
 * Same "fail safe on doubt" principle governs `MESSAGE_RULES` below: rules
 * are ordered from MOST specific to MOST generic (a narrower, better-signalled
 * state like "instance disconnected" is checked before a broader one like
 * "invalid recipient"), and each regex is anchored to the phrase that
 * actually characterizes the error rather than `.*`-spanning the whole
 * message — a greedy pattern can accidentally match a substring that belongs
 * to a DIFFERENT category (e.g. "not connected to WhatsApp" is a connectivity
 * problem, not an invalid recipient, even though it contains the word
 * "WhatsApp"). Losing a message to the safe default is a smaller cost than
 * misclassifying it as fatal.
 */
export type GozapErrorCategory = {
  /** Stable code stored on Message.errorCode. */
  code: string;
  /** Operator-facing reason in Portuguese. */
  message: string;
  /** true → mark FAILED immediately, skip the BullMQ retries. */
  fatal: boolean;
  /** true → the recipient is unsubscribed/blocked; flag contact.optedOut. */
  optedOut: boolean;
};

type Match = { test: RegExp; code: string; fatal: boolean; message: string };

// O GoZap devolve erro como prosa (docs "Erros comuns"), sem código numérico
// estável — casamos por substring da mensagem, com o status HTTP como
// desempate quando a mensagem não bate com nenhuma regra.
//
// ORDEM IMPORTA: da mais ESPECÍFICA para a mais GENÉRICA. `not_connected` vem
// ANTES de `invalid_recipient` de propósito — "not connected to WhatsApp" é
// um estado de conectividade, mas citaria "whatsapp" e seria roubado pela
// regra de destinatário se ela rodasse primeiro. Revisão anterior pegou essa
// captura indevida (ver testes de regressão no .spec.ts).
const MESSAGE_RULES: Match[] = [
  {
    test: /desconectad|not.*connected|conecte antes|instance.*disconnected/i,
    code: 'gozap.not_connected',
    fatal: false,
    message: 'Instância GoZap desconectada — reconecte o número e reenvie.',
  },
  {
    // Frases ANCORADAS no que caracteriza destinatário inválido — não mais
    // `.*` atravessando a mensagem inteira. `invalid.*number` batia em
    // "invalid number OF PARAMETERS" (erro de payload/template, categoria
    // ERRADA); o lookahead negativo `(?!\s+of\b)` bloqueia especificamente
    // essa captura sem enfraquecer o caso legítimo ("Invalid number").
    // `not...whatsapp` virou a frase fechada "not a whatsapp user" — não
    // colide mais com "not connected to WhatsApp" (regra acima).
    test: /não existe no whatsapp|número inválido|not a whatsapp user|invalid (?:phone )?number\b(?!\s+of\b)/i,
    code: 'gozap.invalid_recipient',
    fatal: true,
    message: 'Número inválido ou sem WhatsApp. Corrija o contato.',
  },
  {
    // "bad request" REMOVIDO: rótulo HTTP genérico demais — um 400 de
    // QUALQUER motivo (inclusive cota) virava "template indisponível" fatal
    // por engano. Sem essa substring, um "Bad Request" cru cai no default
    // seguro (gozap.unknown, não-fatal) e preserva a mensagem do provedor.
    test: /text is required|payload.*inválid|invalid.*payload/i,
    code: 'gozap.invalid_payload',
    fatal: true,
    message:
      'Conteúdo da mensagem rejeitado pelo GoZap. Revise o template/variáveis antes de reenviar.',
  },
  {
    test: /quota exceeded|cota.*excedida|limit reached/i,
    code: 'gozap.quota_exceeded',
    fatal: false,
    message:
      'Cota de instâncias/conexões do GoZap excedida — verifique o plano e retente após liberar.',
  },
];

export function classifyGozapError(
  httpStatus: number | undefined,
  providerMessage: string | undefined,
  /**
   * Código de erro de rede do lado do CLIENTE (Node/axios `err.code`) — só
   * preenchido quando a requisição NUNCA chegou a ter uma resposta HTTP.
   * Canal separado do resto da função de propósito: ao contrário do
   * status/mensagem (que vêm do GoZap), este vem do socket local — não há
   * "mensagem do provedor" nenhuma para casar por substring.
   *
   * Elevado de Minor na revisão da Task 5: em paralelo, o processor passou a
   * TERMINALIZAR mensagens `gozap.timeout` (indeterminadas — o POST pode ter
   * saído — deixam de ser reenviadas por qualquer caminho). Sem esta
   * distinção, ECONNREFUSED/ENOTFOUND/EAI_AGAIN (a conexão NUNCA se
   * estabeleceu, o POST nunca chegou ao GoZap) caíam no mesmo balde do
   * timeout de verdade — e uma instabilidade de minutos no GoZap matava a
   * campanha inteira, mesmo quando reenviar era seguro. Mesmo padrão do
   * `zernio.unreachable`.
   */
  clientNetworkCode?: string,
): GozapErrorCategory {
  if (
    clientNetworkCode === 'ECONNREFUSED' ||
    clientNetworkCode === 'ENOTFOUND' ||
    clientNetworkCode === 'EAI_AGAIN'
  ) {
    return {
      code: 'gozap.unreachable',
      message: `GoZap inacessível (${clientNetworkCode}) — retentando.`,
      fatal: false,
      optedOut: false,
    };
  }
  const msg = providerMessage ?? '';
  for (const rule of MESSAGE_RULES) {
    if (rule.test.test(msg)) {
      return {
        code: rule.code,
        message: rule.message,
        fatal: rule.fatal,
        optedOut: false,
      };
    }
  }
  if (httpStatus === 401) {
    return {
      code: 'gozap.unauthorized',
      message:
        'Token do GoZap ausente ou inválido — refaça a conexão do número.',
      fatal: true,
      optedOut: false,
    };
  }
  if (httpStatus === 403) {
    return {
      code: 'gozap.quota_exceeded',
      message:
        'Cota do GoZap excedida — verifique o plano e retente após liberar.',
      fatal: false,
      optedOut: false,
    };
  }
  // 5xx e desconhecidos: tratamos como transiente e preservamos o detalhe cru
  // do provedor — é para cá que vai todo erro cujo texto mudou do lado deles.
  return {
    code: 'gozap.unknown',
    message:
      msg.trim().length > 0 ? msg : 'Falha desconhecida no envio via GoZap.',
    fatal: false,
    optedOut: false,
  };
}
