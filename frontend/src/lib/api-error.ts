// frontend/src/lib/api-error.ts
import { HTTPError } from 'ky';

export type ApiError = {
  /** Backend ProblemDetails `code` field — stable identifier for branching UI. */
  code?: string;
  /** Short human title — safe to put in a toast title or alert heading. */
  title: string;
  /** Human-readable detail. Goes in toast description or alert body. */
  message: string;
  /** HTTP status code, when known. */
  status?: number;
};

/** Campos do ProblemDetails do backend que a UI lê. Vêm da rede: todos opcionais. */
export type ApiErrorBody = {
  code?: string;
  title?: string;
  detail?: string;
  status?: number;
  errors?: Array<{ path: string; message: string }>;
};

/**
 * Corpo da resposta de erro de um HTTPError do ky. Em ky 2 o corpo é consumido
 * ao montar o erro e fica em `error.data` (JSON/problem+json já parseado; texto
 * nos demais content-types), então `error.response.json()` não funciona mais.
 * Sem `data` (ex.: HTTPError montado à mão), tenta o corpo do Response; corpo
 * ausente, já consumido ou não JSON → undefined. Nunca lança.
 */
export async function readErrorBody(error: HTTPError): Promise<unknown> {
  if (error.data !== undefined) return error.data;
  try {
    return await error.response.clone().json();
  } catch {
    return undefined;
  }
}

/**
 * readErrorBody restrito ao ProblemDetails: só devolve o corpo quando é um
 * objeto. Erro que não é HTTPError, corpo em texto ou ilegível → undefined.
 */
export async function readApiErrorBody(error: unknown): Promise<ApiErrorBody | undefined> {
  if (!(error instanceof HTTPError)) return undefined;
  const body = await readErrorBody(error);
  return typeof body === 'object' && body !== null ? (body as ApiErrorBody) : undefined;
}

function problemToApiError(body: ApiErrorBody, status: number, fallbackMessage: string): ApiError {
  const message =
    body.detail ??
    (body.errors && body.errors.length > 0
      ? body.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
      : fallbackMessage);
  return {
    code: body.code,
    title: body.title ?? 'Erro',
    message,
    status: body.status ?? status,
  };
}

/**
 * Normalize anything thrown from a ky call (or anywhere else) into an `ApiError`
 * that the UI can render directly. Always returns — never throws.
 *
 * Backend produces RFC 7807 problemDetails with extra `code`/`traceId` fields.
 * See backend/src/shared/errors/domain-exception.filter.ts for the shape.
 */
export async function extractApiError(error: unknown): Promise<ApiError> {
  if (error instanceof HTTPError) {
    const status = error.response.status;
    const body = await readApiErrorBody(error);
    try {
      if (body) return problemToApiError(body, status, error.message);
    } catch {
      // malformed ProblemDetails — fall through to the generic shape
    }
    return {
      title: 'Erro',
      message: `Falha HTTP ${status}`,
      status,
    };
  }
  if (error instanceof Error) {
    return { title: 'Erro', message: error.message };
  }
  return { title: 'Erro', message: 'Falha desconhecida' };
}
