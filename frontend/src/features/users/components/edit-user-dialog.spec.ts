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

  it("includes phone only when it changed and is not empty", () => {
    const data = { name: "Ana", phone: "92 98888-7777" };
    expect(editableUserPayload(data, false, true)).toEqual(data);
    expect(editableUserPayload(data, false, false)).toEqual({ name: "Ana" });
    expect(editableUserPayload({ name: "Ana", phone: "" }, false, true)).toEqual({ name: "Ana" });
    expect(editableUserPayload(data, true, true)).toEqual(data);
  });
});
