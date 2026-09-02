import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const getSpy = vi.fn(() => ({
  json: () => Promise.resolve({ checked: 0, unvalidated: 0 }),
}));

vi.mock('@/lib/api-client', () => ({
  api: { get: (...args: unknown[]) => getSpy(...args) },
}));

import * as contactsApi from './api';
import { buildExportSearchParams, useSyncProgress } from './api';

// O fluxo síncrono "Validar WhatsApp" (POST /contacts/validate-whatsapp) foi
// removido em favor do fluxo em fila (useSyncContacts → POST /contacts/sync),
// que cobre o mesmo caso de uso sem o risco de timeout. Este teste impede o
// hook antigo de voltar.
describe('contacts api', () => {
  it('não exporta mais useValidateWhatsapp', () => {
    expect('useValidateWhatsapp' in contactsApi).toBe(false);
  });

  it('mantém useSyncContacts (botão "Sincronizar status")', () => {
    expect(typeof contactsApi.useSyncContacts).toBe('function');
  });
});

describe('buildExportSearchParams (B.3)', () => {
  it('leva os filtros da tela e DESCARTA a paginação', () => {
    expect(
      buildExportSearchParams({
        page: 3,
        pageSize: 50,
        search: 'ana',
        validity: 'invalid',
        city: 'Manaus',
      }),
    ).toEqual({ search: 'ana', validity: 'invalid', city: 'Manaus' });
  });

  // `?city=` não é "cidade vazia": é ausência de filtro. Mandar a chave vazia
  // faria a planilha e a tela discordarem no primeiro filtro limpo.
  it('descarta undefined e string vazia', () => {
    expect(
      buildExportSearchParams({
        page: 1,
        pageSize: 50,
        search: undefined,
        city: '',
      } as never),
    ).toEqual({});
  });

  it('serializa booleano como texto (optedOut=false precisa sobreviver)', () => {
    expect(
      buildExportSearchParams({ page: 1, pageSize: 50, optedOut: false } as never),
    ).toEqual({ optedOut: 'false' });
  });
});

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

/**
 * Mesmo helper de `campaigns/api.spec.ts` — resolve `refetchInterval`
 * (estático ou em forma de função) para o valor efetivo da PRIMEIRA query
 * registrada no cache.
 */
function resolvedRefetchInterval(qc: QueryClient): number | false {
  const entry = qc.getQueryCache().getAll()[0];
  const ri = entry?.options.refetchInterval as
    | number
    | false
    | ((q: unknown) => number | false)
    | undefined;
  const value = typeof ri === 'function' ? ri(entry) : ri;
  return value ?? false;
}

// Importante 3 (revisão) — o diálogo "Sincronizar status" fica SEMPRE
// montado (o `open` do Radix só o esconde visualmente), então sem estas três
// travas o polling de 5s de `useSyncProgress` nunca pararia sozinho.
describe('useSyncProgress polling (Importante 3)', () => {
  it('para de repetir quando checked >= total (a rodada terminou)', () => {
    const qc = new QueryClient();
    qc.setQueryData(['contact-sync-progress', 'S'], {
      checked: 120,
      unvalidated: 0,
    });
    renderHook(
      () => useSyncProgress({ since: 'S', total: 120, enabled: true }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(false);
  });

  it('continua repetindo a cada 5s enquanto checked < total', () => {
    const qc = new QueryClient();
    qc.setQueryData(['contact-sync-progress', 'S'], {
      checked: 30,
      unvalidated: 90,
    });
    renderHook(
      () => useSyncProgress({ since: 'S', total: 120, enabled: true }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(5_000);
  });

  it('para quando a query está em erro (não martela um endpoint falhando)', async () => {
    getSpy.mockImplementationOnce(() => ({
      json: () => Promise.reject(new Error('boom')),
    }));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useSyncProgress({ since: 'S', total: 120, enabled: true }),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(resolvedRefetchInterval(qc)).toBe(false);
  });

  it('não consulta nem repete quando enabled=false (diálogo fechado ou sem rodada em curso)', () => {
    getSpy.mockClear();
    const qc = new QueryClient();
    renderHook(
      () => useSyncProgress({ since: null, total: 0, enabled: false }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
