import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSummary } from "../schemas";
import { UserStatusFlow } from "./user-status-flow";

const { setStatus, toastSuccess } = vi.hoisted(() => ({
  setStatus: { mutateAsync: vi.fn() },
  toastSuccess: vi.fn(),
}));
vi.mock("../api", () => ({ useSetUserStatus: () => setStatus }));
vi.mock("./use-invalidate-audit-trail", () => ({ useInvalidateAuditTrail: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

const inactive = { id: "u1", name: "Rita", email: null, hasAccess: false, isActive: false } as UserSummary;

/** O back recusa com 409 e só o `code` no corpo: o `title` é o texto do DomainError e não há `detail`. */
function rejectWith(code: string) {
  const response = new Response(JSON.stringify({ code, title: "texto do servidor" }), { status: 409 });
  setStatus.mutateAsync.mockRejectedValueOnce(new HTTPError(response, new Request("https://x"), {} as never));
}

beforeEach(() => vi.clearAllMocks());

describe("UserStatusFlow: reativação recusada (E10)", () => {
  it("aceite 18: reativar na ficha com 409 user.sector_inactive mostra a mensagem e não mostra o sucesso", async () => {
    rejectWith("user.sector_inactive");
    const onClose = vi.fn();
    const ui = userEvent.setup();
    render(<UserStatusFlow user={inactive} onClose={onClose} />);
    await ui.type(screen.getByLabelText("Motivo da alteração"), "Voltou da licença");
    await ui.click(screen.getByRole("button", { name: "Reativar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
