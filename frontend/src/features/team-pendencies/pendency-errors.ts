/** Mensagens por `code` das ações da pendência (DK20). */
const PENDENCY_ERROR_TEXT: Record<string, string> = {
  "team_whatsapp.pendency_changed":
    "A pendência mudou enquanto você olhava. A lista foi recarregada; confira e tente de novo.",
  "team_whatsapp.not_handler":
    "Só o responsável pela pendência ou um administrador pode fazer isso.",
  "team_whatsapp.ack_exists":
    "A pessoa já deu ciência; não é preciso encerrar.",
  "user.not_found": "Esta pessoa não pode receber a pendência. Escolha outra.",
  "team_whatsapp.pendency_not_found": "Pendência não encontrada.",
};

const TAKEN_CODE = "team_whatsapp.pendency_taken";
const TAKEN_WITHOUT_NAME = "Outra pessoa assumiu esta pendência antes de você.";
const GENERIC_ERROR = "Não foi possível concluir a ação. Tente de novo.";

/**
 * `detail` dos 409 (DK15): JSON `{ handler: { id, name } | null }`. Tolerante: ausente, inválido ou sem
 * responsável (ou sem nome) vira `null`.
 */
export function parseHandlerDetail(
  detail: string | undefined,
): { id: string; name: string } | null {
  if (!detail) return null;
  try {
    const handler = (
      JSON.parse(detail) as { handler?: Record<string, unknown> | null } | null
    )?.handler;
    if (!handler) return null;
    const { id, name } = handler;
    return typeof id === "string" && typeof name === "string"
      ? { id, name }
      : null;
  } catch {
    return null;
  }
}

/** Texto do toast de erro de uma ação, pelo `code` do corpo (ky 2: lido por `readApiErrorBody` antes de chamar). */
export function pendencyErrorText(
  code: string | undefined,
  detail: string | undefined,
): string {
  if (code === TAKEN_CODE) {
    const handler = parseHandlerDetail(detail);
    return handler
      ? `${handler.name} assumiu esta pendência antes de você.`
      : TAKEN_WITHOUT_NAME;
  }
  return code && Object.hasOwn(PENDENCY_ERROR_TEXT, code)
    ? PENDENCY_ERROR_TEXT[code]
    : GENERIC_ERROR;
}
