import { toast } from "sonner";
import { extractApiError, readApiErrorBody } from "@/lib/api-error";
import { describeUserError } from "./error-messages";
import { reportUserPhoneError } from "./phone-errors";

type SubmitForm = { setError: (name: "phone" | "registration", error: { message: string }) => void };

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

/** Matrícula repetida (422 `user.registration_taken`) vai para o campo Matrícula; true = tratou. */
async function reportRegistrationTaken(form: SubmitForm, error: unknown): Promise<boolean> {
  if ((await readApiErrorBody(error))?.code !== "user.registration_taken") return false;
  const message = await describeUserError(error);
  if (message) form.setError("registration", { message });
  return message !== undefined;
}

/** Erro do envio do formulário de usuário: telefone e matrícula vão para o campo, o resto vira toast. */
export async function reportUserSubmitError(form: SubmitForm, error: unknown): Promise<void> {
  if (await reportUserPhoneError(form, error)) return;
  if (await reportRegistrationTaken(form, error)) return;
  await toastUserError(error);
}
