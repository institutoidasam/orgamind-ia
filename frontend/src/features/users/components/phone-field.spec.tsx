import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhoneField } from "./phone-field";

const registration = { name: "phone", onChange: async () => {}, onBlur: async () => {}, ref: () => {} };

describe("PhoneField accessibility", () => {
  it("links the input to the error alert", () => {
    render(<PhoneField id="p" registration={registration} error="Telefone obrigatório" />);
    const alert = screen.getByRole("alert");
    const input = screen.getByLabelText("Telefone (WhatsApp)");
    expect(alert.textContent).toBe("Telefone obrigatório");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("has no alert nor aria-describedby without error", () => {
    render(<PhoneField id="p" registration={registration} />);
    const input = screen.getByLabelText("Telefone (WhatsApp)");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });
});
