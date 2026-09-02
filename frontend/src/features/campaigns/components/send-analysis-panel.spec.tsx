import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SendAnalysisPanel } from "./send-analysis-panel";
import type { SendCheck } from "../schemas";
import * as schemas from "../schemas";

describe("SendAnalysisPanel", () => {
  it("renders one row per check with its message", () => {
    const checks: SendCheck[] = [
      { code: "VOLUME", severity: "info", message: "Vai enviar para 50 números." },
      { code: "OPT_OUT", severity: "info", message: "Opt-out excluído." },
    ];
    render(
      <SendAnalysisPanel
        checks={checks}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByText("Vai enviar para 50 números.")).toBeInTheDocument();
    expect(screen.getByText("Opt-out excluído.")).toBeInTheDocument();
  });

  it("shows the override checkbox only when a block check is present", () => {
    const noBlock: SendCheck[] = [
      { code: "VOLUME", severity: "warn", message: "muitos" },
    ];
    const { rerender } = render(
      <SendAnalysisPanel
        checks={noBlock}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/entendo o risco/i)).not.toBeInTheDocument();

    const withBlock: SendCheck[] = [
      { code: "VOLUME", severity: "block", message: "excede a capacidade" },
    ];
    rerender(
      <SendAnalysisPanel
        checks={withBlock}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/entendo o risco/i)).toBeInTheDocument();
  });

  it("calls onOverrideChange when the override checkbox is toggled", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SendAnalysisPanel
        checks={[{ code: "VOLUME", severity: "block", message: "x" }]}
        override={false}
        onOverrideChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText(/entendo o risco/i));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders the recipient count when provided", () => {
    render(
      <SendAnalysisPanel
        checks={[{ code: "OPT_OUT", severity: "info", message: "x" }]}
        recipients={123}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByText("123")).toBeInTheDocument();
  });

  /**
   * A análise (VOLUME, alcançabilidade, consentimento) é calculada no backend
   * sobre o FilterGroup CRU — sem o limite "os N primeiros" e sem a exclusão
   * "já está em campanha com este template". Quando o recorte tirou gente, os
   * alertas descrevem uma audiência MAIOR do que a que vai existir.
   *
   * O número honesto é o que o próprio preflight mediu (`recipients` da
   * resposta), e não `destinatários + excluídos`: com limite, essa soma é o
   * tamanho da lista JÁ RECORTADA — um número inventado, com cara de precisão,
   * no lugar criado para acabar com números inventados.
   */
  it("diz sobre quantos contatos os alertas foram calculados — o número que o preflight mediu", () => {
    render(
      <SendAnalysisPanel
        checks={[
          { code: "VOLUME", severity: "info", message: "Vai enviar para 13000." },
        ]}
        recipients={500}
        analyzedCount={13000}
        excludedSameTemplate={0}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    const caveat = screen.getByTestId("analysis-audience-caveat");
    // O filtro encontrou 13000 — é sobre ESSES que a análise foi feita.
    expect(caveat).toHaveTextContent(/13000/);
    // E o disparo vai para 500.
    expect(caveat).toHaveTextContent(/500/);
    // Nunca a soma inventada 500 + 0.
    expect(caveat).not.toHaveTextContent(/contatos do filtro, antes da exclusão/i);
  });

  it("avisa também quando o recorte foi só o limite (nenhuma exclusão por template)", () => {
    render(
      <SendAnalysisPanel
        checks={[]}
        recipients={500}
        analyzedCount={13000}
        excludedSameTemplate={0}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByTestId("analysis-audience-caveat")).toBeInTheDocument();
  });

  it("não mostra o aviso quando a análise mediu exatamente a audiência do disparo", () => {
    render(
      <SendAnalysisPanel
        checks={[{ code: "VOLUME", severity: "info", message: "x" }]}
        recipients={88}
        analyzedCount={88}
        excludedSameTemplate={0}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("analysis-audience-caveat")).toBeNull();
  });

  /**
   * Com o painel renderizando sempre (antes ele sumia sem alertas), o texto
   * "preencha o segmento e a conexão" passou a aparecer no passo 4 — onde o
   * segmento e a conexão JÁ estão preenchidos, colado à contagem que prova
   * isso. Ruído que treina o operador a ignorar o painel que carrega o aviso e
   * o "Entendo o risco".
   */
  it("sem alertas, não manda preencher o que já está preenchido", () => {
    render(
      <SendAnalysisPanel
        checks={[]}
        recipients={88}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.queryByText(/preencha o segmento/i)).toBeNull();
    expect(screen.getByText(/nenhum alerta/i)).toBeInTheDocument();
  });

  /**
   * ★ Pedido do cliente 2026-08-25 — a frase abaixo de `excludedSameTemplate`
   * afirmava "este mesmo template" incondicionalmente. Com
   * `excludeAnyPreviousCampaign` ligado isso vira mentira: os excluídos são
   * de QUALQUER campanha anterior, não só do mesmo template.
   */
  it('excludeAnyPreviousCampaign ausente (default false): mantém a frase "este mesmo template"', () => {
    render(
      <SendAnalysisPanel
        checks={[]}
        recipients={88}
        excludedSameTemplate={412}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByText(/este mesmo template/i)).toBeInTheDocument();
    expect(screen.queryByText(/alguma campanha anterior/i)).not.toBeInTheDocument();
  });

  it('excludeAnyPreviousCampaign: true — a frase passa a dizer "alguma campanha anterior"', () => {
    render(
      <SendAnalysisPanel
        checks={[]}
        recipients={88}
        excludedSameTemplate={412}
        excludeAnyPreviousCampaign
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.getByText(/alguma campanha anterior/i)).toBeInTheDocument();
    expect(screen.queryByText(/este mesmo template/i)).not.toBeInTheDocument();
  });

  it('sem ninguém excluído, o texto não muda com excludeAnyPreviousCampaign (nada para condicionar)', () => {
    render(
      <SendAnalysisPanel
        checks={[]}
        recipients={88}
        excludedSameTemplate={0}
        excludeAnyPreviousCampaign
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(screen.queryByText(/campanha anterior/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mesmo template/i)).not.toBeInTheDocument();
  });

  // The panel must delegate the "is there a blocking check?" decision to the
  // single source of truth in ../schemas instead of duplicating the predicate.
  // Spying on the shared function proves the component imports it; if the
  // component still had its own private copy the spy would never fire.
  it("delegates the blocking decision to the shared hasBlockingCheck", () => {
    const spy = vi.spyOn(schemas, "hasBlockingCheck");
    render(
      <SendAnalysisPanel
        checks={[{ code: "VOLUME", severity: "block", message: "x" }]}
        override={false}
        onOverrideChange={() => {}}
      />,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
