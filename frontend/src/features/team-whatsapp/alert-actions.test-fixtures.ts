import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { createElement, type ReactNode } from "react";
import type { PermissionKey } from "@/features/permissions/keys";
import { useAuthStore } from "@/stores/auth.store";

/** Erro HTTP como o ky monta, com o `code` do servidor no corpo (ky 2: `readApiErrorBody` o lê de volta). */
export const httpError = (status: number, code?: string): HTTPError =>
  new HTTPError(
    new Response(JSON.stringify(code ? { code } : {}), { status }),
    new Request("https://x"),
    {} as never,
  );

/** `wrapper` do `render` com o `QueryClient` dado (os specs espiam a invalidação por ele). */
export const clientWrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

/** Entra com um operador que tem só estas permissões. */
export function signInWith(permissions: PermissionKey[]): void {
  useAuthStore.setState({
    user: {
      id: "u1",
      email: "o@x.test",
      name: "Olga",
      role: "OPERATOR",
      permissions,
    },
  });
}

/** O que o servidor devolve ao aceitar um lembrete. */
export const REMINDER_ACCEPTED = { reminderId: "l1", queued: 2 };
