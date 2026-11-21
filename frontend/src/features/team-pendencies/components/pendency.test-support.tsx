import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { HTTPError } from "ky";
import type { ReactElement } from "react";
import { vi } from "vitest";

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
export function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: "HTTPError",
    message: `status ${status}`,
    data: body,
    response: { status },
  });
  return err;
}

/** Monta `ui` com um `QueryClient` de teste (sem retentativa); devolve o cliente para espiar as invalidações. */
export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
  return { qc, invalidate, ...view };
}
