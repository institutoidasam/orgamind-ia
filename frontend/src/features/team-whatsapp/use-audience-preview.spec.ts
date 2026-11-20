import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_RESPONSE } from './audience-preview.test-fixtures';

const { useAudiencePreview } = vi.hoisted(() => ({
  useAudiencePreview: vi.fn(),
}));
vi.mock('./api', () => ({
  useAudiencePreview: (body: unknown) => useAudiencePreview(body),
}));

import { PREVIEW_DEBOUNCE_MS, previewRequest, useDebouncedAudience } from './use-audience-preview';

type Filters = Parameters<typeof useDebouncedAudience>[0];

const FILTERS: Filters = {
  purpose: 'shift_notice',
  base: 'on_duty',
  date: '2026-11-20',
  activity: { date: '', time: '', place: '' },
  sectorIds: ['s1'],
  levelIds: [],
  withoutLevel: false,
  shiftIds: ['sh1'],
  shiftsPicked: true,
  includeOff: false,
  urgencyReason: '',
  selected: new Set<string>(),
};
const DONE = {
  data: PREVIEW_RESPONSE,
  isPlaceholderData: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
};
const lastBody = () =>
  useAudiencePreview.mock.lastCall?.[0] as {
    target: { date: string; userIds?: string[] };
  } | null;

beforeEach(() => {
  vi.useFakeTimers();
  useAudiencePreview.mockReset();
  useAudiencePreview.mockReturnValue(DONE);
});
afterEach(() => vi.useRealTimers());

const setup = () =>
  renderHook(({ filters }) => useDebouncedAudience(filters), {
    initialProps: { filters: FILTERS },
  });

describe('useDebouncedAudience: debounce do pedido', () => {
  it('mudar um filtro pede nova prévia depois de 300 ms; no começo pede na hora', () => {
    const { rerender } = setup();
    expect(lastBody()?.target.date).toBe('2026-11-20');
    rerender({ filters: { ...FILTERS, date: '2026-11-21' } });
    act(() => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    });
    expect(lastBody()?.target.date).toBe('2026-11-20');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(lastBody()?.target.date).toBe('2026-11-21');
  });

  it('várias mudanças seguidas pedem uma prévia só, a da última', () => {
    const { rerender } = setup();
    rerender({ filters: { ...FILTERS, date: '2026-11-21' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ filters: { ...FILTERS, date: '2026-11-22' } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(lastBody()?.target.date).toBe('2026-11-20');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(lastBody()?.target.date).toBe('2026-11-22');
    expect(useAudiencePreview.mock.calls.some(([body]) => body?.target.date === '2026-11-21')).toBe(false);
  });
});

describe('useDebouncedAudience: corpo do pedido', () => {
  it('a seleção vai em userIds ordenados, só quando há gente marcada', () => {
    expect(previewRequest(FILTERS)?.target).not.toHaveProperty('userIds');
    const picked = { ...FILTERS, selected: new Set(['rui', 'ana']) };
    expect(previewRequest(picked)?.target.userIds).toEqual(['ana', 'rui']);
  });

  it('sem setor, turno ou data de referência não pede prévia nem mostra a anterior', () => {
    const { result, rerender } = setup();
    expect(result.current.preview).toBe(PREVIEW_RESPONSE);
    rerender({ filters: { ...FILTERS, shiftsPicked: false } });
    expect(lastBody()).toBeNull();
    expect(result.current.preview).toBeUndefined();
    expect(result.current.isFresh).toBe(false);
  });
});

describe('useDebouncedAudience: isFresh', () => {
  const fresh = (query: object) => {
    useAudiencePreview.mockReturnValue({ ...DONE, ...query });
    return renderHook(() => useDebouncedAudience(FILTERS)).result.current.isFresh;
  };

  it('só vale com a resposta do corpo atual: sem placeholder, sem busca em andamento', () => {
    expect(fresh({})).toBe(true);
    expect(fresh({ isPlaceholderData: true })).toBe(false);
    expect(fresh({ isFetching: true })).toBe(false);
    expect(fresh({ data: undefined })).toBe(false);
  });

  it('durante a espera do debounce a prévia na tela é a antiga: não é fresca', () => {
    const { result, rerender } = renderHook(({ filters }) => useDebouncedAudience(filters), {
      initialProps: { filters: FILTERS },
    });
    expect(result.current.isFresh).toBe(true);
    rerender({ filters: { ...FILTERS, date: '2026-11-21' } });
    expect(result.current.preview).toBe(PREVIEW_RESPONSE);
    expect(result.current.isFresh).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    expect(result.current.isFresh).toBe(true);
  });
});
