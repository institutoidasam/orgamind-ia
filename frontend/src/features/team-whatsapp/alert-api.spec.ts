import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...a: unknown[]) => get(...a) },
}));

import {
  alertPanelKey,
  useAlertNow,
  useAlertPanel,
  useAlertView,
} from "./alert-api";
import { alertPanel, alertPerson, minutesAfter } from "./alert.test-fixtures";

const pending = alertPanel({
  counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 0 },
  people: [alertPerson()],
});
const done = alertPanel({
  counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 1 },
});
const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
const intervalOf = (qc: QueryClient) => {
  const query = qc.getQueryCache().find({ queryKey: alertPanelKey("d1") });
  return (query?.options.refetchInterval as (q: unknown) => number | false)(
    query,
  );
};

beforeEach(() => {
  get.mockReset();
  // Só o Date: o `waitFor` do Testing Library vive de setInterval.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minutesAfter(3));
});
afterEach(() => vi.useRealTimers());

describe("alert-api: painel do alerta", () => {
  it("busca a rota do painel, relê a cada 10 s com pendência e para sem pendência", async () => {
    get.mockReturnValue({ json: () => Promise.resolve(pending) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useAlertPanel("d1", true), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.data?.people).toHaveLength(1));
    expect(get).toHaveBeenCalledWith(
      "internal/team-whatsapp/dispatches/d1/alert",
    );
    expect(intervalOf(qc)).toBe(10_000);
    qc.setQueryData(alertPanelKey("d1"), done);
    expect(intervalOf(qc)).toBe(false);
  });

  it("enabled falso não busca (envio que não é alerta)", () => {
    renderHook(() => useAlertPanel("d1", false), {
      wrapper: wrap(new QueryClient()),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("useAlertView: o mapa de rótulos sai do painel com o relógio da tela", async () => {
    get.mockReturnValue({ json: () => Promise.resolve(pending) });
    const { result } = renderHook(() => useAlertView("d1"), {
      wrapper: wrap(new QueryClient()),
    });
    expect(result.current.ackLabels.size).toBe(0);
    await waitFor(() =>
      expect(result.current.ackLabels.get("r1")).toBe("Pendente · há 3 min"),
    );
  });
});

describe("alert-api: relógio da tela", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(minutesAfter(3));
  });

  it("renova a cada 10 s enquanto há pendência", () => {
    const { result } = renderHook(() => useAlertNow(pending));
    expect(result.current.getTime()).toBe(minutesAfter(3).getTime());
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.getTime()).toBe(minutesAfter(3, 10).getTime());
  });

  it("sem painel, ou sem pendência e depois do prazo, não mantém relógio", () => {
    vi.setSystemTime(minutesAfter(20));
    renderHook(() => useAlertNow(undefined));
    renderHook(() => useAlertNow(done));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sem pendência mas antes do prazo ainda conta, para virar vencido", () => {
    renderHook(() => useAlertNow(done));
    expect(vi.getTimerCount()).toBe(1);
  });
});
