import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionKey } from "@/features/permissions/keys";
import { useAuthStore } from "@/stores/auth.store";
import { useSendFilters } from "../use-send-filters";
import { PurposeFields } from "./purpose-fields";

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function Harness() {
  const filters = useSendFilters("2026-10-21", []);
  return <PurposeFields filters={filters} />;
}

const withPermissions = (permissions: PermissionKey[]) =>
  useAuthStore.setState({
    user: {
      id: "u1",
      email: "o@x.test",
      name: "Olga",
      role: "OPERATOR",
      permissions,
    },
  });

async function optionNames(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Finalidade" }));
  return screen.getAllByRole("option").map((option) => option.textContent);
}

beforeEach(() => withPermissions(["equipe.enviar"]));
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe("PurposeFields: Urgência só com equipe.urgencia", () => {
  it("aceite 12: sem equipe.urgencia a Urgência não aparece; com ela, aparece", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    expect(await optionNames(user)).toEqual([
      "Aviso de turno",
      "Reunião",
      "Alinhamento",
      "Palestra",
      "Hora extra",
    ]);
    unmount();

    withPermissions(["equipe.enviar", "equipe.urgencia"]);
    render(<Harness />);
    expect(await optionNames(user)).toEqual([
      "Aviso de turno",
      "Reunião",
      "Alinhamento",
      "Palestra",
      "Hora extra",
      "Urgência",
    ]);
  });

  it("a permissão sai com a Urgência escolhida: a tela volta ao Aviso de turno e some o motivo", async () => {
    withPermissions(["equipe.enviar", "equipe.urgencia"]);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Finalidade" }));
    await user.click(screen.getByRole("option", { name: "Urgência" }));
    expect(screen.getByLabelText("Motivo da urgência")).toBeInTheDocument();

    act(() => withPermissions(["equipe.enviar"]));

    expect(
      screen.getByRole("combobox", { name: "Finalidade" }),
    ).toHaveTextContent("Aviso de turno");
    expect(
      screen.queryByLabelText("Motivo da urgência"),
    ).not.toBeInTheDocument();
  });
});
