import { HTTPError } from "ky";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportUserSubmitError } from "./submit-error";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const form = { setError: vi.fn() };
const httpError = (body: object, status: number) =>
  new HTTPError(new Response(JSON.stringify(body), { status }), new Request("https://x"), {} as never);

beforeEach(() => vi.clearAllMocks());

describe("reportUserSubmitError: conflito ao salvar o vínculo", () => {
  it("409 user.concurrent_admin_change vira toast em pt-BR, sem o título em inglês do back", async () => {
    const body = { code: "user.concurrent_admin_change", title: "Concurrent administrator change, retry the request" };
    await reportUserSubmitError(form, httpError(body, 409));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Outra pessoa alterou este cadastro agora. Recarregue a página e tente de novo.");
    expect(form.setError).not.toHaveBeenCalled();
  });

  it("código desconhecido segue com o erro genérico (título e detalhe da API)", async () => {
    const body = { code: "outro.codigo", title: "Falha qualquer", detail: "Detalhe da API" };
    await reportUserSubmitError(form, httpError(body, 409));
    expect(toast.error).toHaveBeenCalledWith("Falha qualquer", { description: "Detalhe da API" });
  });
});
