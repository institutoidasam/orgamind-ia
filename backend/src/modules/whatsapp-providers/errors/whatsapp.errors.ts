import { DomainError } from '../../../shared/errors/domain.error';

export class WhatsappSendError extends DomainError {
  readonly providerErrorCode?: string;
  readonly providerErrorMessage?: string;
  /** When true, the worker should mark the message FAILED immediately and skip retries. */
  readonly fatal: boolean;

  constructor(
    message: string,
    providerErrorCode?: string,
    providerMessage?: string,
    fatal = false,
  ) {
    super({
      code: 'whatsapp.send_failed',
      message,
      status: 502,
      detail: providerErrorCode
        ? `Provider error ${providerErrorCode}: ${providerMessage}`
        : undefined,
    });
    this.providerErrorCode = providerErrorCode;
    this.providerErrorMessage = providerMessage;
    this.fatal = fatal;
  }
}

/**
 * Guard-body for the Twilio adapter (R1): raised when a send has NO resolvable
 * sender — the channel carries neither a phone number (`phoneE164`) nor a
 * Messaging Service SID, AND the env has neither `TWILIO_WHATSAPP_FROM` nor
 * `TWILIO_MESSAGING_SERVICE_SID`. Fatal (non-retryable) so the worker marks the
 * message FAILED immediately instead of POSTing a request with no `From` /
 * `MessagingServiceSid` (which Twilio rejects, or worse, silently mis-sends).
 */
export class TwilioSenderMissingError extends WhatsappSendError {
  constructor() {
    super(
      'Canal Twilio sem remetente: configure um número (phoneE164) ou um Messaging Service SID no canal, ou defina TWILIO_WHATSAPP_FROM / TWILIO_MESSAGING_SERVICE_SID no ambiente.',
      'twilio.sender_missing',
      undefined,
      true, // fatal — não reenviar/retentar
    );
  }
}

export class WhatsappProviderNotConfiguredError extends DomainError {
  constructor(provider: string) {
    super({
      code: 'whatsapp.provider_not_configured',
      message: `Provider ${provider} is not properly configured`,
      status: 503,
    });
  }
}
