import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { filenameFromDisposition, saveBlob } from '@/features/people-export/download';
import {
  batchListSchema,
  batchSummarySchema,
  rowsPageSchema,
  type BatchSummary,
  type ColumnMapping,
  type RowClass,
} from './schemas';

const PREFIX = 'internal/people-import';
const ROOT_KEY = 'people-import';

/** Tamanho máximo do arquivo enviado (o backend recusa acima disso com `file_too_large`). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Envio, remapeamento, confirmação e bloco de gravação levam mais que os 15 s padrão do cliente (EX34). */
const IMPORT_TIMEOUT_MS = 120_000;

/**
 * Os POST do lote (envio, confirmação, bloco de gravação, encerramento) nunca se repetem sozinhos:
 * repetir enviaria o arquivo duas vezes ou gravaria o mesmo bloco em dobro. O usuário tenta de novo pelo botão.
 */
const POST_RETRY = 0;

/**
 * Corpo da confirmação. `mapping` é o do resumo que a prévia está mostrando: se outra aba
 * remapeou depois, o servidor recusa com 409 `preview_changed` em vez de gravar outra prévia.
 */
export type ConfirmSelection = {
  createNew: boolean;
  updateExisting: boolean;
  excludedRows: number[];
  mapping: ColumnMapping;
};

const batchPath = (id: string) => `${PREFIX}/batches/${id}`;
const batchKey = (id: string) => [ROOT_KEY, 'batch', id] as const;

function parseSummary(data: unknown): BatchSummary {
  return batchSummarySchema.parse(data);
}

/**
 * Resumo novo na cache; lista e linhas do lote ficam velhas (a classificação e a situação mudaram).
 * As linhas só existem na prévia: fora dela o `GET .../rows` responde 409 `not_preview`, então
 * confirmar ou encerrar não as relê (a tabela da prévia ainda está montada quando o resumo chega).
 */
function syncBatch(client: QueryClient, summary: BatchSummary): BatchSummary {
  client.setQueryData(batchKey(summary.id), summary);
  void client.invalidateQueries({ queryKey: [ROOT_KEY, 'batches'] });
  if (summary.situation === 'PREVIEW') {
    void client.invalidateQueries({ queryKey: [ROOT_KEY, 'rows', summary.id] });
  }
  return summary;
}

/** A prévia mudou no servidor: o resumo e as linhas do lote ficam velhos e a tela os relê. */
export function invalidateBatchPreview(client: QueryClient, id: string): void {
  void client.invalidateQueries({ queryKey: batchKey(id) });
  void client.invalidateQueries({ queryKey: [ROOT_KEY, 'rows', id] });
}

/** Histórico de lotes (`GET .../batches?page=`), mais recentes primeiro. */
export function useImportBatches(page: number) {
  return useQuery({
    queryKey: [ROOT_KEY, 'batches', page],
    queryFn: () =>
      api
        .get(`${PREFIX}/batches`, { searchParams: { page } })
        .json()
        .then((data) => batchListSchema.parse(data)),
    placeholderData: keepPreviousData,
  });
}

export function useImportBatch(id: string | undefined) {
  return useQuery({
    queryKey: batchKey(id ?? ''),
    queryFn: () =>
      api
        .get(batchPath(id ?? ''))
        .json()
        .then(parseSummary),
    enabled: Boolean(id),
  });
}

/** Linhas da prévia (`GET .../rows`), 50 por página, filtráveis por classificação. */
export function useImportRows(id: string, page: number, classification?: RowClass) {
  return useQuery({
    queryKey: [ROOT_KEY, 'rows', id, page, classification ?? null],
    queryFn: () =>
      api
        .get(`${batchPath(id)}/rows`, {
          searchParams: { page, ...(classification ? { classification } : {}) },
        })
        .json()
        .then((data) => rowsPageSchema.parse(data)),
    placeholderData: keepPreviousData,
  });
}

/** `multipart/form-data` com o campo `file`; o `Content-Type` com o boundary é do navegador. */
export function useUploadImport() {
  const client = useQueryClient();
  return useMutation<BatchSummary, unknown, File>({
    mutationFn: (file) => {
      const body = new FormData();
      body.append('file', file);
      return api
        .post(`${PREFIX}/batches`, { body, timeout: IMPORT_TIMEOUT_MS, retry: POST_RETRY })
        .json()
        .then(parseSummary);
    },
    onSuccess: (summary) => syncBatch(client, summary),
  });
}

export function useRemapImport(id: string) {
  const client = useQueryClient();
  return useMutation<BatchSummary, unknown, ColumnMapping>({
    mutationFn: (mapping) =>
      api
        .put(`${batchPath(id)}/mapping`, {
          json: { mapping },
          timeout: IMPORT_TIMEOUT_MS,
        })
        .json()
        .then(parseSummary),
    onSuccess: (summary) => syncBatch(client, summary),
  });
}

export function useConfirmImport(id: string) {
  const client = useQueryClient();
  return useMutation<BatchSummary, unknown, ConfirmSelection>({
    mutationFn: ({ createNew, updateExisting, excludedRows, mapping }) =>
      api
        .post(`${batchPath(id)}/confirm`, {
          json: { createNew, updateExisting, excludedRows, mapping },
          timeout: IMPORT_TIMEOUT_MS,
          retry: POST_RETRY,
        })
        .json()
        .then(parseSummary),
    onSuccess: (summary) => syncBatch(client, summary),
  });
}

/**
 * Um bloco da gravação (`POST .../write`). Fora do TanStack Query: o laço da tela (EX34)
 * decide o que fazer com timeout, 429 e 409, e lê o erro por `readApiErrorBody`.
 */
export function writeBlock(id: string): Promise<BatchSummary> {
  return api
    .post(`${batchPath(id)}/write`, { timeout: IMPORT_TIMEOUT_MS, retry: POST_RETRY })
    .json()
    .then(parseSummary);
}

export function useCloseImport(id: string) {
  const client = useQueryClient();
  return useMutation<BatchSummary, unknown, void>({
    mutationFn: () =>
      api
        .post(`${batchPath(id)}/close`, { retry: POST_RETRY })
        .json()
        .then(parseSummary),
    onSuccess: (summary) => syncBatch(client, summary),
  });
}

export function useDiscardImport(id: string) {
  const client = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: async () => {
      await api.delete(batchPath(id));
    },
    onSuccess: () => {
      client.removeQueries({ queryKey: batchKey(id) });
      client.removeQueries({ queryKey: [ROOT_KEY, 'rows', id] });
      void client.invalidateQueries({ queryKey: [ROOT_KEY, 'batches'] });
    },
  });
}

/** O nome do arquivo vem do `Content-Disposition`, lido antes do corpo (como na exportação). */
async function download(path: string, fallbackName: string, searchParams?: Record<string, string>): Promise<void> {
  const res = await api.get(path, searchParams ? { searchParams } : undefined);
  const name = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName);
  saveBlob(await res.blob(), name);
}

export function downloadTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  return download(`${PREFIX}/template`, `modelo-importacao-pessoas.${format}`, {
    format,
  });
}

export function downloadErrors(id: string): Promise<void> {
  return download(`${batchPath(id)}/errors.csv`, 'erros-importacao.csv');
}
