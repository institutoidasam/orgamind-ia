import { toast } from "sonner";
import { extractApiError } from "@/lib/api-error";
import { describeUserError } from "./error-messages";
import { reportUserPhoneError } from "./phone-errors";

type PhoneFieldForm = Parameters<typeof reportUserPhoneError>[0];

/** Toast do erro de uma ação sobre usuário: mensagem pt-BR do código conhecido, senão o erro genérico. */
export async function toastUserError(error: unknown): Promise<void> {
  const message = await describeUserError(error);
  if (message) {
    toast.error(message);
    return;
  }
  const { title, message: detail } = await extractApiError(error);
  toast.error(title, { description: detail });
}

/** Erro do envio do formulário de usuário: telefone vai para o campo, o resto vira toast. */
export async function reportUserSubmitError(form: PhoneFieldForm, error: unknown): Promise<void> {
  if (await reportUserPhoneError(form, error)) return;
  await toastUserError(error);
}
