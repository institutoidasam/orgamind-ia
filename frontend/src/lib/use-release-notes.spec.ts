import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestRelease } from '@/release-notes';
import { useReleaseNotes, __resetReleaseNotesStoreForTests } from './use-release-notes';

const KEY = 'picoa.lastSeenRelease';

beforeEach(() => {
  // `memoryFallback` é estado de módulo (singleton) — sem resetar, um
  // `markSeen()` de um teste anterior (ex.: "sincroniza outro consumidor
  // independente" abaixo) deixa o teste seguinte pré-satisfeito antes mesmo
  // de exercitar o próprio cenário (achado #2 da revisão final).
  __resetReleaseNotesStoreForTests();
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useReleaseNotes', () => {
  it('hasUnseen é true quando nada foi persistido', () => {
    const { result } = renderHook(() => useReleaseNotes());
    expect(result.current.hasUnseen).toBe(true);
    expect(result.current.latest).toEqual(latestRelease());
  });

  it('hasUnseen é false quando a versão persistida já é a mais nova', () => {
    window.localStorage.setItem(KEY, latestRelease().version);
    const { result } = renderHook(() => useReleaseNotes());
    expect(result.current.hasUnseen).toBe(false);
  });

  it('markSeen grava a versão mais nova e sincroniza outro consumidor independente', () => {
    const a = renderHook(() => useReleaseNotes());
    const b = renderHook(() => useReleaseNotes());
    expect(a.result.current.hasUnseen).toBe(true);
    expect(b.result.current.hasUnseen).toBe(true);

    act(() => a.result.current.markSeen());

    expect(a.result.current.hasUnseen).toBe(false);
    expect(b.result.current.hasUnseen).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe(latestRelease().version);
  });

  it('markSeen não quebra quando localStorage lança, e ainda marca como visto nesta sessão', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    const { result } = renderHook(() => useReleaseNotes());

    expect(() => act(() => result.current.markSeen())).not.toThrow();
    expect(result.current.hasUnseen).toBe(false);
  });

  it('hasUnseen vira false depois de markSeen mesmo quando SÓ o setItem lança (getItem intacto)', () => {
    // Caso real do achado #1: getItem funciona (localStorage disponível para
    // leitura) mas setItem lança (quota, modo privado do Safari, etc.) — sem
    // o fallback em memória tomando precedência, a leitura seguinte volta a
    // consultar o localStorage de verdade, que nunca foi gravado, e
    // `hasUnseen` fica true para sempre.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const { result } = renderHook(() => useReleaseNotes());
    expect(result.current.hasUnseen).toBe(true);

    act(() => result.current.markSeen());

    expect(result.current.hasUnseen).toBe(false);
  });
});
