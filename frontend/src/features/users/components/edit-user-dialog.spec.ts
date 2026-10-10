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
