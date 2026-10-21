import { toast } from "sonner";
import { extractApiError } from "@/lib/api-error";
import { reportUserPhoneError } from "./phone-errors";

type PhoneFieldForm = Parameters<typeof reportUserPhoneError>[0];

const INVALID_SHIFT_CODE = "users.invalid_shift";
const INVALID_SHIFT_MESSAGE = "Turno inválido. Atualize a página.";

/** Erro do envio do formulário de usuário: telefone vai para o campo, o resto vira toast. */
export async function reportUserSubmitError(form: PhoneFieldForm, error: unknown): Promise<void> {
  if (await reportUserPhoneError(form, error)) return;
  const { title, message, code } = await extractApiError(error);
  if (code === INVALID_SHIFT_CODE) toast.error(INVALID_SHIFT_MESSAGE);
  else toast.error(title, { description: message });
}
