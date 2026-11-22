import { toAuthorizationInput, type ContactAuthorizationInput } from "@/features/people-record/authorization";
import type { InviteUserOutput } from "./schemas";

type Shared = {
  name?: string;
  phone: string;
  sectorId: string | null;
  shiftId: string | null;
  jobTitle?: string;
  levelId?: string;
  registration?: string;
  contactAuthorization?: ContactAuthorizationInput;
};

/** Corpo do POST /users: sem acesso não leva e-mail nem perfil; com acesso é o convite de sempre. */
export type CreateUserPayload =
  | (Shared & { hasAccess: false; name: string })
  | (Shared & { email: string; role: InviteUserOutput["role"] });

/** Matrícula (só preenchida) e autorização de contato da ficha. */
function recordPayload({ registration, authorization }: InviteUserOutput): Pick<Shared, "registration" | "contactAuthorization"> {
  const trimmed = registration?.trim();
  return {
    ...(trimmed ? { registration: trimmed } : {}),
    ...(authorization ? { contactAuthorization: toAuthorizationInput(authorization) } : {}),
  };
}

export function invitePayload(data: InviteUserOutput): CreateUserPayload {
  const shared: Shared = {
    name: data.name?.trim() || undefined,
    phone: data.phone,
    sectorId: data.sectorId ?? null,
    shiftId: data.shiftId ?? null,
    jobTitle: data.jobTitle || undefined,
    ...(data.levelId ? { levelId: data.levelId } : {}),
    ...recordPayload(data),
  };
  if (!data.hasAccess) return { ...shared, hasAccess: false, name: shared.name ?? "" };
  return { ...shared, email: (data.email ?? "").trim(), role: data.role };
}
