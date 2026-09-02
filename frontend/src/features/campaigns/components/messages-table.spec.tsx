import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";

import { MessagesTable } from "./messages-table";
import type { CampaignMessage, MessageStatus } from "../schemas";

const retryMutate = vi.fn();
const redispatchMutate = vi.fn();

const state: { items: CampaignMessage[] } = { items: [] };

vi.mock("../api", () => ({
  useCampaignMessages: () => ({
    data: { items: state.items, total: state.items.length, page: 1, pageSize: 25 },
    isLoading: false,
  }),
  useRetryMessage: () => ({ mutateAsync: retryMutate, isPending: false }),
  useRedispatchMessage: () => ({ mutateAsync: redispatchMutate, isPending: false }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

function msg(status: MessageStatus, over: Partial<CampaignMessage> = {}): CampaignMessage {
  return {
    id: `m-${status}`,
    campaignId: "camp1",
    contactId: "c1",
    providerMessageId: null,
    status,
    errorCode: null,
    errorMessage: null,
    variables: {},
    queuedAt: new Date("2026-08-18T12:00:00Z"),
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    contact: {
      id: "c1",
      name: "Ana",
      phoneE164: "+5511988887777",
      optedOut: false,
      city: null,
      tags: [],
      profilePictureUrl: null,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.items = [];
});

/**
 * ★ O BACKEND MUDOU E A TELA CONTINUAVA PROMETENDO O COMPORTAMENTO ANTIGO.
 *
 * `redispatchMessage` (campaigns.service.ts) hoje:
 *   a) RECUSA a linha em voo — SENDING/QUEUED/WAITING_INSTANCE devolvem
 *      MessageNotRetryableError (com SENDING, devolvê-la à fila é entrega
 *      DUPLICADA: dois workers na mesma linha);
 *   b) NÃO cria linha nova — devolve à fila A PRÓPRIA linha, com as variáveis
 *      reavaliadas (foi o clone que produzia "3 pulados de 2 destinatários").
 *
 * A tela oferecia o botão para QUALQUER status e o diálogo prometia "será
 * criada uma nova mensagem". Numa campanha eleitoral, um botão que promete
 * criar uma segunda mensagem é um convite a mandar propaganda duas vezes.
 */
describe("MessagesTable — disparar novamente", () => {
  it.each(["SENDING", "QUEUED", "WAITING_INSTANCE"] as MessageStatus[])(
    "não oferece o botão para a linha em voo (%s) — o backend recusa",
    (status) => {
      state.items = [msg(status)];
      render(<MessagesTable campaignId="camp1" />);
      expect(
        screen.queryByRole("button", {
          name: /disparar novamente para este contato/i,
        }),
      ).toBeNull();
    },
  );

  it.each(["FAILED", "SENT", "DELIVERED", "READ", "CANCELLED", "SKIPPED_NO_CONSENT"] as MessageStatus[])(
    "oferece o botão para a linha parada (%s)",
    (status) => {
      state.items = [msg(status)];
      render(<MessagesTable campaignId="camp1" />);
      expect(
        screen.getByRole("button", {
          name: /disparar novamente para este contato/i,
        }),
      ).toBeInTheDocument();
    },
  );

  it("o diálogo descreve o que o backend faz: reenfileira ESTA mensagem, sem criar outra", async () => {
    const user = userEvent.setup();
    state.items = [msg("DELIVERED")];
    render(<MessagesTable campaignId="camp1" />);

    await user.click(
      screen.getByRole("button", {
        name: /disparar novamente para este contato/i,
      }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).not.toHaveTextContent(/nova mensagem/i);
    expect(dialog).toHaveTextContent(/mesma mensagem/i);
  });

  /**
   * Corrida real: a linha estava parada quando a tela renderizou e entrou em
   * envio antes do clique. O backend recusa (MessageNotRetryableError) e a tela
   * mostrava só "Falha ao disparar" — a recusa sem motivo que, em 2026-08-11,
   * levou o operador a oito tentativas cegas numa tarde.
   */
  it("quando a falha não tem corpo (rede/erro cru), o toast ainda diz o motivo provável", async () => {
    const user = userEvent.setup();
    state.items = [msg("FAILED")];
    redispatchMutate.mockRejectedValue(new Error("409"));
    render(<MessagesTable campaignId="camp1" />);

    await user.click(
      screen.getByRole("button", {
        name: /disparar novamente para este contato/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Disparar$/ }));

    expect(toastError).toHaveBeenCalled();
    const [titulo, opts] = toastError.mock.calls[0] as [
      string,
      { description?: string } | undefined,
    ];
    expect(`${titulo} ${opts?.description ?? ""}`).toMatch(
      /em envio|entrou em envio/i,
    );
  });
});

/**
 * ★ A RECUSA TEM DE CHEGAR À TELA COM O MOTIVO QUE O BACKEND ESCREVEU.
 *
 * O backend passou a recusar os dois botões por linha com um erro de domínio
 * específico (`MessageContactAlreadyReachedError`, code
 * `message.contact_already_reached`) e um ProblemDetails que já traz a frase
 * pronta: "Este contato já recebeu (ou está recebendo) esta campanha — reenviar
 * duplicaria a mensagem."
 *
 * A tela descartava o corpo inteiro (`catch { toast.error("literal") }`) e o
 * operador via "Falha ao reenfileirar". É a mesma doença de 2026-08-11 — recusa
 * sem explicação → tentativa às cegas — na MESMA tela, reintroduzida porque o
 * pacote do backend e o do front rodaram sem se ver.
 */
describe("MessagesTable — a recusa do backend chega inteira à tela", () => {
  function kyError(status: number, body: unknown): HTTPError {
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/problem+json" },
    });
    return new HTTPError(
      response as never,
      new Request("http://localhost/campaigns/messages/m/retry") as never,
      {} as never,
    );
  }

  const contatoJaAlcancado = {
    type: "about:blank",
    title: "Conflito",
    status: 409,
    code: "message.contact_already_reached",
    detail:
      "Este contato já recebeu (ou está recebendo) esta campanha — reenviar duplicaria a mensagem.",
  };

  function textoDoToast(): string {
    const [titulo, opts] = toastError.mock.calls[0] as [
      string,
      { description?: string } | undefined,
    ];
    return `${titulo} ${opts?.description ?? ""}`;
  }

  it('"Reenviar": mostra o motivo do backend, não "Falha ao reenfileirar"', async () => {
    const user = userEvent.setup();
    state.items = [msg("FAILED")];
    retryMutate.mockRejectedValue(kyError(409, contatoJaAlcancado));
    render(<MessagesTable campaignId="camp1" />);

    await user.click(screen.getByRole("button", { name: /reenviar/i }));

    expect(toastError).toHaveBeenCalled();
    expect(textoDoToast()).toMatch(
      /já recebeu \(ou está recebendo\) esta campanha/i,
    );
    expect(String(toastError.mock.calls[0][0])).not.toBe(
      "Falha ao reenfileirar",
    );
  });

  it('"Reenviar": para essa recusa, diz também o que fazer (a outra linha do contato)', async () => {
    const user = userEvent.setup();
    state.items = [msg("FAILED")];
    retryMutate.mockRejectedValue(kyError(409, contatoJaAlcancado));
    render(<MessagesTable campaignId="camp1" />);

    await user.click(screen.getByRole("button", { name: /reenviar/i }));

    expect(textoDoToast()).toMatch(/outra linha deste contato/i);
  });

  it('"Disparar novamente": mostra o motivo do backend em vez do palpite da tela', async () => {
    const user = userEvent.setup();
    state.items = [msg("FAILED")];
    redispatchMutate.mockRejectedValue(kyError(409, contatoJaAlcancado));
    render(<MessagesTable campaignId="camp1" />);

    await user.click(
      screen.getByRole("button", {
        name: /disparar novamente para este contato/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Disparar$/ }));

    expect(textoDoToast()).toMatch(
      /já recebeu \(ou está recebendo\) esta campanha/i,
    );
  });

  it("uma recusa que a tela não conhece também sobe com o texto do backend", async () => {
    const user = userEvent.setup();
    state.items = [msg("FAILED")];
    retryMutate.mockRejectedValue(
      kyError(409, {
        title: "Conflito",
        status: 409,
        code: "message.delivery_indeterminate",
        detail:
          "Esta mensagem falhou por timeout/indeterminação — ela PODE ter sido entregue.",
      }),
    );
    render(<MessagesTable campaignId="camp1" />);

    await user.click(screen.getByRole("button", { name: /reenviar/i }));

    expect(textoDoToast()).toMatch(/timeout\/indeterminação/i);
  });
});

/**
 * ★ O BALDE "CANCELADAS" VIROU TRÊS COISAS DIFERENTES — E A TELA MOSTRAVA UMA SÓ.
 *
 * A linha CANCELLED hoje significa pelo menos quatro coisas, cada uma com um
 * `errorCode` próprio gravado pelo backend: o contato pediu para sair
 * (`opted_out`), a campanha foi cancelada com ele ainda na fila
 * (`campaign_cancelled`), a guarda anti-duplicata barrou porque ele já recebeu
 * por outra linha (`duplicate_already_sent`) e a linha era duplicata da mesma
 * campanha para o mesmo contato (`duplicate_row_neutralized`, escrito pela
 * migration). A tabela só mostrava o motivo das linhas FAILED — nas CANCELADAS
 * o operador via o rótulo "Cancelada" e mais nada, e é justamente aí que ele
 * precisa saber se a pessoa recebeu ou não.
 */
describe("MessagesTable — a linha cancelada diz POR QUE foi cancelada", () => {
  it.each([
    ["opted_out", /pediu para sair|opt-out/i],
    ["campaign_cancelled", /campanha foi cancelada/i],
    ["duplicate_already_sent", /já recebeu|outra linha/i],
    ["duplicate_row_neutralized", /duplicada|outra linha/i],
  ])("explica a cancelada com errorCode %s", (code, esperado) => {
    state.items = [msg("CANCELLED", { errorCode: code as string })];
    render(<MessagesTable campaignId="camp1" />);

    expect(screen.getByTestId("cancelled-reason")).toHaveTextContent(
      esperado as RegExp,
    );
  });

  it("um motivo que a tela não conhece continua visível (o código cru, não o silêncio)", () => {
    state.items = [msg("CANCELLED", { errorCode: "motivo_do_futuro" })];
    render(<MessagesTable campaignId="camp1" />);

    expect(screen.getByTestId("cancelled-reason")).toHaveTextContent(
      "motivo_do_futuro",
    );
  });

  it("sem errorCode não inventa motivo nenhum", () => {
    state.items = [msg("CANCELLED", { errorCode: null })];
    render(<MessagesTable campaignId="camp1" />);

    expect(screen.queryByTestId("cancelled-reason")).toBeNull();
  });
});
