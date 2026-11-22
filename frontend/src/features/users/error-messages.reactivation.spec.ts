import { HTTPError } from "ky";
import { describe, expect, it } from "vitest";
import { describeUserError } from "./error-messages";

const httpError = (code: string) =>
  new HTTPError(new Response(JSON.stringify({ code }), { status: 409 }), new Request("https://x"), {} as never);

describe("describeUserError: reativação recusada (E10)", () => {
  it.each([
    ["user.sector_inactive", "O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa."],
    ["user.level_inactive", "O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa."],
  ])("aceite 18: %s vira o texto da spec (ficha)", async (code, message) => {
    expect(await describeUserError(httpError(code))).toBe(message);
  });
});
