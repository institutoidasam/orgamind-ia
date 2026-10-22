import type { EditUserInput } from "./schemas";

/** Campos que mudaram em relação ao cadastro; só eles vão no PATCH. */
export type ChangedUserFields = { phone?: boolean; shiftId?: boolean; jobTitle?: boolean; levelId?: boolean };

/** Pessoa sem acesso não tem perfil: o servidor recusa `role` (users.no_access). */
export function editableUserPayload(
  data: EditUserInput,
  isSelf: boolean,
  changed: ChangedUserFields = {},
  hasAccess = true,
): EditUserInput {
  const { phone, shiftId, jobTitle, levelId, role, ...rest } = data;
  const withRole = hasAccess && role !== undefined ? { ...rest, role } : rest;
  const base = isSelf ? (rest.name === undefined ? {} : { name: rest.name }) : withRole;
  return { ...base, ...changedFields({ phone, shiftId, jobTitle, levelId }, changed) };
}

function changedFields({ phone, shiftId, jobTitle, levelId }: EditUserInput, changed: ChangedUserFields): EditUserInput {
  return {
    ...(changed.phone && phone ? { phone } : {}),
    ...(changed.shiftId ? { shiftId: shiftId ?? null } : {}),
    ...(changed.jobTitle ? { jobTitle: jobTitle?.trim() || null } : {}),
    ...(changed.levelId ? { levelId: levelId ?? null } : {}),
  };
}
