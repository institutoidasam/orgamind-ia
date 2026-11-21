import { HTTPError } from "ky";
import { describe, expect, it } from "vitest";
import {
  apiErrorText,
  recipientStatusLabel,
  SKIP_REASON_LABEL,
  teamErrorMessage,
} from "./error-messages";

const httpError = (status: number, body: object) =>
  new HTTPError(
    new Response(JSON.stringify(body), { status }),
    new Request("https://x"),
    {} as never,
  );

describe("alerta urgente: textos de erro e pulo (DI14)", () => {
  it("Pulado: já confirmou", () => {
    expect(SKIP_REASON_LABEL.ACKED).toBe("já confirmou");
    expect(recipientStatusLabel("SKIPPED", "ACKED")).toBe(
      "Pulado: já confirmou",
    );
  });

  it("erros novos com os textos de DI14", () => {
    const textos = [
      ["not_an_alert", "Este envio não é um alerta urgente."],
      ["ack_exists", "Esta pessoa já tem ciência registrada."],
      ["ack_not_manual", "Só a ciência manual pode ser desfeita."],
      [
        "reminder_empty",
        "Nenhuma das pessoas escolhidas está pendente. Atualize a lista.",
      ],
      ["reminder_limit", "Este alerta já teve 3 lembretes, o máximo."],
      [
        "reminder_too_soon",
        "Espere 5 minutos desde o alerta ou o último lembrete.",
      ],
    ];
    for (const [code, text] of textos)
      expect(teamErrorMessage(`team_whatsapp.${code}`)).toBe(text);
  });

  it("sem equipe.urgencia o servidor manda o texto da recusa e a tela o mostra", async () => {
    const body = {
      code: "auth.permission_denied",
      detail: "Você não tem permissão para criar alerta urgente.",
    };
    expect(await apiErrorText(httpError(403, body), teamErrorMessage)).toBe(
      body.detail,
    );
  });
});
