import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HTTPError } from "ky";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import {
  DEFAULT_PENDENCY_FILTERS,
  PENDENCIES_KEY,
  type PendencyFilters,
  usePendencyAction,
  usePendencyCount,
  usePendencyHandlers,
  usePendencyList,
} from "./api";

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: "HTTPError",
    message: `status ${status}`,
    data: body,
    response: { status },
  });
  return err;
}
const json = (value: unknown) => ({ json: () => Promise.resolve(value) });
const emptyList = { items: [], total: 0, page: 1, pageSize: 20 };
const forbidden = httpError({ code: "team_whatsapp.forbidden" }, 403);

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
  get.mockReset();
  post.mockReset();
  toastError.mockClear();
  toastSuccess.mockClear();
});
afterEach(() => focusManager.setFocused(undefined));

describe("lista: consulta", () => {
  it("lista serializa situations, sectorId, mine, days e page", async () => {
    get.mockReturnValue(json(emptyList));
    const filters: PendencyFilters = {
      situations: ["ACKED", "CLOSED"],
      sectorId: "s1",
      mine: true,
      days: 30,
      page: 2,
    };
    const { result } = renderHook(() => usePendencyList(filters, true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("internal/team-whatsapp/pendencies", {
      searchParams: {
        situations: "ACKED,CLOSED",
        sectorId: "s1",
        mine: "true",
        days: 30,
        page: 2,
      },
    });
  });

  it("filtros padrão — as três abertas, sem setor nem mine; desabilitada não busca", async () => {
    get.mockReturnValue(json(emptyList));
    const off = renderHook(
      () => usePendencyList(DEFAULT_PENDENCY_FILTERS, false),
      { wrapper: wrapper(qc) },
    );
    expect(off.result.current.fetchStatus).toBe("idle");
    const on = renderHook(
      () => usePendencyList(DEFAULT_PENDENCY_FILTERS, true),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(get.mock.calls[0][1]).toEqual({
      searchParams: {
        situations: "UNASSIGNED,IN_PROGRESS,OVERDUE",
        days: 7,
        page: 1,
      },
    });
  });
});

describe("lista, contador e destinos: 403 e destinos", () => {
  it("403 team_whatsapp.forbidden — lista e contador resolvem null; outro 403 é erro", async () => {
    get.mockReturnValue({ json: () => Promise.reject(forbidden) });
    const list = renderHook(
      () => usePendencyList(DEFAULT_PENDENCY_FILTERS, true),
      { wrapper: wrapper(qc) },
    );
    const count = renderHook(() => usePendencyCount(true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() =>
      expect(
        list.result.current.isSuccess && count.result.current.isSuccess,
      ).toBe(true),
    );
    expect(list.result.current.data).toBeNull();
    expect(count.result.current.data).toBeNull();

    const other = new QueryClient();
    get.mockReturnValue({
      json: () =>
        Promise.reject(httpError({ code: "auth.permission_denied" }, 403)),
    });
    const denied = renderHook(
      () => usePendencyList(DEFAULT_PENDENCY_FILTERS, true),
      { wrapper: wrapper(other) },
    );
    await waitFor(() => expect(denied.result.current.isError).toBe(true));
  });

  it("destinos de Transferir — busca pendencies/:id/handlers só com enabled", async () => {
    get.mockReturnValue(json({ items: [{ id: "u1", name: "Ana" }] }));
    renderHook(() => usePendencyHandlers("r1", false), {
      wrapper: wrapper(qc),
    });
    expect(get).not.toHaveBeenCalled();
    const { result } = renderHook(() => usePendencyHandlers("r1", true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      "internal/team-whatsapp/pendencies/r1/handlers",
    );
    expect(result.current.data?.items).toEqual([{ id: "u1", name: "Ana" }]);
  });
});

describe("contador do menu", () => {
  it("devolve o número e não relê por foco, mesmo marcado como velho", async () => {
    get.mockReturnValue(json({ unassignedOverdue: 3 }));
    const { result } = renderHook(() => usePendencyCount(true), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.data).toBe(3));
    expect(get).toHaveBeenCalledWith("internal/team-whatsapp/pendency-count");

    await qc.invalidateQueries({
      queryKey: PENDENCIES_KEY,
      refetchType: "none",
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

const seed = () => {
  qc.setQueryData([...PENDENCIES_KEY, "list", {}], emptyList);
  qc.setQueryData([...PENDENCIES_KEY, "count"], 2);
};
const stale = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated;

describe("ação sobre a pendência: sucesso", () => {
  it.each([
    [
      { kind: "assume", expectedHandlerId: null, note: "ok" },
      "assume",
      "Pendência assumida",
    ],
    [
      { kind: "transfer", toUserId: "u2", expectedHandlerId: "u1" },
      "transfer",
      "Pendência transferida",
    ],
    [
      { kind: "note", expectedHandlerId: "u1", text: "Liguei" },
      "notes",
      "Contato registrado",
    ],
    [
      { kind: "close", expectedHandlerId: "u1", reason: "Sem retorno" },
      "close",
      "Pendência encerrada",
    ],
    [
      { kind: "reopen", expectedHandlerId: "u1" },
      "reopen",
      "Tratativa reaberta",
    ],
  ] as const)(
    "sucesso %# — POST %s, toast e invalida team-pendencies",
    async (input, path, text) => {
      post.mockResolvedValue(undefined);
      seed();
      const { result } = renderHook(() => usePendencyAction("r1"), {
        wrapper: wrapper(qc),
      });
      await act(() => result.current.mutateAsync(input));
      const body = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "kind"),
      );
      expect(post).toHaveBeenCalledWith(
        `internal/team-whatsapp/pendencies/r1/${path}`,
        { json: body },
      );
      expect(toastSuccess).toHaveBeenCalledWith(text);
      expect(stale([...PENDENCIES_KEY, "list", {}])).toBe(true);
      expect(stale([...PENDENCIES_KEY, "count"])).toBe(true);
    },
  );
});

describe("ação sobre a pendência: erro", () => {
  it("409 pendency_taken — toast do code com o nome e invalida", async () => {
    const detail = JSON.stringify({ handler: { id: "u2", name: "Ana" } });
    post.mockRejectedValue(
      httpError({ code: "team_whatsapp.pendency_taken", detail }, 409),
    );
    seed();
    const { result } = renderHook(() => usePendencyAction("r1"), {
      wrapper: wrapper(qc),
    });
    await act(() =>
      result.current
        .mutateAsync({ kind: "assume", expectedHandlerId: null })
        .catch(() => undefined),
    );
    expect(toastError).toHaveBeenCalledWith(
      "Ana assumiu esta pendência antes de você.",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(stale([...PENDENCIES_KEY, "count"])).toBe(true);
  });

  it("erro sem recarga (500) — toast genérico e nada invalidado", async () => {
    post.mockRejectedValue(httpError({ code: "internal.error" }, 500));
    seed();
    const { result } = renderHook(() => usePendencyAction("r1"), {
      wrapper: wrapper(qc),
    });
    await act(() =>
      result.current
        .mutateAsync({ kind: "reopen", expectedHandlerId: null })
        .catch(() => undefined),
    );
    expect(toastError).toHaveBeenCalledWith(
      "Não foi possível concluir a ação. Tente de novo.",
    );
    expect(stale([...PENDENCIES_KEY, "list", {}])).toBe(false);
  });
});
