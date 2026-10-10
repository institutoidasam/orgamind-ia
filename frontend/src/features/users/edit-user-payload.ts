import type { EditUserInput } from "./schemas";

export function editableUserPayload(
  data: EditUserInput,
  isSelf: boolean,
): EditUserInput {
  if (!isSelf) return data;
  return data.name === undefined ? {} : { name: data.name };
}
