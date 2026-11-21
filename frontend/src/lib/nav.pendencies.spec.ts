import { describe, expect, it } from "vitest";
import { NAV, navSection, type NavRole } from "./nav";

const PENDENCIES = "/pendencias-equipe";
const SENDER = { teamSender: true } as const;

describe("NAV Pendências da equipe (K2-6, DK21)", () => {
  it("item Pendências da equipe para ADMIN, SUPERVISOR e OPERATOR quando teamSender; nunca para VIEWER", () => {
    for (const role of ["ADMIN", "SUPERVISOR", "OPERATOR"] as const) {
      const ops = navSection("ops", role, undefined, SENDER);
      expect(ops.map((item) => item.label)).toContain("Pendências da equipe");
      const labels = ops.map((item) => item.label);
      expect(labels.indexOf("Pendências da equipe")).toBe(
        labels.indexOf("WhatsApp da equipe") + 1,
      );
    }
    expect(
      navSection("ops", "VIEWER", undefined, SENDER).map((item) => item.to),
    ).not.toContain(PENDENCIES);
    expect(
      NAV.find((item) => item.to === PENDENCIES)?.permission,
    ).toBeUndefined();
  });

  it("sem teamSender — item escondido; outros itens iguais", () => {
    for (const role of ["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"] as const) {
      const without = navSection("ops", role).map((item) => item.to);
      expect(without).not.toContain(PENDENCIES);
      expect(
        navSection("ops", role, undefined, { teamSender: false }).map(
          (item) => item.to,
        ),
      ).toEqual(without);
      const withSender = navSection("ops", role, undefined, SENDER).map(
        (item) => item.to,
      );
      expect(withSender.filter((to) => to !== PENDENCIES)).toEqual(without);
    }
    const roles: NavRole[] = ["ADMIN", "OPERATOR"];
    expect(
      roles.map((r) => navSection("admin", r, undefined, SENDER).length),
    ).toEqual(roles.map((r) => navSection("admin", r).length));
  });
});
