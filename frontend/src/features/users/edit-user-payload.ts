import {
  toAuthorizationInput,
  type AuthorizationChoice,
  type ContactAuthorization,
} from "@/features/people-record/authorization";
import type { EditUserFormValues, EditUserInput } from "./schemas";

/** Campos que mudaram em relação ao cadastro; só eles vão no PATCH. */
export type ChangedUserFields = {
  phone?: boolean;
  shiftId?: boolean;
  jobTitle?: boolean;
  levelId?: boolean;
  registration?: boolean;
  authorization?: boolean;
};

/**
 * Autorização atual como escolha da tela. Origem `CADASTRO_ANTERIOR` (só da migração)
 * não é uma opção do campo: fica `null`, isto é, sem escolha nova.
 */
export function authorizationChoiceOf(current: ContactAuthorization | null | undefined): AuthorizationChoice | null {
  if (!current) return null;
  if (current.status === "NAO_AUTORIZADO") return { status: "NAO_AUTORIZADO" };
  if (!current.source || current.source === "CADASTRO_ANTERIOR" || !current.date) return null;
  return { status: "AUTORIZADO", source: current.source, ...(current.note ? { note: current.note } : {}), date: current.date };
}

/** A escolha difere da atual? Sem escolha (`null`) nunca é mudança. */
export function authorizationChanged(choice: AuthorizationChoice | null, current: AuthorizationChoice | null): boolean {
  if (choice === null) return false;
  if (current === null || choice.status !== current.status) return true;
  if (choice.status === "NAO_AUTORIZADO" || current.status === "NAO_AUTORIZADO") return false;
  return choice.source !== current.source || choice.date !== current.date || (choice.note ?? "").trim() !== (current.note ?? "");
}

/** Pessoa sem acesso não tem perfil: o servidor recusa `role` (users.no_access). */
export function editableUserPayload(
  data: EditUserFormValues,
  isSelf: boolean,
  changed: ChangedUserFields = {},
  hasAccess = true,
): EditUserInput {
  const { phone, shiftId, jobTitle, levelId, role, registration, authorization, reason, ...rest } = data;
  const withRole = hasAccess && role !== undefined ? { ...rest, role } : rest;
  const base = isSelf ? (rest.name === undefined ? {} : { name: rest.name }) : withRole;
  return {
    ...base,
    ...(reason ? { reason } : {}),
    ...changedFields({ phone, shiftId, jobTitle, levelId }, changed),
    ...changedRecord({ registration, authorization }, changed),
  };
}

function changedFields({ phone, shiftId, jobTitle, levelId }: EditUserInput, changed: ChangedUserFields): EditUserInput {
  return {
    ...(changed.phone && phone ? { phone } : {}),
    ...(changed.shiftId ? { shiftId: shiftId ?? null } : {}),
    ...(changed.jobTitle ? { jobTitle: jobTitle?.trim() || null } : {}),
    ...(changed.levelId ? { levelId: levelId ?? null } : {}),
  };
}

/** Matrícula e autorização da ficha: só a que mudou; matrícula vazia limpa (`null`). */
function changedRecord(
  { registration, authorization }: Pick<EditUserFormValues, "registration" | "authorization">,
  changed: ChangedUserFields,
): EditUserInput {
  return {
    ...(changed.registration ? { registration: registration?.trim() || null } : {}),
    ...(changed.authorization && authorization ? { contactAuthorization: toAuthorizationInput(authorization) } : {}),
  };
}
