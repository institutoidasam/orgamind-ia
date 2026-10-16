import { HTTPError } from 'ky';

const PHONE_ERROR_MESSAGES: Record<string, string> = {
  'user.phone_taken': 'Este telefone já está em uso por outro usuário.',
  'user.invalid_phone': 'Telefone inválido. Use DDD + número, com ou sem +55.',
};

/** Mensagem para o campo Telefone quando a API recusa o número; null = erro não é de telefone. */
export async function userPhoneFieldError(err: unknown): Promise<string | null> {
  if (!(err instanceof HTTPError)) return null;
  const body = (await err.response
    .clone()
    .json()
    .catch(() => null)) as { code?: string } | null;
  return (body?.code && PHONE_ERROR_MESSAGES[body.code]) || null;
}

type PhoneFieldForm = { setError: (name: 'phone', error: { message: string }) => void };

/** Pinta o erro de telefone no campo; devolve true quando tratou (o chamador não mostra toast). */
export async function reportUserPhoneError(form: PhoneFieldForm, err: unknown): Promise<boolean> {
  const message = await userPhoneFieldError(err);
  if (message) form.setError('phone', { message });
  return message !== null;
}
