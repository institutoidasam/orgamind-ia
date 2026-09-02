import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimeoutError } from 'ky';

const mutateAsync = vi.fn();
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    useImportExcel: () => ({ mutateAsync, isPending: false }),
  };
});

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { ExcelUploader } from './excel-uploader';

function selectFile(name: string, type = '', size = 1024): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('ExcelUploader', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it('only accepts .xlsx on the file input (no .xls)', () => {
    render(<ExcelUploader />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.xlsx');
    expect(input.accept).not.toContain('.xls,');
  });

  it('rejects a non-.xlsx file with an error toast and does not call the API', () => {
    render(<ExcelUploader />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [selectFile('legacy.xls')] } });
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/\.xlsx/i));
    // and the Importar button should not be enabled for a rejected file
    expect(screen.getByRole('button', { name: /importar/i })).toBeDisabled();
  });

  it('rejects a file over the 10MB size cap', () => {
    render(<ExcelUploader />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [selectFile('big.xlsx', '', 11 * 1024 * 1024)] },
    });
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/10\s?MB/i));
  });

  it('accepts a valid .xlsx and uploads it (async — shows "iniciada / Histórico")', async () => {
    // Upload is now async: it returns a batchId immediately, NOT a row summary.
    mutateAsync.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
    render(<ExcelUploader />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [selectFile('ok.xlsx')] } });
    fireEvent.click(screen.getByRole('button', { name: /importar/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // The toast no longer reports created/updated counts (the import hasn't run
    // yet) — it tells the operator to follow progress in the Histórico.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Hist[oó]rico/i),
      ),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/iniciad/i),
    );
  });

  it('shows the "ainda rodando / Histórico" message on a timeout', async () => {
    mutateAsync.mockRejectedValue(new TimeoutError(new Request('http://x')));
    render(<ExcelUploader />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [selectFile('ok.xlsx')] } });
    fireEvent.click(screen.getByRole('button', { name: /importar/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/Histórico/i),
      ),
    );
  });
});
