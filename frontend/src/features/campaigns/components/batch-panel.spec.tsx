import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";

import { BatchPanel } from "./batch-panel";
import { FAILURE_REASON_LABELS } from "../schemas";
import type { BatchSummary, CampaignFailureReasonCount } from "../schemas";

const state: {
  summary: BatchSummary | undefined;
  batches: unknown[];
  recipients: { items: unknown[]; total: number };
  // `useCampaignRecipients` usa `placeholderData: (prev) => prev`: ao trocar de
  // aba o `data` ainda é o da aba ANTERIOR por ~1 round-trip, com
  // `status: 'success'` e `isLoading: false`. Só `isPlaceholderData` denuncia.
  recipientsIsPlaceholder: boolean;
  failureReasons: CampaignFailureReasonCount[];
} = {
  summary: undefined,
  batches: [],
  recipients: { items: [], total: 0 },
  recipientsIsPlaceholder: false,
  failureReasons: [],
};

vi.mock("@/features/campaigns/api", () => ({
  useBatchSummary: () => ({ data: state.summary }),
  useCampaignBatches: () => ({ data: state.batches }),
  useCampaignRecipients: () => ({
    data: state.recipients,
    isLoading: false,
    isPlaceholderData: state.recipientsIsPlaceholder,
  }),
  useCampaignFailureReasons: () => ({ data: state.failureReasons }),
}));

const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  total: 120,
  sent: 50,
  pending: 70,
  unreachable: 0,
  failed: 0,
  skipped: 0,
  isMarketing: true,
  status: "RUNNING",
  ...over,
});

/**
 * Achado 5 (Importante, review final) — o FORMULÁRIO de envio ("Enviar agora
 * para [N]" + "Enviar lote") saiu do BatchPanel: era um 2º caminho para a
 * mesma ação do cabeçalho de progresso ("Enviar próximo lote"), sem
 * quota/canal na confirmação. Os testes que exercitavam esse formulário
 * (toast de "0 enfileiradas" explicando o motivo, o campo não se
 * auto-desabilitar, "envia o lote com o tamanho digitado", o aviso "só
 * existem N pendentes", "desabilita quando não há pendentes"/"numa campanha
 * concluída") saíram com ele — a mesma cobertura já existe para a ação real,
 * em `campaign-progress-header.spec.tsx`.
 */
describe("BatchPanel (ZE — campanha em lotes)", () => {
  beforeEach(() => {
    state.summary = summary();
    state.batches = [];
    state.recipients = { items: [], total: 0 };
    state.recipientsIsPlaceholder = false;
    state.failureReasons = [];
  });

  it("mostra os três números que o cliente pediu", () => {
    state.summary = summary({ sent: 51, pending: 69, unreachable: 36 });
    render(<BatchPanel campaignId="c1" />);

    // "Enviados"/"Inalcançáveis" aparecem 2x (o KPI e a aba), por isso getAllBy.
    expect(screen.getAllByText("Enviados").length).toBeGreaterThan(0);
    expect(screen.getByText("Pendentes")).toBeInTheDocument();
    expect(screen.getAllByText("Inalcançáveis").length).toBeGreaterThan(0);

    // Os NÚMEROS são o que importa: 51 enviados · 69 pendentes · 36 inalcançáveis.
    expect(screen.getAllByText("51").length).toBeGreaterThan(0);
    expect(screen.getAllByText("69").length).toBeGreaterThan(0);
    expect(screen.getAllByText("36").length).toBeGreaterThan(0);
    expect(screen.getByText(/de 120 na audiência/)).toBeInTheDocument();
  });

  it("explica em uma linha o que é um inalcançável (marketing desligado)", () => {
    state.summary = summary({ unreachable: 36 });
    render(<BatchPanel campaignId="c1" />);

    expect(
      screen.getByText(/desligaram as mensagens de marketing/i),
    ).toBeInTheDocument();
    // E que UTILITY continua funcionando — é a saída que o operador tem.
    expect(screen.getByText(/UTILITY/)).toBeInTheDocument();
  });

  it("mostra o histórico dos lotes (quando, quantos, resultado)", () => {
    state.batches = [
      {
        id: "b1",
        seq: 1,
        requested: 50,
        queued: 50,
        skipped: 2,
        startedAt: "2026-07-12T13:00:00.000Z",
        finishedAt: "2026-07-12T13:01:00.000Z",
        statusCounts: [
          { status: "DELIVERED", count: 47 },
          { status: "FAILED", count: 3 },
        ],
      },
    ];
    render(<BatchPanel campaignId="c1" />);

    expect(screen.getByText("Lote 1")).toBeInTheDocument();
    expect(
      screen.getByText(/pediu 50 · enfileirou 50 · pulou 2 · entregues 47/),
    ).toBeInTheDocument();
  });

  it("numa campanha UTILITY não trata os inalcançáveis como excluídos", () => {
    state.summary = summary({ isMarketing: false, unreachable: 0 });
    render(<BatchPanel campaignId="c1" />);

    expect(
      screen.getByText(/continuam sendo enviados/i),
    ).toBeInTheDocument();
  });
});

/**
 * GATE SILENCIOSO — o painel dizia "a campanha acabou" enquanto o topo dizia
 * "Em execução", e o número de pulados (que o backend JÁ mandava em
 * `summary.skipped`) não era desenhado em lugar nenhum.
 */
describe("BatchPanel — pulados pelo gate de consentimento", () => {
  beforeEach(() => {
    state.batches = [];
    state.recipients = { items: [], total: 0 };
    state.failureReasons = [];
  });

  it("mostra o contador de pulados (o backend já mandava; a UI descartava)", () => {
    state.summary = summary({ total: 2, sent: 0, pending: 0, skipped: 2 });
    render(<BatchPanel campaignId="c1" />);

    expect(screen.getAllByText(/Pulados/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it('NÃO diz "a campanha acabou" quando o que sobrou foi tudo pulado pelo gate', () => {
    state.summary = summary({ total: 2, sent: 0, pending: 0, skipped: 2 });
    render(<BatchPanel campaignId="c1" />);

    expect(screen.queryByText(/a campanha acabou/i)).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/pulad/i).length,
    ).toBeGreaterThan(0);
  });

  it('tem a aba "Pulados" ao lado das outras três', async () => {
    const user = userEvent.setup();
    state.summary = summary({ total: 2, sent: 0, pending: 0, skipped: 2 });
    state.recipients = {
      items: [
        {
          id: "ct1",
          name: "Maria",
          phoneE164: "+5592991110001",
          marketingUndeliverableAt: null,
          marketingUndeliverableReason: null,
          skipReason: "no_consent",
        },
      ],
      total: 1,
    };
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /Pulados/i }));

    const row = screen.getByText("Maria").closest("li")!;
    // O motivo, POR CONTATO — sem ele o operador não sabe o que fazer.
    expect(row).toHaveTextContent(/sem consentimento para esta finalidade/i);
  });
});

/**
 * F2 — A 5ª ABA: as FALHAS, com o MOTIVO normalizado por destinatário.
 *
 * O backend já entregava as duas peças — o grupo 'failed' de
 * `GET /campaigns/:id/recipients` (com failureReason/errorCode embutidos) e o
 * resumo de `GET /campaigns/:id/failure-reasons` — e a UI não tinha como
 * pedir nenhuma das duas: `RecipientGroup` não conhecia "failed" e o endpoint
 * de resumo não tinha um único consumidor. Sem isso, o operador via "falhas
 * 3" no histórico do lote e não tinha como saber QUEM falhou nem POR QUÊ.
 */
describe("BatchPanel — falhas (F2)", () => {
  const failedRecipient = (over: Record<string, unknown> = {}) => ({
    id: "ct9",
    name: "João",
    phoneE164: "+5592991110009",
    marketingUndeliverableAt: null,
    marketingUndeliverableReason: null,
    failureReason: "CANAL_FORA",
    errorCode: "default_instance_inactive",
    ...over,
  });

  beforeEach(() => {
    state.summary = summary({ total: 10, sent: 7, pending: 0, failed: 3 });
    state.batches = [];
    state.recipients = { items: [], total: 0 };
    state.recipientsIsPlaceholder = false;
    state.failureReasons = [];
  });

  it('tem a aba "Falhas" com o contador do resumo quando ela está FECHADA', () => {
    render(<BatchPanel campaignId="c1" />);

    expect(
      screen.getByRole("button", { name: /falhas/i }),
    ).toHaveTextContent("3");
  });

  // O badge e a lista tinham DENOMINADORES diferentes: o badge vinha de
  // `s.failed` (countOf('FAILED') — MENSAGENS, sem recorte de audiência) e a
  // lista passa por `resolveAudienceWhere` + `{ optedOut: false }` + a exclusão
  // de quem já foi alcançado. 3 falhas em que uma respondeu "SAIR" dava
  // "Falhas 3" com 2 linhas embaixo. O badge da aba ABERTA agora sai do
  // `total` da própria lista — o único número que o operador pode conferir
  // contando as linhas.
  it("com a aba aberta, o badge passa a ser o total da PRÓPRIA lista", async () => {
    const user = userEvent.setup();
    state.recipients = { items: [failedRecipient()], total: 2 };
    render(<BatchPanel campaignId="c1" />);

    // Fechada: número do resumo.
    expect(
      screen.getByRole("button", { name: /falhas/i }),
    ).toHaveTextContent("3");

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    expect(
      screen.getByRole("button", { name: /falhas/i }),
    ).toHaveTextContent("2");
  });

  it("enquanto a lista ainda é a da aba anterior, o badge NÃO usa o total velho", async () => {
    const user = userEvent.setup();
    state.recipients = { items: [], total: 42 };
    state.recipientsIsPlaceholder = true;
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    const tab = screen.getByRole("button", { name: /falhas/i });
    expect(tab).toHaveTextContent("3");
    expect(tab).not.toHaveTextContent("42");
  });

  // REGRESSÃO — ao clicar em "Falhas", o `placeholderData: (prev) => prev`
  // mantém as linhas da aba ANTERIOR (pendentes) por ~1 round-trip, mas
  // `group` já virou "failed": cada contato pendente aparecia rotulado
  // "Motivo não registrado", que se lê como "falhou sem motivo".
  it("não rotula as linhas da aba anterior com motivo de falha", async () => {
    const user = userEvent.setup();
    // Uma linha PENDENTE: veio do grupo anterior, não tem failureReason nenhum.
    state.recipients = {
      items: [
        {
          id: "ct1",
          name: "Maria",
          phoneE164: "+5592991110001",
          marketingUndeliverableAt: null,
          marketingUndeliverableReason: null,
        },
      ],
      total: 1,
    };
    state.recipientsIsPlaceholder = true;
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    const row = screen.getByText("Maria").closest("li")!;
    expect(row).not.toHaveTextContent(/motivo não registrado/i);
  });

  it("mostra o motivo assim que a lista da aba de falhas chega de verdade", async () => {
    const user = userEvent.setup();
    state.recipients = {
      items: [failedRecipient({ failureReason: null, errorCode: null })],
      total: 1,
    };
    state.recipientsIsPlaceholder = false;
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    const row = screen.getByText("João").closest("li")!;
    expect(row).toHaveTextContent(/motivo não registrado/i);
  });

  it("lista quem falhou com o motivo LEGÍVEL, nunca o enum cru", async () => {
    const user = userEvent.setup();
    state.recipients = { items: [failedRecipient()], total: 1 };
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    const row = screen.getByText("João").closest("li")!;
    expect(row).toHaveTextContent(FAILURE_REASON_LABELS.CANAL_FORA);
    // O slug do enum é linguagem de banco — o operador nunca deve vê-lo.
    expect(row).not.toHaveTextContent("CANAL_FORA");
  });

  it("mostra o resumo por motivo (o endpoint /failure-reasons) só na aba de falhas", async () => {
    const user = userEvent.setup();
    state.recipients = { items: [failedRecipient()], total: 1 };
    state.failureReasons = [
      {
        failureReason: "SEM_WHATSAPP",
        count: 2,
        label: FAILURE_REASON_LABELS.SEM_WHATSAPP,
      },
      { failureReason: null, count: 1, label: null },
    ];
    render(<BatchPanel campaignId="c1" />);

    // Na aba padrão (pendentes) o resumo de falhas seria só ruído.
    expect(
      screen.queryByText(
        new RegExp(FAILURE_REASON_LABELS.SEM_WHATSAPP, "i"),
      ),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    expect(
      screen.getByText(
        new RegExp(`${FAILURE_REASON_LABELS.SEM_WHATSAPP}.*2`, "i"),
      ),
    ).toBeInTheDocument();
    // A linha sem motivo gravado (label null) não pode virar "null · 1".
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  it("não quebra no estado vazio (nenhuma falha, nenhum motivo)", async () => {
    const user = userEvent.setup();
    state.summary = summary({ total: 10, sent: 10, pending: 0, failed: 0 });
    state.recipients = { items: [], total: 0 };
    state.failureReasons = [];
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    expect(
      screen.getByText(/nenhum contato neste grupo/i),
    ).toBeInTheDocument();
  });

  it("cai num texto neutro quando a falha não tem motivo normalizado", async () => {
    const user = userEvent.setup();
    state.recipients = {
      items: [failedRecipient({ failureReason: null, errorCode: null })],
      total: 1,
    };
    render(<BatchPanel campaignId="c1" />);

    await user.click(screen.getByRole("button", { name: /falhas/i }));

    const row = screen.getByText("João").closest("li")!;
    expect(row).toHaveTextContent(/motivo não registrado/i);
    expect(row).not.toHaveTextContent(/null|undefined/i);
  });
});
