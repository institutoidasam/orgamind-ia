import type { ReactNode } from "react";

/**
 * Substituto do `Link` do TanStack Router nos testes do panorama (sem `RouterProvider`): um `<a>` cujo
 * `href` mostra o destino e o `search` que o cartão montou. Uso:
 * `vi.mock("@tanstack/react-router", () => import("../panorama.test-router"))`.
 */
export function Link({
  to,
  search,
  children,
}: {
  to: string;
  search?: Record<string, string>;
  children: ReactNode;
}) {
  const query = new URLSearchParams(search).toString();
  return <a href={query ? `${to}?${query}` : to}>{children}</a>;
}
