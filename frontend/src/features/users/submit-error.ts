import { toast } from "sonner";
import { extractApiError } from "@/lib/api-error";
import { reportUserPhoneError } from "./phone-errors";

type PhoneFieldForm = Parameters<typeof reportUserPhoneError>[0];

/** Erro do envio do formulário de usuário: telefone vai para o campo, o resto vira toast. */
export async function reportUserSubmitError(form: PhoneFieldForm, error: unknown): Promise<void> {
  if (await reportUserPhoneError(form, error)) return;
  const { title, message } = await extractApiError(error);
  toast.error(title, { description: message });
}
