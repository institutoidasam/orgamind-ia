import { useEffect } from 'react';

type PagedList = { total: number; pageSize: number };

/** Se a lista encolheu (cancelamento, disparo, repetição) e a página escolhida passou do fim, volta à última. */
export function useBackToLastPage(page: number, setPage: (page: number) => void, list: PagedList | undefined) {
  const total = list?.total;
  const pageSize = list?.pageSize;
  useEffect(() => {
    if (total === undefined || pageSize === undefined) return;
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (page > last) setPage(last);
  }, [page, setPage, total, pageSize]);
}
