import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { HTTPError } from "ky";
import { createElement, type ReactElement } from "react";
import type { PermissionKey } from "@/features/permissions/keys";
import { useAuthStore, type AuthUser } from "@/stores/auth.store";

export const PANORAMA_URL = "internal/team-whatsapp/panorama";

/** Resposta do `api.get(...)` falso com corpo JSON. */
export const jsonOf = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

/** `HTTPError` com `code` no corpo, como o servidor responde. */
export function httpError(status: number, code: string): HTTPError {
  const response = new Response(JSON.stringify({ code }), { status });
  return new HTTPError(response, new Request("https://x"), {} as never);
}

/** Resposta do `api.get(...)` falso que recusa com `HTTPError`. */
export const failWith = (status: number, code: string) => ({
  json: () => Promise.reject(httpError(status, code)),
});

/** `permissions` omitido = o padrão do papel; lista dada (até vazia) = só essas, como o `/auth/me` devolve. */
export function asRole(
  role: AuthUser["role"],
  permissions?: PermissionKey[],
): void {
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.c", name: "A", role, permissions },
  });
}

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient();
  return {
    client,
    ...render(createElement(QueryClientProvider, { client }, ui)),
  };
}
