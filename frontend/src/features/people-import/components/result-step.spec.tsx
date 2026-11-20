import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchSummary } from '../schemas';
import { progress, writingBatch } from '../write-test-helpers';
import { counts } from './preview-test-helpers';

const mocks = vi.hoisted(() => ({
  downloadErrors: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../api', () => ({ downloadErrors: mocks.downloadErrors }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { ResultStep } from './result-step';

function finished(values: Partial<BatchSummary> = {}): BatchSummary {
  return writingBatch({
    situation: 'COMPLETED',
    canContinue: false,
    canClose: false,
    counts: counts({
      CREATE: 200,
      UPDATE: 60,
      INVALID: 3,
      DUPLICATE: 2,
      CONFLICT: 1,
    }),
    progress: progress({
      created: 190,
      updated: 55,
      unchanged: 5,
      failed: 4,
      notWritten: 0,
    }),
    hasErrorReport: true,
    ...values,
  });
}

const countOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadErrors.mockResolvedValue(undefined);
});

describe('ResultStep', () => {
  it('contagens e Baixar relatório de erros quando há erros', async () => {
    render(<ResultStep batch={finished()} />);

    expect(screen.getByText('Concluída')).toBeInTheDocument();
    expect(countOf('Criadas')).toBe('190');
    expect(countOf('Atualizadas')).toBe('55');
    expect(countOf('Sem alteração')).toBe('5');
    expect(countOf('Não entraram')).toBe('10');
    await userEvent.click(screen.getByRole('button', { name: 'Baixar relatório de erros' }));
    await waitFor(() => expect(mocks.downloadErrors).toHaveBeenCalledWith('b1'));
  });

  it('sem erros não oferece o relatório', () => {
    render(<ResultStep batch={finished({ hasErrorReport: false })} />);
    expect(screen.queryByRole('button', { name: 'Baixar relatório de erros' })).not.toBeInTheDocument();
  });

  it('falhas por telefone já cadastrado só quando phoneTaken > 0', () => {
    const { rerender } = render(<ResultStep batch={finished()} />);
    expect(screen.queryByText(/Falhas por telefone já cadastrado/)).not.toBeInTheDocument();

    rerender(<ResultStep batch={finished({ progress: progress({ failed: 4, phoneTaken: 3 }) })} />);

    expect(screen.getByText('Falhas por telefone já cadastrado: 3')).toBeInTheDocument();
  });
});

describe('ResultStep: outras situações', () => {
  it('lote encerrado conta as linhas não gravadas em Não entraram', () => {
    const closed = finished({
      situation: 'CLOSED',
      progress: progress({ created: 100, notWritten: 200 }),
    });
    render(<ResultStep batch={closed} />);

    expect(screen.getByText('Encerrada')).toBeInTheDocument();
    expect(countOf('Não entraram')).toBe('206');
  });

  it('falha ao baixar o relatório mostra o erro', async () => {
    mocks.downloadErrors.mockRejectedValue(new Error('rede caiu'));
    render(<ResultStep batch={finished()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Baixar relatório de erros' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Erro', {
        description: 'rede caiu',
      }),
    );
  });
});

describe('ResultStep: sem alteração', () => {
  it('reimportação de planilha já gravada mostra as linhas sem alteração da prévia', () => {
    const reimport = finished({
      counts: counts({ UNCHANGED: 30 }),
      progress: progress({ toWrite: 0, unchanged: 0 }),
    });
    render(<ResultStep batch={reimport} />);

    expect(countOf('Sem alteração')).toBe('30');
  });

  it('soma as da prévia com as que a gravação encontrou sem alteração', () => {
    const mixed = finished({
      counts: counts({ CREATE: 200, UNCHANGED: 12 }),
      progress: progress({ created: 190, unchanged: 5 }),
    });
    render(<ResultStep batch={mixed} />);

    expect(countOf('Sem alteração')).toBe('17');
  });
});
