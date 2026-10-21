import type { EditUserInput } from "./schemas";

/** Campos que mudaram em relação ao cadastro; só eles vão no PATCH. */
export type ChangedUserFields = { phone?: boolean; shiftId?: boolean; jobTitle?: boolean };

export function editableUserPayload(
  data: EditUserInput,
  isSelf: boolean,
  changed: ChangedUserFields = {},
): EditUserInput {
  const { phone, shiftId, jobTitle, ...rest } = data;
  const base = isSelf ? (rest.name === undefined ? {} : { name: rest.name }) : rest;
  return { ...base, ...changedFields({ phone, shiftId, jobTitle }, changed) };
}

function changedFields({ phone, shiftId, jobTitle }: EditUserInput, changed: ChangedUserFields): EditUserInput {
  return {
    ...(changed.phone && phone ? { phone } : {}),
    ...(changed.shiftId ? { shiftId: shiftId ?? null } : {}),
    ...(changed.jobTitle ? { jobTitle: jobTitle?.trim() || null } : {}),
  };
}
