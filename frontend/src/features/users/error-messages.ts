import { readApiErrorBody } from "@/lib/api-error";

const USER_ERROR_MESSAGES: Record<string, string> = {
  "users.no_access": "Esta pessoa não tem acesso ao sistema.",
  "users.already_has_access": "Esta pessoa já tem acesso.",
  "users.invalid_level": "Nível inválido. Atualize a página e tente de novo.",
  "users.invalid_shift": "Turno inválido. Atualize a página.",
  "users.name_required": "Informe o nome da pessoa.",
  "user.email_taken": "Este e-mail já está em uso por outro usuário.",
  "user.sector_required": "Defina o setor da pessoa em Editar antes de dar acesso a este perfil.",
  "user.sector_invalid": "O setor da pessoa está inativo. Escolha outro em Editar.",
};

/** Mensagem pt-BR do código de erro da API de usuários; undefined = erro genérico. */
export async function describeUserError(error: unknown): Promise<string | undefined> {
  const code = (await readApiErrorBody(error))?.code;
  return code ? USER_ERROR_MESSAGES[code] : undefined;
}
