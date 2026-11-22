import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import type { BatchSummary } from '../schemas';

type QueryState = { data?: BatchSummary; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };

const mocks = vi.hoisted(() => {
  const idle = (): QueryState => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  });
  const state = { query: idle(), next: undefined as BatchSummary | undefined };
  return {
    idle,
    state,
    /** O que a cache do lote passa a ter quando um passo termina (o `syncBatch` do `api.ts`). */
    advance: () => {
      state.query = { ...state.query, data: state.next };
      return state.next;
    },
    toastError: vi.fn(),
    onChange: vi.fn(),
  };
});

vi.mock('../api', () => ({ useImportBatch: () => mocks.state.query }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('./batch-list', () => ({
  BatchList: ({ onOpen, onDiscarded }: { onOpen: (id: string) => void; onDiscarded: (id: string) => void }) => (
    <div>
      <button onClick={() => onOpen('b9')}>abrir b9</button>
      <button onClick={() => onOpen('b1')}>abrir b1</button>
      <button onClick={() => onDiscarded('b1')}>descartar b1</button>
      <button onClick={() => onDiscarded('b8')}>descartar b8</button>
    </div>
  ),
}));
vi.mock('./file-step', () => ({
  FileStep: ({ onUploaded }: { onUploaded: (summary: unknown) => void }) => (
    <div data-testid="step">
      arquivo<button onClick={() => onUploaded(mocks.advance())}>enviar</button>
    </div>
  ),
}));
vi.mock('./mapping-step', () => ({
  MappingStep: (props: { batch: BatchSummary; onReady: (s: unknown) => void; onDiscarded: () => void }) => (
    <div data-testid="step">
      colunas:{props.batch.id}
      <button onClick={() => props.onReady(mocks.advance())}>refazer</button>
      <button onClick={() => props.onDiscarded()}>descartar</button>
    </div>
  ),
}));
vi.mock('./preview-step', () => ({
  PreviewStep: (props: { batch: BatchSummary; onConfirmed: (s: unknown) => void; onBack: () => void }) => (
    <div data-testid="step">
      previa:{props.batch.id}:{props.batch.counts?.CREATE}
      <button onClick={() => props.onConfirmed(mocks.advance())}>confirmar</button>
      <button onClick={() => props.onBack()}>voltar</button>
    </div>
  ),
}));
vi.mock('./writing-step', () => ({
  WritingStep: ({ batch, isAdmin, autoStart }: { batch: BatchSummary; isAdmin: boolean; autoStart?: boolean }) => (
    <div data-testid="step">{`gravacao:${batch.id}:auto=${String(autoStart)}:admin=${String(isAdmin)}`}</div>
  ),
}));
vi.mock('./result-step', () => ({
  ResultStep: ({ batch }: { batch: BatchSummary }) => <div data-testid="step">{`resultado:${batch.id}`}</div>,
}));

import { ImportPage } from './import-page';
import { batchSummary, counts } from './preview-test-helpers';
import { progress, writingBatch } from '../write-test-helpers';

type Change = Parameters<Parameters<typeof ImportPage>[0]['onBatchChange']>;

function Harness({ initial }: { initial?: string }) {
  const [batchId, setBatchId] = useState(initial);
  return (
    <ImportPage
      batchId={batchId}
      onBatchChange={(...args: Change) => {
        setBatchId(args[0]);
        if (args[0] === undefined) mocks.state.query = mocks.idle();
        mocks.onChange(...args);
      }}
    />
  );
}

function setup(initial: string | undefined, data?: BatchSummary) {
  mocks.state.query = { ...mocks.idle(), data };
  const view = render(<Harness initial={initial} />);
  return { user: userEvent.setup(), unmount: view.unmount };
}

const step = () => screen.getByTestId('step');
const click = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole('button', { name }));
const notFound = () => {
  const response = new Response(null, { status: 404 });
  const error = new HTTPError(response, new Request('https://x'), {} as never);
  error.data = { code: 'people_import.batch_not_found', detail: 'Lote não encontrado.', status: 404 };
  return error;
};

beforeEach(() => {
  mocks.onChange.mockReset();
  mocks.toastError.mockReset();
  mocks.state.query = mocks.idle();
  mocks.state.next = undefined;
  useAuthStore.setState({
    accessToken: 'tok',
    user: { id: 'u1', email: 'a@b.com', name: 'Ana', role: 'ADMIN' },
    mustChangePassword: false,
  });
});

const CASES: Array<[Partial<BatchSummary> | null, string, string]> = [
  [null, 'arquivo', '1. Arquivo'],
  [{ mappingProblem: 'Falta a coluna Nome.' }, 'colunas:b1', '2. Colunas'],
  [{ counts: counts({ CREATE: 7 }) }, 'previa:b1:7', '3. Prévia'],
  [writingBatch(), 'gravacao:b1:auto=false:admin=true', '4. Resultado'],
  [writingBatch({ situation: 'INTERRUPTED' }), 'gravacao:b1:auto=false:admin=true', '4. Resultado'],
  [{ situation: 'COMPLETED', progress: progress() }, 'resultado:b1', '4. Resultado'],
  [{ situation: 'CLOSED', progress: progress() }, 'resultado:b1', '4. Resultado'],
];

describe('ImportPage: passos', () => {
  it('passos conforme a situação do lote da URL', () => {
    for (const [overrides, shown, current] of CASES) {
      const { unmount } = setup(overrides ? 'b1' : undefined, overrides ? batchSummary(overrides) : undefined);
      expect(step()).toHaveTextContent(shown);
      expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent(current);
      unmount();
    }
  });

  it('envio abre Colunas; refazer leva à Prévia com o resumo atual; voltar leva às Colunas', async () => {
    const { user } = setup(undefined);
    mocks.state.next = batchSummary({ id: 'b1', counts: counts({ CREATE: 3 }) });
    await click(user, 'enviar');
    expect(step()).toHaveTextContent('colunas:b1');
    expect(mocks.onChange).toHaveBeenLastCalledWith('b1');

    mocks.state.next = batchSummary({ id: 'b1', counts: counts({ CREATE: 5 }) });
    await click(user, 'refazer');
    expect(step()).toHaveTextContent('previa:b1:5');
    await click(user, 'voltar');
    expect(step()).toHaveTextContent('colunas:b1');
  });

  it('Nova importação volta ao passo Arquivo sem o lote', async () => {
    const { user } = setup('b1', batchSummary({ situation: 'COMPLETED', progress: progress() }));
    await click(user, 'Nova importação');
    expect(step()).toHaveTextContent('arquivo');
    expect(mocks.onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole('button', { name: 'Nova importação' })).not.toBeInTheDocument();
  });
});

describe('ImportPage: gravação', () => {
  it('a gravação começa sozinha só logo depois da confirmação, nunca ao abrir um lote existente', async () => {
    const { user } = setup('b1', batchSummary());
    mocks.state.next = writingBatch();
    await click(user, 'confirmar');
    expect(step()).toHaveTextContent('gravacao:b1:auto=true');

    mocks.state.query = { ...mocks.idle(), data: writingBatch({ id: 'b9' }) };
    await click(user, 'abrir b9');
    expect(mocks.onChange).toHaveBeenLastCalledWith('b9');
    expect(step()).toHaveTextContent('gravacao:b9:auto=false');
    mocks.state.query = { ...mocks.idle(), data: writingBatch() };
    await click(user, 'abrir b1');
    expect(step()).toHaveTextContent('gravacao:b1:auto=false');
  });
});

describe('ImportPage: histórico do navegador', () => {
  it('Voltar e Avançar até o lote já confirmado não recomeçam a gravação sozinhos', async () => {
    mocks.state.query = { ...mocks.idle(), data: batchSummary() };
    const user = userEvent.setup();
    const page = (batchId?: string) => <ImportPage batchId={batchId} onBatchChange={mocks.onChange} />;
    const view = render(page('b1'));
    mocks.state.next = writingBatch();
    await click(user, 'confirmar');
    expect(step()).toHaveTextContent('gravacao:b1:auto=true');

    view.rerender(page(undefined));
    expect(step()).toHaveTextContent('arquivo');
    view.rerender(page('b1'));

    expect(step()).toHaveTextContent('gravacao:b1:auto=false');
  });
});

describe('ImportPage: lote que sumiu', () => {
  it('lote da URL descartado ou apagado: volta ao passo Arquivo sem o lote na URL', async () => {
    mocks.state.query = { ...mocks.idle(), isError: true, error: notFound() };
    render(<Harness initial="b9" />);
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Lote não encontrado.'));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.onChange).toHaveBeenCalledWith(undefined, { replace: true });
    expect(step()).toHaveTextContent('arquivo');
  });

  it('descartar o lote aberto, na lista ou nas Colunas, tira o lote da URL', async () => {
    const { user, unmount } = setup('b1', batchSummary({ mappingProblem: 'x' }));
    await click(user, 'descartar b8');
    expect(mocks.onChange).not.toHaveBeenCalled();
    await click(user, 'descartar b1');
    expect(mocks.onChange).toHaveBeenLastCalledWith(undefined);
    expect(step()).toHaveTextContent('arquivo');
    unmount();

    const second = setup('b1', batchSummary({ mappingProblem: 'x' }));
    await click(second.user, 'descartar');
    expect(mocks.onChange).toHaveBeenCalledTimes(2);
    expect(step()).toHaveTextContent('arquivo');
  });

  it('falha que não é lote apagado mostra o erro e mantém o lote', async () => {
    mocks.state.query = { ...mocks.idle(), isError: true, error: new Error('rede') };
    render(<Harness initial="b9" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.onChange).not.toHaveBeenCalled();
  });
});
