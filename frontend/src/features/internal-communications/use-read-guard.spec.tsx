import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReadGuard } from './use-read-guard';

const unread = (id: string, updatedAt = '2026-10-10T10:00:00.000Z') => ({ id, updatedAt, isUnread: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

describe('useReadGuard sem detalhe', () => {
  it('BDD: não confirma nem tenta novamente quando não há detalhe ou a versão já foi lida', () => {
    const markRead = vi.fn();
    const { result, rerender } = renderHook(({ item }) => useReadGuard(item, markRead), { initialProps: { item: undefined as ReturnType<typeof unread> | undefined } });

    expect(result.current).toMatchObject({ error: null, isPending: false });
    act(() => result.current.retry());
    rerender({ item: { ...unread('a'), isUnread: false } });
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe('useReadGuard', () => {
  it('BDD: falha 5xx, informa erro e só confirma a versão após retry manual bem-sucedido', async () => {
    const markRead = vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(undefined);
    const { result, rerender } = renderHook(({ item }) => useReadGuard(item, markRead), { initialProps: { item: unread('a') } });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    rerender({ item: unread('a') });
    expect(markRead).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
    rerender({ item: unread('a') });
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('BDD: não duplica enquanto pending e conserva o retry da seleção atual após falhas fora de ordem', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const fourth = deferred<void>();
    const markRead = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise);
    const { result, rerender } = renderHook(({ item }) => useReadGuard(item, markRead), { initialProps: { item: unread('a') } });

    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    rerender({ item: unread('a') });
    expect(markRead).toHaveBeenCalledTimes(1);
    rerender({ item: unread('b') });
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));

    const bFailure = new Error('B 500');
    await act(async () => { second.reject(bFailure); await Promise.resolve(); });
    expect(result.current.error).toBe(bFailure);
    await act(async () => { first.reject(new Error('A 500')); await Promise.resolve(); });
    expect(result.current.error).toBe(bFailure);
    act(() => result.current.retry());
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(3));
    await act(async () => { third.resolve(); await Promise.resolve(); });
    rerender({ item: unread('b', '2026-10-10T11:00:00.000Z') });
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(4));
  });
});
