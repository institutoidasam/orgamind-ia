import { describe, it, expect, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (opts: Record<string, unknown>) => ({ __redirect: opts }),
}));

import { Route } from './disparos';

/**
 * /disparos foi fundido em /campanhas — a página morreu, mas o ENDEREÇO não
 * pode: link salvo, aba fixada e memória muscular cairiam num 404. O teste
 * garante que a rota sobrevive exclusivamente como redirect.
 */
describe('/disparos após a fusão com /campanhas', () => {
  it('redireciona para /campaigns em vez de renderizar página', () => {
    const route = Route as unknown as {
      component?: unknown;
      beforeLoad: () => void;
    };

    // Não há mais componente: a rota é SÓ o redirect.
    expect(route.component).toBeUndefined();

    let thrown: unknown;
    try {
      route.beforeLoad();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ __redirect: { to: '/campaigns' } });
  });
});
