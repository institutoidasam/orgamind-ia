import { describe, expect, it } from "vitest";
import { parseHandlerDetail, pendencyErrorText } from "./pendency-errors";

describe("pendencyErrorText (DK20)", () => {
  it("pendency_taken com detail — {nome} assumiu esta pendência antes de você.", () => {
    const detail = JSON.stringify({ handler: { id: "u1", name: "Ana" } });
    expect(pendencyErrorText("team_whatsapp.pendency_taken", detail)).toBe(
      "Ana assumiu esta pendência antes de você.",
    );
  });

  it("pendency_taken sem detail — Outra pessoa assumiu esta pendência antes de você.", () => {
    expect(pendencyErrorText("team_whatsapp.pendency_taken", undefined)).toBe(
      "Outra pessoa assumiu esta pendência antes de você.",
    );
    expect(
      pendencyErrorText("team_whatsapp.pendency_taken", "{ não é json"),
    ).toBe("Outra pessoa assumiu esta pendência antes de você.");
  });

  it.each([
    [
      "team_whatsapp.pendency_changed",
      "A pendência mudou enquanto você olhava. A lista foi recarregada; confira e tente de novo.",
    ],
    [
      "team_whatsapp.not_handler",
      "Só o responsável pela pendência ou um administrador pode fazer isso.",
    ],
    [
      "team_whatsapp.ack_exists",
      "A pessoa já deu ciência; não é preciso encerrar.",
    ],
    [
      "user.not_found",
      "Esta pessoa não pode receber a pendência. Escolha outra.",
    ],
    ["team_whatsapp.pendency_not_found", "Pendência não encontrada."],
    ["outro.codigo", "Não foi possível concluir a ação. Tente de novo."],
    [undefined, "Não foi possível concluir a ação. Tente de novo."],
    ["toString", "Não foi possível concluir a ação. Tente de novo."],
  ])("%s", (code, text) => {
    expect(pendencyErrorText(code, undefined)).toBe(text);
  });
});

describe("parseHandlerDetail", () => {
  it("parseHandlerDetail tolera detail ausente ou inválido", () => {
    expect(parseHandlerDetail(undefined)).toBeNull();
    expect(parseHandlerDetail("")).toBeNull();
    expect(parseHandlerDetail("não é json")).toBeNull();
    expect(parseHandlerDetail("null")).toBeNull();
    expect(parseHandlerDetail(JSON.stringify({ handler: null }))).toBeNull();
    expect(
      parseHandlerDetail(JSON.stringify({ handler: { id: "u1" } })),
    ).toBeNull();
  });

  it("devolve id e nome do responsável", () => {
    const detail = JSON.stringify({ handler: { id: "u1", name: "Ana" } });
    expect(parseHandlerDetail(detail)).toEqual({ id: "u1", name: "Ana" });
  });
});
