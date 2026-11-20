import { useEffect, useMemo, useState } from 'react';
import { useAudiencePreview } from './api';
import type { TeamAudienceRequest } from './schemas';
import { audienceRequest, type SendFilters } from './use-send-filters';

/** Espera depois da última mudança de filtro ou de seleção antes de pedir a prévia (F1). */
export const PREVIEW_DEBOUNCE_MS = 300;

type AudienceFilters = Parameters<typeof audienceRequest>[0] & Pick<SendFilters, 'selected'>;

/**
 * Corpo da prévia da tela: os filtros e, só com gente marcada, a seleção nominal. Os ids vão ordenados para a
 * chave da consulta não depender da ordem dos cliques. Sem ninguém marcado a prévia traz todos os candidatos.
 */
export function previewRequest(filters: AudienceFilters): TeamAudienceRequest | null {
  const body = audienceRequest(filters);
  if (!body || filters.selected.size === 0) return body;
  return {
    ...body,
    target: { ...body.target, userIds: [...filters.selected].sort() },
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Prévia do servidor para os filtros e a seleção da tela, pedida `PREVIEW_DEBOUNCE_MS` depois da última mudança.
 * `isFresh` = a resposta é do corpo atual: nenhuma espera do debounce, nenhuma busca em andamento e nenhum
 * `placeholderData` (a prévia anterior que a consulta mantém enquanto a nova não chega). Só com `isFresh` o
 * operador confirma o que vê; sem ela a lista continua na tela, mas os botões de enviar ficam travados.
 */
export function useDebouncedAudience(filters: AudienceFilters) {
  const request = previewRequest(filters);
  const key = JSON.stringify(request);
  const settledKey = useDebouncedValue(key, PREVIEW_DEBOUNCE_MS);
  const settled = useMemo<TeamAudienceRequest | null>(
    () => JSON.parse(settledKey) as TeamAudienceRequest | null,
    [settledKey],
  );
  const query = useAudiencePreview(request === null ? null : settled);
  const waiting = settledKey !== key;
  return {
    preview: request === null ? undefined : query.data,
    isFresh: request !== null && !waiting && query.data !== undefined && !query.isPlaceholderData && !query.isFetching,
    error: waiting ? null : query.error,
    refetch: query.refetch,
  };
}
