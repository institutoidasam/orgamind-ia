// theme.spec.tsx
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreTheme, useTheme, useToasterTheme } from './theme';

const KEY = 'picoa-theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  // Reset the module-level store to the (now-empty) persisted value.
  restoreTheme();
});
afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  restoreTheme();
});

describe('useToasterTheme', () => {
  it('returns the persisted light theme (never next-themes "system")', () => {
    window.localStorage.setItem(KEY, 'light');
    const { result } = renderHook(() => useToasterTheme());
    expect(result.current).toBe('light');
  });

  it('returns dark when the app theme is dark', () => {
    window.localStorage.setItem(KEY, 'dark');
    restoreTheme(); // boot-time sync, as the app does on load
    const { result } = renderHook(() => useToasterTheme());
    expect(result.current).toBe('dark');
  });
});

describe('useTheme shared state', () => {
  it('keeps independent consumers in sync so the toast can track app toggles', () => {
    window.localStorage.setItem(KEY, 'light');
    const ctl = renderHook(() => useTheme());
    const toaster = renderHook(() => useToasterTheme());

    expect(ctl.result.current.theme).toBe('light');
    expect(toaster.result.current).toBe('light');

    act(() => ctl.result.current.set('dark'));

    // A second, independently-mounted consumer must observe the change.
    expect(ctl.result.current.theme).toBe('dark');
    expect(toaster.result.current).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle flips between light and dark across consumers', () => {
    window.localStorage.setItem(KEY, 'dark');
    restoreTheme();
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    expect(a.result.current.theme).toBe('dark');
    act(() => a.result.current.toggle());
    expect(a.result.current.theme).toBe('light');
    expect(b.result.current.theme).toBe('light');
  });
});
