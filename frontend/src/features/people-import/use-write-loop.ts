import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { HTTPError, isNetworkError, isTimeoutError } from 'ky';
import { readApiErrorBody } from '@/lib/api-error';
import { useImportBatch, writeBlock } from './api';
import { processedCount } from './progress';
import type { BatchSummary } from './schemas';

/** Mesma raiz de chaves de `api.ts`: o resumo de cada bloco vai para a cache do lote (o teste do laço confere). */
const ROOT_KEY = 'people-import';
const RETRY_MS = 5_000;
const THROTTLE_DEFAULT_MS = 10_000;
/** Teto de uma espera por 429: um `Retry-After` enorme não pode prender a tela. */
const THROTTLE_MAX_MS = 120_000;
const NOT_WRITING = 'people_import.not_writing';
const PERMISSION_TEXT = 'Você não tem permissão para importar planilhas de pessoas.';
const FAILURE_TEXT = 'Não foi possível gravar este bloco. Use "Continuar gravação" para tentar de novo.';

type Failure =
  | { kind: 'again'; consult: boolean; waitMs: number }
  | { kind: 'reload' }
  | { kind: 'stop'; message: string };

type Ports = {
  id: string;
  alive: () => boolean;
  publish: (summary: BatchSummary) => void;
  /** Compara com a resposta de bloco anterior (e a guarda): `true` = o bloco não avançou nada. */
  stalled: (summary: BatchSummary) => boolean;
  consult: () => Promise<BatchSummary | undefined>;
  fail: (message: string) => void;
};

export type WriteLoop = {
  running: boolean;
  summary: BatchSummary;
  error: string | null;
  start: () => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isOpen = ({ situation }: BatchSummary) => situation === 'WRITING' || situation === 'INTERRUPTED';

/** Só há linhas reservadas por outro pedido: nada para este pedido gravar agora. */
const waitsForOthers = ({ progress }: BatchSummary) =>
  progress !== null && progress.pending === 0 && progress.writing > 0;

/** Nenhuma linha resolvida a mais e nenhuma reserva nova: o back não avançou o lote neste bloco. */
const sameProgress = (before: BatchSummary, after: BatchSummary) =>
  before.progress !== null &&
  after.progress !== null &&
  processedCount(before.progress) === processedCount(after.progress) &&
  before.progress.writing === after.progress.writing;

/** `Retry-After` em segundos; ausente ou ilegível (inclusive data HTTP) vale 10 s. */
function retryAfterMs(header: string | null): number {
  if (header === null || !/^\d+$/.test(header.trim())) return THROTTLE_DEFAULT_MS;
  return Math.min(Math.max(Number(header), 1) * 1000, THROTTLE_MAX_MS);
}

async function classifyHttp(error: HTTPError): Promise<Failure> {
  const { status, headers } = error.response;
  if (status === 429)
    return {
      kind: 'again',
      consult: false,
      waitMs: retryAfterMs(headers.get('retry-after')),
    };
  const body = await readApiErrorBody(error);
  if (status === 409 && body?.code === NOT_WRITING) return { kind: 'reload' };
  return {
    kind: 'stop',
    message: body?.detail ?? (status === 403 ? PERMISSION_TEXT : FAILURE_TEXT),
  };
}

/** Só tempo esgotado, rede e 429 repetem sozinhos; o resto para (o corpo do erro só existe em `HTTPError.data`). */
async function classify(error: unknown): Promise<Failure> {
  if (isTimeoutError(error) || isNetworkError(error)) return { kind: 'again', consult: true, waitMs: RETRY_MS };
  if (error instanceof HTTPError) return classifyHttp(error);
  return { kind: 'stop', message: FAILURE_TEXT };
}

/** `true` = pedir outro bloco. */
async function recover(ports: Ports, failure: Failure): Promise<boolean> {
  if (failure.kind !== 'again') {
    if (failure.kind === 'stop') ports.fail(failure.message);
    await ports.consult();
    return false;
  }
  const current = failure.consult ? await ports.consult() : undefined;
  if (current && !isOpen(current)) return false;
  await sleep(failure.waitMs);
  return true;
}

async function round(ports: Ports): Promise<boolean> {
  try {
    const next = await writeBlock(ports.id);
    ports.publish(next);
    if (!isOpen(next)) return false;
    // Sem avanço (ou só linhas de outro pedido): o mesmo intervalo, para não martelar o back.
    if (ports.stalled(next) || waitsForOthers(next)) await sleep(RETRY_MS);
    return true;
  } catch (error) {
    return recover(ports, await classify(error));
  }
}

/** Um bloco por vez: o próximo pedido só sai depois da resposta (ou do erro) do anterior. */
async function runLoop(ports: Ports): Promise<void> {
  while (ports.alive() && (await round(ports))) {
    // o corpo está em `round`
  }
}

type PortsDeps = {
  id: string;
  client: QueryClient;
  refetch: () => Promise<{ data?: BatchSummary; isError: boolean }>;
  alive: () => boolean;
  setSummary: (summary: BatchSummary) => void;
  setError: (message: string) => void;
};

/** Liga o laço à tela (estado), à cache do lote e à consulta do andamento. */
function makePorts({ id, client, refetch, alive, setSummary, setError }: PortsDeps): Ports {
  let last: BatchSummary | undefined;
  return {
    id,
    alive,
    stalled: (next) => {
      const same = last !== undefined && sameProgress(last, next);
      last = next;
      return same;
    },
    publish: (next) => {
      client.setQueryData([ROOT_KEY, 'batch', next.id], next);
      setSummary(next);
    },
    consult: async () => {
      const { data, isError } = await refetch();
      if (isError || !data) return undefined;
      setSummary(data);
      return data;
    },
    fail: setError,
  };
}

/**
 * Laço de gravação em blocos (EX34). `start()` pede um bloco, espera a resposta (até 120 s) e pede o próximo até o
 * lote deixar de estar `WRITING`/`INTERRUPTED`. Para ao desmontar; quem decide quando chamar `start()` é a tela.
 */
export function useWriteLoop(batch: BatchSummary): WriteLoop {
  const client = useQueryClient();
  const { refetch } = useImportBatch(batch.id);
  const [summary, setSummary] = useState(batch);
  const [seen, setSeen] = useState(batch);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);

  // Resumo novo vindo do pai (outra aba avançou): vale quando este laço não está gravando.
  if (seen !== batch) {
    setSeen(batch);
    if (!running) setSummary(batch);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (active.current) return;
    active.current = true;
    setRunning(true);
    setError(null);
    const alive = () => mounted.current;
    void runLoop(makePorts({ id: batch.id, client, refetch, alive, setSummary, setError })).finally(() => {
      active.current = false;
      setRunning(false);
      void client.invalidateQueries({ queryKey: [ROOT_KEY, 'batches'] });
    });
  }, [batch.id, client, refetch]);

  return { running, summary, error, start };
}
