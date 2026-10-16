import type { EditUserInput } from "./schemas";

export function editableUserPayload(
  data: EditUserInput,
  isSelf: boolean,
  phoneChanged = false,
): EditUserInput {
  const { phone, ...rest } = data;
  const base = isSelf ? (rest.name === undefined ? {} : { name: rest.name }) : rest;
  return phoneChanged && phone ? { ...base, phone } : base;
}
