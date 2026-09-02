import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import React from 'react';

// useProviderInfo fails OPEN by design: `undefined` is the signal every gate
// (message-composer, conversations-list, whatsapp-status-indicator) reads as
// "don't restrict yet". That means a broken selector here — wrong field
// name, wrong comparison, a `find` that never matches — would silently make
// EVERY gate permissive for EVERY provider, including META, and nothing in
// the composer/list specs would catch it (they all mock this hook directly).
// This file exercises the hook's own lookup logic in isolation.
vi.mock('@/lib/api-client', () => ({
  // Only hit when the cache has no data yet (see the last test below) — a
  // promise that never resolves is enough to keep `data` undefined for the
  // synchronous assertion, without a real network call.
  api: { get: () => ({ json: () => new Promise(() => {}) }) },
}));

import { useProviderInfo, type ProvidersResponse } from './api';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

// EVOLUTION and TWILIO carry deliberately DIFFERENT traits AND DIFFERENT
// capabilities — if the lookup compared the wrong field, or returned
// providers[0] regardless of which provider was asked for, this fixture is
// shaped so that mistake surfaces as a wrong-value assertion failure, not an
// accidental pass.
const RESPONSE: ProvidersResponse = {
  providers: [
    {
      provider: 'EVOLUTION',
      traits: { official: false, sessionBased: true, sessionWindow: false },
      capabilities: ['campaignSend'],
      channels: [],
    },
    {
      provider: 'TWILIO',
      traits: { official: true, sessionBased: false, sessionWindow: true },
      capabilities: ['campaignSend', 'chatMedia'],
      channels: [],
    },
  ],
};

function seededClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['whatsapp', 'providers'], RESPONSE);
  return qc;
}

describe('useProviderInfo', () => {
  it('returns the traits AND capabilities of the matching provider — not another provider\'s', () => {
    const qc = seededClient();

    const evolution = renderHook(() => useProviderInfo('EVOLUTION'), { wrapper: wrapper(qc) });
    expect(evolution.result.current).toEqual({
      traits: { official: false, sessionBased: true, sessionWindow: false },
      capabilities: ['campaignSend'],
    });

    const twilio = renderHook(() => useProviderInfo('TWILIO'), { wrapper: wrapper(qc) });
    expect(twilio.result.current).toEqual({
      traits: { official: true, sessionBased: false, sessionWindow: true },
      capabilities: ['campaignSend', 'chatMedia'],
    });
  });

  it('returns undefined for a provider not present in the loaded response', () => {
    const qc = seededClient();
    const { result } = renderHook(() => useProviderInfo('META'), { wrapper: wrapper(qc) });
    expect(result.current).toBeUndefined();
  });

  it('returns undefined when provider is undefined', () => {
    const qc = seededClient();
    const { result } = renderHook(() => useProviderInfo(undefined), { wrapper: wrapper(qc) });
    expect(result.current).toBeUndefined();
  });

  it('returns undefined while the providers query has no data yet (still loading)', () => {
    // No setQueryData — cache starts empty, matching the pre-fetch state
    // every gate must treat as "don't restrict" (fail-safe direction, Task 5).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProviderInfo('EVOLUTION'), { wrapper: wrapper(qc) });
    expect(result.current).toBeUndefined();
  });
});
