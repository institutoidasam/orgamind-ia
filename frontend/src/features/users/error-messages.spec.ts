import { HTTPError } from "ky";
import { describe, expect, it } from "vitest";
import { describeUserError } from "./error-messages";

const httpError = (code: string, status: number) =>
  new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request("https://x"), {} as never);

describe("describeUserError", () => {
  it.each([
    ["users.no_access", 422, "Esta pessoa não tem acesso ao sistema."],
    ["users.already_has_access", 409, "Esta pessoa já tem acesso."],
    ["users.invalid_level", 422, "Nível inválido. Atualize a página e tente de novo."],
  ])("%s vira a mensagem em pt-BR", async (code, status, message) => {
    expect(await describeUserError(httpError(code, status))).toBe(message);
  });

  it("código desconhecido ou erro sem corpo: undefined (o chamador usa o erro genérico)", async () => {
    expect(await describeUserError(httpError("outro.codigo", 500))).toBeUndefined();
    expect(await describeUserError(new Error("falhou"))).toBeUndefined();
  });
});
