import type { ComponentProps } from "react";

type LinkProps = Omit<ComponentProps<"a">, "href"> & {
  to: string;
  params?: Record<string, string>;
};

/**
 * Substituto do `Link` do TanStack Router nos testes das pendências (sem `RouterProvider`): um `<a>` cujo `href`
 * já traz os parâmetros no lugar de `$nome`. Uso: `vi.mock("@tanstack/react-router", () => import("./pendency.test-router"))`.
 */
export function Link({ to, params, children, ...rest }: LinkProps) {
  const href = to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? "");
  return (
    <a {...rest} href={href}>
      {children}
    </a>
  );
}
