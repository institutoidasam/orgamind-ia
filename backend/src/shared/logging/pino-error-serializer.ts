type ErrorRecord = Record<string, unknown>;

export interface SerializedLogError {
  type: string;
  message?: string;
  code?: string;
  status?: number;
  stack?: string;
  cause?: SerializedLogError;
}

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as ErrorRecord)
    : undefined;
}

function read(value: ErrorRecord, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function readString(value: ErrorRecord, key: string): string | undefined {
  const candidate = read(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function readNumber(value: ErrorRecord, key: string): number | undefined {
  const candidate = read(value, key);
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/** Evita que URLs e cabeçalhos incorporados na mensagem/stack revelem segredo. */
function sanitizeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'"`]+/giu, '[URL omitida]')
    .replace(
      /(["'](?:proxy-authorization|authorization|api[_-]?key|token|password|secret)["']\s*:\s*["'])[^"']*(["'])/giu,
      '$1[Redacted]$2',
    )
    .replace(
      /\b((?:proxy-)?authorization)\s*:\s*(?:basic|bearer)\s+[^\s,;]+/giu,
      '$1: [Redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [Redacted]')
    .replace(
      /\b(proxy-authorization|authorization|api[_-]?key|token|password|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1$2 [Redacted]',
    );
}

function errorType(error: ErrorRecord): string {
  return sanitizeText(
    readString(error, 'type') ?? readString(error, 'name') ?? 'Error',
  );
}

function statusFor(error: ErrorRecord): number | undefined {
  const status = readNumber(error, 'status');
  if (status !== undefined) return status;

  const response = asRecord(read(error, 'response'));
  return response ? readNumber(response, 'status') : undefined;
}

/**
 * Serializa erros por lista permitida para Pino. AxiosError pode trazer config,
 * request, response e payload com credenciais; nenhum desses objetos atravessa
 * esta fronteira. A recursão limitada mantém a causa útil sem seguir ciclos.
 */
export function serializeErrorForLog(error: unknown): SerializedLogError {
  return serialize(error, new WeakSet<object>(), 2);
}

function serialize(
  value: unknown,
  visited: WeakSet<object>,
  remainingCauseDepth: number,
): SerializedLogError {
  const error = asRecord(value);
  if (!error) {
    return { type: typeof value, message: sanitizeText(String(value)) };
  }

  if (visited.has(error)) {
    return { type: 'Error', message: '[causa circular omitida]' };
  }
  visited.add(error);

  const message = readString(error, 'message');
  const code = readString(error, 'code');
  const stack = readString(error, 'stack');
  const result: SerializedLogError = { type: errorType(error) };

  if (message) result.message = sanitizeText(message);
  if (code) result.code = sanitizeText(code);

  const status = statusFor(error);
  if (status !== undefined) result.status = status;
  if (stack) result.stack = sanitizeText(stack);

  const cause = read(error, 'cause');
  if (remainingCauseDepth > 0 && cause && typeof cause === 'object') {
    result.cause = serialize(cause, visited, remainingCauseDepth - 1);
  }

  return result;
}
