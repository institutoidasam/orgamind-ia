import { describe, expect, it } from "vitest";
import {
  ALERT_ACK_DEADLINE_MINUTES,
  ALERT_CONFIRM_LINE,
  ALERT_CONFIRM_SUFFIX_LENGTH,
  finalTextLength,
} from "./alert-text";

describe("alert-text: finalTextLength", () => {
  it("finalTextLength soma 41 só na Urgência", () => {
    expect(finalTextLength("a".repeat(100), "urgency")).toBe(141);
    expect(finalTextLength("", "urgency")).toBe(41);
    expect(finalTextLength("a".repeat(100), "meeting")).toBe(100);
    expect(finalTextLength("a".repeat(100), "shift_notice")).toBe(100);
    expect(finalTextLength("a".repeat(100), undefined)).toBe(100);
  });

  it("constantes espelham o servidor: linha e 15 min", () => {
    expect(ALERT_CONFIRM_LINE).toBe("Responda OK para confirmar que recebeu.");
    expect(`\n\n${ALERT_CONFIRM_LINE}`).toHaveLength(
      ALERT_CONFIRM_SUFFIX_LENGTH,
    );
    expect(ALERT_CONFIRM_SUFFIX_LENGTH).toBe(41);
    expect(ALERT_ACK_DEADLINE_MINUTES).toBe(15);
  });
});
