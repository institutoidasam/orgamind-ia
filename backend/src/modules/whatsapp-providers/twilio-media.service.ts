import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Env } from '../../shared/config/env.schema';
import { DomainError } from '../../shared/errors/domain.error';

// Same buffering cap as the Evolution adapter's media fetch: WhatsApp media is
// capped well under this; beyond it we refuse to buffer the response.
const MAX_MEDIA_RESPONSE_BYTES = 96 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// SSRF/credential-leak guard: the MediaUrl arrives in the WEBHOOK PAYLOAD.
// Basic Auth (AccountSid:AuthToken) may only ever be sent to Twilio's own
// hosts — a forged/tampered payload must not exfiltrate credentials nor
// turn the worker into an internal-network proxy.
const ALLOWED_MEDIA_HOSTS = new Set(['api.twilio.com', 'media.twilio.com']);

/** hostname normalizado (lowercase, sem trailing dot). */
function normalizedHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, '');
}

function assertTwilioMediaUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DomainError({
      code: 'twilio.media_url_invalid',
      message: 'URL de mídia da Twilio inválida — download recusado.',
      status: 400,
    });
  }
  if (u.protocol !== 'https:' || !ALLOWED_MEDIA_HOSTS.has(normalizedHost(u))) {
    throw new DomainError({
      code: 'twilio.media_url_forbidden',
      message:
        'URL de mídia fora do domínio Twilio — download recusado (proteção contra SSRF/vazamento de credenciais).',
      status: 400,
    });
  }
}

/**
 * Downloads inbound WhatsApp media from Twilio (`MediaUrl{N}` of the inbound
 * webhook). The Media resource requires HTTP Basic Auth (AccountSid:AuthToken)
 * and answers with a REDIRECT to the real storage host.
 *
 * We follow that redirect MANUALLY (first hop `maxRedirects: 0`) so the
 * `Authorization` header never reaches the storage host — S3-style signed URLs
 * reject requests that carry BOTH header auth and query-string auth.
 *
 * The result is a raw buffer persisted by the chat-media download pipeline into
 * the SAME store/record (MessageMedia) as Evolution media, so the UI renders it
 * without knowing the provider. The authenticated Twilio URL must NEVER be
 * exposed to the frontend.
 */
@Injectable()
export class TwilioMediaService {
  private readonly logger = new Logger(TwilioMediaService.name);
  private readonly accountSid: string;
  private readonly authToken: string;

  constructor(config: ConfigService<Env>) {
    this.accountSid = config.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    this.authToken = config.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
  }

  async download(
    url: string,
  ): Promise<{ buffer: Buffer; mimeType: string | null }> {
    if (!this.accountSid || !this.authToken) {
      throw new Error(
        'Credenciais da Twilio ausentes (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) — não é possível baixar a mídia.',
      );
    }
    // Só anexamos Basic Auth a hosts da própria Twilio, sempre em https.
    assertTwilioMediaUrl(url);
    // 1º hop: Media resource com Basic Auth; 3xx é esperado (redirect para o
    // storage). validateStatus aceita 2xx/3xx para podermos ler o Location.
    const first = await axios.get(url, {
      auth: { username: this.accountSid, password: this.authToken },
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      maxContentLength: MAX_MEDIA_RESPONSE_BYTES,
      maxBodyLength: MAX_MEDIA_RESPONSE_BYTES,
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    if (first.status < 300) {
      return {
        buffer: Buffer.from(first.data),
        mimeType: contentTypeOf(first.headers),
      };
    }
    const location = headerOf(first.headers, 'location');
    if (!location) {
      throw new Error(
        'Redirect da Twilio sem header Location — não foi possível baixar a mídia.',
      );
    }
    // O storage é uma URL pré-assinada: exigimos https e NUNCA anexamos
    // credenciais no segundo hop (nem o axios as propagaria — a request é
    // montada do zero, sem `auth`).
    let loc: URL;
    try {
      loc = new URL(location);
    } catch {
      throw new DomainError({
        code: 'twilio.media_redirect_invalid',
        message: 'Redirect de mídia da Twilio com Location inválida — download recusado.',
        status: 400,
      });
    }
    if (loc.protocol !== 'https:') {
      throw new DomainError({
        code: 'twilio.media_redirect_forbidden',
        message: 'Redirect de mídia da Twilio para URL não-HTTPS — download recusado.',
        status: 400,
      });
    }
    // 2º hop: storage real (URL assinada) — SEM credenciais; redirects em
    // cadeia são seguidos normalmente aqui.
    const second = await axios.get(location, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      maxContentLength: MAX_MEDIA_RESPONSE_BYTES,
      maxBodyLength: MAX_MEDIA_RESPONSE_BYTES,
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    return {
      buffer: Buffer.from(second.data),
      mimeType: contentTypeOf(second.headers),
    };
  }
}

function headerOf(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function contentTypeOf(headers: Record<string, unknown> | undefined): string | null {
  const raw = headerOf(headers, 'content-type');
  // "image/jpeg; charset=..." → "image/jpeg"
  return raw ? raw.split(';')[0].trim() : null;
}
