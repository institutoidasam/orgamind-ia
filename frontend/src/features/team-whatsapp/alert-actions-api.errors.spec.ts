import { HTTPError } from "ky";
import { describe, expect, it } from "vitest";
import { alertActionErrorText } from "./alert-actions-api";

const httpError = (status: number, body: object) =>
  new HTTPError(
    new Response(JSON.stringify(body), { status }),
    new Request("https://x"),
    {} as never,
  );

describe("alerta urgente: texto de erro das ações (lembrete e ciência)", () => {
  it("channel_disconnected não fala de prévia, pois o lembrete não tem prévia", async () => {
    const text = await alertActionErrorText(
      httpError(409, { code: "team_whatsapp.channel_disconnected" }),
      "Não foi possível enviar o lembrete.",
    );
    expect(text).toBe(
      "Um número desta área está desconectado. Reconecte-o em Conexões e tente de novo.",
    );
    expect(text).not.toContain("prévia");
  });
});
