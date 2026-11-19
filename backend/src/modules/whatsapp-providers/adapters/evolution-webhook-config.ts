/**
 * Webhook the Evolution instances must POST to, and the pure comparison used
 * to decide whether a live instance still carries it. Kept free of I/O and of
 * logging: divergences are reported as field NAMES only, never as values, so
 * the global `apikey` can never reach a log through this module.
 */

export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
] as const;

/**
 * Flat settings spread into `POST /instance/create` (Evolution 2.3.7 reads
 * them from the top-level body; booleans only count when exactly `true`).
 */
export const EVOLUTION_CREATE_SETTINGS = {
  rejectCall: true,
  groupsIgnore: true,
  alwaysOnline: false,
  readMessages: false,
  readStatus: false,
  syncFullHistory: false,
} as const;

export type ExpectedWebhook = { url: string; apikey: string | undefined };

export type WebhookSetBody = {
  webhook: {
    enabled: true;
    url: string;
    headers?: { apikey: string };
    byEvents: false;
    base64: false;
    events: string[];
  };
};

export type WebhookField = 'enabled' | 'url' | 'events' | 'headers.apikey';

const ALL_FIELDS: WebhookField[] = [
  'enabled',
  'url',
  'events',
  'headers.apikey',
];

/** Body for `POST /webhook/set/{instance}` (nested shape, webhook.schema.ts). */
export function buildWebhookSetBody(expected: ExpectedWebhook): WebhookSetBody {
  return {
    webhook: {
      enabled: true,
      url: expected.url,
      ...(expected.apikey ? { headers: { apikey: expected.apikey } } : {}),
      byEvents: false,
      base64: false,
      events: [...EVOLUTION_WEBHOOK_EVENTS],
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `GET /webhook/find` answers flat or wrapped in `{ webhook }` (plan D5). */
function unwrapWebhook(found: unknown): Record<string, unknown> | null {
  if (!isRecord(found)) return null;
  return isRecord(found.webhook) ? found.webhook : found;
}

/** `headers` may arrive as an object or as a JSON string; junk reads as absent. */
function readHeaderApikey(headers: unknown): string | undefined {
  let parsed = headers;
  if (typeof headers === 'string') {
    try {
      parsed = JSON.parse(headers);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.apikey === 'string' ? parsed.apikey : undefined;
}

function sameEventSet(found: unknown): boolean {
  if (!Array.isArray(found)) return false;
  const have = new Set(found);
  return (
    have.size === EVOLUTION_WEBHOOK_EVENTS.length &&
    EVOLUTION_WEBHOOK_EVENTS.every((e) => have.has(e))
  );
}

/** Which of the expected webhook's fields the live `find` answer disagrees on. */
export function webhookDivergences(
  found: unknown,
  expected: ExpectedWebhook,
): WebhookField[] {
  const hook = unwrapWebhook(found);
  if (!hook) return [...ALL_FIELDS];
  const fields: WebhookField[] = [];
  if (hook.enabled !== true) fields.push('enabled');
  if (hook.url !== expected.url) fields.push('url');
  if (!sameEventSet(hook.events)) fields.push('events');
  if (readHeaderApikey(hook.headers) !== expected.apikey) {
    fields.push('headers.apikey');
  }
  return fields;
}
