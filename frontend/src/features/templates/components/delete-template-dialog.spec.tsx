import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HTTPError } from "ky";

const mutateAsync = vi.fn();
const onOpenChange = vi.fn();

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../api", () => ({
  useDeleteTemplate: () => ({ isPending: false, mutateAsync }),
}));

import { toast } from "sonner";
import { DeleteTemplateDialog } from "./delete-template-dialog";
import type { Template } from "../schemas";

function makeKyError(status: number, body: unknown): HTTPError {
  const response = new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          typeof body === "string" ? "text/plain" : "application/json",
      },
    },
  );
  return new HTTPError(
    response as never,
    new Request("http://localhost/x") as never,
    {} as never,
  );
}

function template(over: Partial<Template> = {}): Template {
  return {
    id: "t1",
    metaName: "welcome",
    language: "pt_BR",
    body: "Olá {{1}}",
    variables: ["1"],
    status: "APPROVED",
    category: "UTILITY",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    kind: "TEXT",
    interactiveConfig: null,
    provider: "EVOLUTION",
    ...over,
  };
}

function clickDelete() {
  fireEvent.click(screen.getByRole("button", { name: /^excluir$/i }));
}

describe("DeleteTemplateDialog — onConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the template metaName in the description", () => {
    render(
      <DeleteTemplateDialog
        open
        onOpenChange={onOpenChange}
        template={template({ metaName: "boas_vindas" })}
      />,
    );
    expect(screen.getByText("boas_vindas")).toBeInTheDocument();
  });

  it("on success: toasts success and closes the dialog", async () => {
    mutateAsync.mockResolvedValueOnce(template());
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith("t1");
      expect(toast.success).toHaveBeenCalledWith("Template excluído");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("template.in_use with a detail: shows the backend detail", async () => {
    mutateAsync.mockRejectedValueOnce(
      makeKyError(409, {
        code: "template.in_use",
        detail: "Template em uso em 3 campanhas ativas",
      }),
    );
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Template em uso em 3 campanhas ativas",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("template.in_use without a detail: shows the fallback in-use message", async () => {
    mutateAsync.mockRejectedValueOnce(
      makeKyError(409, { code: "template.in_use" }),
    );
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Template em uso por uma ou mais campanhas — não pode ser excluído.",
      ),
    );
  });

  it("403 (not in_use): shows the admin-only message", async () => {
    mutateAsync.mockRejectedValueOnce(
      makeKyError(403, { code: "forbidden", detail: "no" }),
    );
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Apenas administradores podem excluir templates",
      ),
    );
  });

  it("other HTTPError: shows the generic delete-failed message", async () => {
    mutateAsync.mockRejectedValueOnce(
      makeKyError(500, { code: "internal", detail: "boom" }),
    );
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Falha ao excluir template"),
    );
  });

  it("non-HTTP error: shows the network error message", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("offline"));
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={template()} />,
    );
    clickDelete();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Erro de rede"),
    );
  });

  it("does nothing when there is no template", async () => {
    render(
      <DeleteTemplateDialog open onOpenChange={onOpenChange} template={null} />,
    );
    clickDelete();
    // mutateAsync is never called; the early return guards it.
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
