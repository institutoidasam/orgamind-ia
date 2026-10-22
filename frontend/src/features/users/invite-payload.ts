import type { InviteUserOutput } from "./schemas";

type Shared = {
  name?: string;
  phone: string;
  sectorId: string | null;
  shiftId: string | null;
  jobTitle?: string;
  levelId?: string;
};

/** Corpo do POST /users: sem acesso não leva e-mail nem perfil; com acesso é o convite de sempre. */
export type CreateUserPayload =
  | (Shared & { hasAccess: false; name: string })
  | (Shared & { email: string; role: InviteUserOutput["role"] });

export function invitePayload(data: InviteUserOutput): CreateUserPayload {
  const shared: Shared = {
    name: data.name?.trim() || undefined,
    phone: data.phone,
    sectorId: data.sectorId ?? null,
    shiftId: data.shiftId ?? null,
    jobTitle: data.jobTitle || undefined,
    ...(data.levelId ? { levelId: data.levelId } : {}),
  };
  if (!data.hasAccess) return { ...shared, hasAccess: false, name: shared.name ?? "" };
  return { ...shared, email: (data.email ?? "").trim(), role: data.role };
}
