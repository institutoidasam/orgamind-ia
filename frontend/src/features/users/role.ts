import type { UserSummary } from "./schemas";

export type UserRole = UserSummary["role"];

export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: "Administrador",
  SUPERVISOR: "Supervisor",
  OPERATOR: "Operador",
  VIEWER: "Leitura",
};

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  ADMIN: [
    "Administra setores, usuários e números",
    "Acompanha todos os setores",
  ],
  SUPERVISOR: [
    "Coordena demandas do próprio setor",
    "Publica e acompanha comunicações permitidas",
  ],
  OPERATOR: [
    "Cria e responde comunicações do próprio setor",
    "Acompanha demandas atribuídas",
  ],
  VIEWER: [
    "Consulta comunicações autorizadas",
    "Marca leituras sem alterar demandas",
  ],
};
