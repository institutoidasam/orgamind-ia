import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserPermissionsDialog } from "./user-permissions-dialog";

const user = {
  id: "u1", email: "viewer@gbr.test", name: "Lia", role: "VIEWER" as const,
  sectorId: "s1", sector: { id: "s1", name: "Engenharia", code: "ENG", isActive: true },
  isActive: true, lastLoginAt: null, createdAt: "2026-10-10", createdBy: null,
};

describe("UserPermissionsDialog", () => {
  it("derives the real role, sector and external-channel boundary", async () => {
    const onOpenChange = vi.fn();
    render(<UserPermissionsDialog user={user} open onOpenChange={onOpenChange} />);
    expect(screen.getByText("Leitura")).toBeInTheDocument();
    expect(screen.getByText(/Engenharia/)).toBeInTheDocument();
    expect(screen.getByText("Consulta comunicações autorizadas")).toBeInTheDocument();
    expect(screen.getByText(/Acesso a canais externos é definido/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
