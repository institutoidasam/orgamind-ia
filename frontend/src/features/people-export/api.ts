import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { readApiErrorBody } from '@/lib/api-error';
import { filenameFromDisposition, saveBlob } from './download';

export type ExportFormat = 'csv' | 'xlsx';
export type PeopleExportParams = {
  format: ExportFormat;
  sectorId?: string;
  shiftId?: string;
  status: 'active' | 'inactive' | 'all';
  date: string;
};
export type ScheduleExportParams = {
  format: ExportFormat;
  sectorId: string;
  from: string;
  to: string;
};

/** 50 mil linhas em planilha levam mais que os 15 s padrão do cliente. */
const EXPORT_TIMEOUT_MS = 120_000;
/**
 * O ky repete GET em erro 5xx ou de rede; numa exportação isso geraria o arquivo de novo e
 * poderia registrá-lo duas vezes na Trilha. Quem tenta de novo é o usuário, pelo botão.
 */
const EXPORT_RETRY = 0;
const EXPORT_ERROR_FALLBACK = 'Não foi possível exportar. Tente de novo.';

type Query = Record<string, string | undefined>;

/** Parâmetro indefinido ou vazio não vai na query string. */
function compact(query: Query): Record<string, string> {
  const entries = Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return Object.fromEntries(entries);
}

/** Texto do servidor (`detail` do ProblemDetails) quando houver; senão a mensagem de reserva. */
export async function apiErrorText(error: unknown, fallback: string): Promise<string> {
  return (await readApiErrorBody(error))?.detail || fallback;
}

/**
 * Aviso por toast, e não dentro do diálogo ou do menu: no 403 o tratamento global só
 * relê a sessão e o botão de exportar pode sair da tela; o toast sobrevive a isso.
 */
async function toastExportError(error: unknown): Promise<void> {
  toast.error(await apiErrorText(error, EXPORT_ERROR_FALLBACK));
}

/**
 * O nome do arquivo vem do `Content-Disposition`, então o header é lido ANTES do corpo:
 * `.blob()` encadeado na chamada descartaria a resposta e os headers junto.
 */
async function download(path: string, query: Query, fallbackName: string): Promise<void> {
  const res = await api.get(path, {
    searchParams: compact(query),
    timeout: EXPORT_TIMEOUT_MS,
    retry: EXPORT_RETRY,
  });
  const name = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName);
  saveBlob(await res.blob(), name);
}

export function useExportPeople() {
  return useMutation<void, unknown, PeopleExportParams>({
    mutationFn: ({ format, sectorId, shiftId, status, date }) =>
      download('internal/people-export/people', { format, sectorId, shiftId, status, date }, `pessoas.${format}`),
    onError: toastExportError,
  });
}

export function useExportSchedule() {
  return useMutation<void, unknown, ScheduleExportParams>({
    mutationFn: ({ format, sectorId, from, to }) =>
      download('internal/people-export/schedule', { format, sectorId, from, to }, `escala.${format}`),
    onError: toastExportError,
  });
}
