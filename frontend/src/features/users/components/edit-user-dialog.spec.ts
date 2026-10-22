import { describe, expect, it } from "vitest";
import { editableUserPayload } from "../edit-user-payload";

describe("editableUserPayload", () => {
  it("omits protected fields when the administrator edits their own profile", () => {
    expect(
      editableUserPayload(
        { name: "Ana", role: "OPERATOR", sectorId: "s1", isActive: false },
        true,
      ),
    ).toEqual({ name: "Ana" });
  });

  it("keeps administrative fields when editing another user", () => {
    expect(
      editableUserPayload(
        { role: "SUPERVISOR", sectorId: "s1", isActive: false },
        false,
      ),
    ).toEqual({ role: "SUPERVISOR", sectorId: "s1", isActive: false });
  });
});

describe("editableUserPayload", () => {
  it("includes phone only when it changed and is not empty", () => {
    const data = { name: "Ana", phone: "92 98888-7777" };
    expect(editableUserPayload(data, false, { phone: true })).toEqual(data);
    expect(editableUserPayload(data, false)).toEqual({ name: "Ana" });
    expect(editableUserPayload({ name: "Ana", phone: "" }, false, { phone: true })).toEqual({ name: "Ana" });
    expect(editableUserPayload(data, true, { phone: true })).toEqual(data);
  });

  it("includes shiftId only when it changed; null clears it", () => {
    expect(editableUserPayload({ name: "Ana", shiftId: "sh1" }, false)).toEqual({ name: "Ana" });
    expect(editableUserPayload({ name: "Ana", shiftId: "sh1" }, false, { shiftId: true })).toEqual({ name: "Ana", shiftId: "sh1" });
    expect(editableUserPayload({ name: "Ana", shiftId: null }, false, { shiftId: true })).toEqual({ name: "Ana", shiftId: null });
  });

  it("includes jobTitle only when it changed; empty becomes null", () => {
    expect(editableUserPayload({ name: "Ana", jobTitle: "Operador" }, false)).toEqual({ name: "Ana" });
    expect(editableUserPayload({ name: "Ana", jobTitle: "Operador" }, false, { jobTitle: true })).toEqual({ name: "Ana", jobTitle: "Operador" });
    expect(editableUserPayload({ name: "Ana", jobTitle: "" }, false, { jobTitle: true })).toEqual({ name: "Ana", jobTitle: null });
  });

  it("includes levelId only when it changed; null clears it", () => {
    expect(editableUserPayload({ name: "Ana", levelId: "lv1" }, false)).toEqual({ name: "Ana" });
    expect(editableUserPayload({ name: "Ana", levelId: "lv1" }, false, { levelId: true })).toEqual({ name: "Ana", levelId: "lv1" });
    expect(editableUserPayload({ name: "Ana", levelId: null }, false, { levelId: true })).toEqual({ name: "Ana", levelId: null });
  });

  it("never sends role for a person without access", () => {
    expect(
      editableUserPayload({ name: "Rita", role: "VIEWER", sectorId: "s1" }, false, {}, false),
    ).toEqual({ name: "Rita", sectorId: "s1" });
  });
});
