import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MessageStatusBadge } from "./message-status-badge";
import type { MessageStatus } from "../schemas";

describe("MessageStatusBadge", () => {
  // Regression: a message parked in WAITING_INSTANCE (instance offline mid-send)
  // used to crash the whole campaign page — STATUS_CONFIG had no such key, so
  // `STATUS_CONFIG[status].description` threw and the global error boundary
  // rendered "Algo deu errado." See campaigns/$campaignId.tsx.
  it("renders WAITING_INSTANCE without throwing", () => {
    render(<MessageStatusBadge status="WAITING_INSTANCE" />);
    expect(screen.getByText("Aguardando conexão")).toBeInTheDocument();
  });

  // A2 — the atomic send claim parks a message in SENDING between the claim
  // and markSent. The frontend must know this enum value or the global error
  // boundary crashes the whole campaign page (same failure mode as
  // WAITING_INSTANCE).
  it("renders SENDING with the 'Enviando' label", () => {
    render(<MessageStatusBadge status="SENDING" />);
    expect(screen.getByText("Enviando")).toBeInTheDocument();
  });

  /**
   * C2 — os status do gate de consentimento (C1) não tinham rótulo: caíam no
   * fallback "Desconhecido". São justamente os dois que EXPLICAM por que uma
   * campanha não enviou — o operador via "Desconhecido" e não sabia se era bug
   * ou regra.
   */
  it("renders SKIPPED_NO_CONSENT como 'Sem consentimento'", () => {
    render(<MessageStatusBadge status="SKIPPED_NO_CONSENT" />);
    expect(screen.getByText("Sem consentimento")).toBeInTheDocument();
    expect(screen.queryByText("Desconhecido")).toBeNull();
  });

  it("renders SKIPPED_SUPPRESSED como 'Suprimido'", () => {
    render(<MessageStatusBadge status="SKIPPED_SUPPRESSED" />);
    expect(screen.getByText("Suprimido")).toBeInTheDocument();
    expect(screen.queryByText("Desconhecido")).toBeNull();
  });

  // Status legado do T8 (gate binário de opt-in): não é mais escrito, mas há
  // linhas históricas — elas também não podem aparecer como "Desconhecido".
  it("renders SKIPPED_NO_OPTIN (legado) com rótulo próprio", () => {
    render(<MessageStatusBadge status="SKIPPED_NO_OPTIN" />);
    expect(screen.getByText(/Sem opt-in/i)).toBeInTheDocument();
    expect(screen.queryByText("Desconhecido")).toBeNull();
  });

  it("renders every known status without throwing", () => {
    const statuses: MessageStatus[] = [
      "QUEUED",
      "WAITING_INSTANCE",
      "SENDING",
      "SENT",
      "DELIVERED",
      "READ",
      "FAILED",
      "CANCELLED",
      "SKIPPED_NO_CONSENT",
      "SKIPPED_SUPPRESSED",
      "SKIPPED_NO_OPTIN",
    ];
    for (const status of statuses) {
      const { unmount } = render(<MessageStatusBadge status={status} />);
      unmount();
    }
  });

  // Belt-and-suspenders: a brand-new backend status the frontend hasn't been
  // taught yet must degrade to a neutral badge, never crash the page.
  it("falls back to a neutral badge for an unknown status", () => {
    render(<MessageStatusBadge status={"SOMETHING_NEW" as MessageStatus} />);
    expect(screen.getByText("Desconhecido")).toBeInTheDocument();
  });
});
