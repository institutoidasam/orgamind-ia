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
    try {
      const body = (await error.response.clone().json()) as {
        code?: string;
        title?: string;
        detail?: string;
        status?: number;
        errors?: Array<{ path: string; message: string }>;
      };
      const message =
        body.detail ??
        (body.errors && body.errors.length > 0
          ? body.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
          : error.message);
      return {
        code: body.code,
        title: body.title ?? 'Erro',
        message,
        status: body.status ?? status,
      };
    } catch {
      // body wasn't JSON — fall through to the generic shape
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
