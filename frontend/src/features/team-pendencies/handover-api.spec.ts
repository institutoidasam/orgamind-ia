import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { httpError } from "./components/pendency.test-support";
import {
  pendencyHandoverSkipText,
  usePendencyHandover,
  usePendencyHandoverList,
  usePendencyHandoverTargets,
} from "./handover-api";

const BASE = "internal/team-whatsapp";
const json = (value: unknown) => ({ json: () => Promise.resolve(value) });
const emptyList = { items: [], total: 0, page: 1, pageSize: 50 };

let qc: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: qc }, children);

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe("handover-api: usePendencyHandover, tudo pulado", () => {
  it("tudo pulado: sem toast de sucesso, invalida", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    post.mockReturnValue(
      json({
        transferred: [],
        skipped: [
          { id: "r1", reason: "acked" },
          { id: "r2", reason: "closed" },
        ],
      }),
    );
    const { result } = renderHook(() => usePendencyHandover(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.skipped).toHaveLength(2);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["team-pendencies"] });
  });
});

describe("handover-api: leituras (DT4)", () => {
  it("lista própria e de outro — parâmetros de DT4", async () => {
    get.mockReturnValue(json(emptyList));
    const own = renderHook(() => usePendencyHandoverList("u-me", true, true), {
      wrapper,
    });
    await waitFor(() => expect(own.result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenLastCalledWith(`${BASE}/pendencies`, {
      searchParams: {
        situations: "IN_PROGRESS,OVERDUE",
        handlerId: "u-me",
        pageSize: 50,
      },
    });
    const other = renderHook(
      () => usePendencyHandoverList("u-x", false, true),
      {
        wrapper,
      },
    );
    await waitFor(() => expect(other.result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenLastCalledWith(`${BASE}/pendencies`, {
      searchParams: {
        situations: "UNASSIGNED,IN_PROGRESS,OVERDUE",
        handlerId: "u-x",
        pageSize: 50,
      },
    });
  });

  it("destinos com fromUserId; desligado não consulta", async () => {
    get.mockReturnValue(json({ items: [{ id: "u2", name: "Ana" }] }));
    const off = renderHook(() => usePendencyHandoverTargets("u1", false), {
      wrapper,
    });
    expect(off.result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();
    const on = renderHook(() => usePendencyHandoverTargets("u1", true), {
      wrapper,
    });
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(`${BASE}/pendency-handover/targets`, {
      searchParams: { fromUserId: "u1" },
    });
    expect(on.result.current.data?.items).toEqual([{ id: "u2", name: "Ana" }]);
  });
});

describe("handover-api: textos (DT9)", () => {
  it("pendencyHandoverSkipText — os seis motivos, already_with_target com o nome do destino", () => {
    const text = (reason: string) => pendencyHandoverSkipText(reason, "Ana");
    expect(text("out_of_scope_target")).toBe("fora do alcance do destino");
    expect(text("already_with_target")).toBe("já estava com Ana");
    expect(text("other_handler")).toBe("já com outro responsável");
    expect(text("acked")).toBe("já ciente");
    expect(text("closed")).toBe("já encerrada");
    expect(text("not_found")).toBe("não encontrada");
    expect(text("motivo-novo")).toBe("não foi passada");
  });
});

const vars = {
  toUserId: "u2",
  toName: "Ana",
  note: "Fim do turno",
  pendencyIds: ["r1", "r2"],
};

describe("handover-api: usePendencyHandover", () => {
  it("sucesso — toast singular/plural e invalida team-pendencies", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    post.mockReturnValue(
      json({
        transferred: [{ id: "r1" }],
        skipped: [{ id: "r2", reason: "acked" }],
      }),
    );
    const { result } = renderHook(() => usePendencyHandover(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars);
    });
    expect(post).toHaveBeenCalledWith(`${BASE}/pendency-handover`, {
      json: { toUserId: "u2", note: "Fim do turno", pendencyIds: ["r1", "r2"] },
    });
    expect(toastSuccess).toHaveBeenLastCalledWith(
      "1 pendência passada para Ana.",
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["team-pendencies"] });
    post.mockReturnValue(
      json({ transferred: [{ id: "r1" }, { id: "r2" }], skipped: [] }),
    );
    await act(async () => {
      await result.current.mutateAsync({ ...vars, fromUserId: "u-x" });
    });
    expect(post).toHaveBeenLastCalledWith(`${BASE}/pendency-handover`, {
      json: {
        toUserId: "u2",
        fromUserId: "u-x",
        note: "Fim do turno",
        pendencyIds: ["r1", "r2"],
      },
    });
    expect(toastSuccess).toHaveBeenLastCalledWith(
      "2 pendências passadas para Ana.",
    );
  });
});

describe("handover-api: usePendencyHandover, erros", () => {
  it.each([
    [
      404,
      "user.not_found",
      "Esta pessoa não pode receber as pendências. Escolha outra.",
    ],
    [
      403,
      "team_whatsapp.not_handler",
      "Só um administrador pode passar as pendências de outra pessoa.",
    ],
    [
      403,
      "team_whatsapp.forbidden",
      "Você não tem permissão para passar pendências. Fale com um administrador.",
    ],
    [
      403,
      "auth.permission_denied",
      "Você não tem permissão para passar pendências. Fale com um administrador.",
    ],
    [500, "outro", "Não foi possível passar o turno. Tente de novo."],
  ])("erro %i %s — textos de DT9", async (status, code, text) => {
    post.mockImplementation(() => {
      throw httpError({ code }, status);
    });
    const { result } = renderHook(() => usePendencyHandover(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars).catch(() => undefined);
    });
    expect(toastError).toHaveBeenCalledWith(text);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
