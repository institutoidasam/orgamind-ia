import type { EditUserInput } from "./schemas";

export function editableUserPayload(
  data: EditUserInput,
  isSelf: boolean,
  phoneChanged = false,
  shiftChanged = false,
): EditUserInput {
  const { phone, shift, ...rest } = data;
  const base = isSelf ? (rest.name === undefined ? {} : { name: rest.name }) : rest;
  const withPhone = phoneChanged && phone ? { ...base, phone } : base;
  return shiftChanged ? { ...withPhone, shift: shift ?? null } : withPhone;
}
