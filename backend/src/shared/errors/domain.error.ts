export type DomainErrorOptions = {
  code: string;
  message: string;
  status?: number;
  detail?: string;
  cause?: unknown;
};

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;

  constructor(opts: DomainErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = this.constructor.name;
    this.code = opts.code;
    this.status = opts.status ?? 500;
    this.detail = opts.detail;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, identifier?: string) {
    super({
      code: `${resource.toLowerCase()}.not_found`,
      message: `${resource} not found`,
      status: 404,
      detail: identifier
        ? `No ${resource} with identifier "${identifier}"`
        : undefined,
    });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, code = 'conflict') {
    super({ code, message, status: 409 });
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized', code = 'unauthorized') {
    super({ code, message, status: 401 });
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden', code = 'forbidden') {
    super({ code, message, status: 403 });
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, detail?: string, code = 'validation_failed') {
    super({ code, message, status: 400, detail });
  }
}

export class NotImplementedError extends DomainError {
  /**
   * `feature` is normally a short technical name (e.g. 'getSettings') and the
   * default PT-BR suffix below completes it into a sentence. Call sites that
   * already compose a full PT-BR sentence (e.g. contacts.service's
   * syncBackfill) pass `{ full: true }` so `feature` is used verbatim —
   * otherwise the appended suffix produced a redundant, mixed-language
   * message glued onto an already-complete sentence.
   */
  constructor(feature: string, opts?: { code?: string; full?: boolean }) {
    super({
      code: opts?.code ?? 'not_implemented',
      message: opts?.full
        ? feature
        : `${feature} não é suportado pelo provedor ativo`,
      status: 501,
    });
  }
}

// T6 (twilio-platform): mensagem única da janela de 24h — compartilhada entre
// o guard pré-envio (erro abaixo) e o mapeamento do código 63016 devolvido
// pela Twilio (fallback quando o estado local diverge), para a UI mostrar
// SEMPRE o mesmo texto.
export const TWILIO_WINDOW_CLOSED_MESSAGE =
  'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.';

/**
 * Envio de chat livre num canal TWILIO fora da janela de 24h (ou sem nenhum
 * inbound registrado). Lançado ANTES de chamar a Twilio — evita queimar a
 * requisição num 63016 garantido e dá à UI um erro acionável.
 */
export class TwilioWindowClosedError extends DomainError {
  constructor() {
    super({
      code: 'chat.twilio_window_closed',
      message: TWILIO_WINDOW_CLOSED_MESSAGE,
      status: 409,
    });
  }
}

// Multi-provider channels: Channel.evolutionInstanceName/apiKey are nullable
// (only populated for provider=EVOLUTION). Thrown at Evolution-specific use
// points instead of a non-null assertion when a channel lacks them (e.g. a
// Twilio/Zernio/Meta channel routed into Evolution-only admin/send code).
export class ChannelNotEvolutionError extends DomainError {
  constructor(channelId: string) {
    super({
      code: 'channel.not_evolution',
      message: 'Este canal não está configurado como Evolution',
      status: 409,
      detail: `channelId=${channelId}`,
    });
  }
}
