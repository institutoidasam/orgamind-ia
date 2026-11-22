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
  "user.registration_taken": "Já existe uma pessoa com esta matrícula",
  "user.reason_required": "Informe o motivo da alteração, de 3 a 200 caracteres.",
  "user.authorization_future_date": "A data da autorização não pode ser futura.",
  "user.has_history": "Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro.",
  // Reativação recusada (E10, DJ15): mesmo texto do DomainError do back e do mapa de sector-people.
  "user.sector_inactive": "O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.",
  "user.level_inactive": "O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.",
};

/** Mensagem pt-BR do código de erro da API de usuários; undefined = erro genérico. */
export async function describeUserError(error: unknown): Promise<string | undefined> {
  const code = (await readApiErrorBody(error))?.code;
  return code ? USER_ERROR_MESSAGES[code] : undefined;
}
