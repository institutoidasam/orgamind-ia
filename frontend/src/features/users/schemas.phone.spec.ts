import { describe, expect, it } from "vitest";
import { editUserSchemaFor, inviteUserSchema } from "./schemas";

const edit = { name: "Ana", role: "ADMIN" as const, sectorId: null, isActive: true };

describe("phone digits rule", () => {
  it("accepts international numbers up to 15 digits and rejects 16", () => {
    expect(editUserSchemaFor(true).safeParse({ ...edit, phone: "+351912345678901" }).success).toBe(true);
    expect(editUserSchemaFor(true).safeParse({ ...edit, phone: "+3519123456789012" }).success).toBe(false);
  });

  it("asks for DDD + number when too short", () => {
    const r = inviteUserSchema.safeParse({ email: "a@x.com", phone: "99123", role: "ADMIN" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("Informe DDD + número");
  });
});
