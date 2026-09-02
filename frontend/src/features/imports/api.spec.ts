import { describe, it, expect, vi, beforeEach } from 'vitest';

const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { post: (...args: unknown[]) => postMock(...args) },
}));

import { TimeoutError } from 'ky';
import {
  IMPORT_UPLOAD_TIMEOUT_MS,
  importTimeoutMessage,
  uploadImport,
} from './api';

describe('imports api — async upload (returns batchId)', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('uses a timeout above the 15s global default for the Excel upload', () => {
    // The default ky timeout (15s) is too short for large valid spreadsheets.
    // The upload now returns 202 immediately, but keep the override for slack.
    expect(IMPORT_UPLOAD_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it('passes the raised timeout to the upload request', async () => {
    postMock.mockReturnValue({
      json: () => Promise.resolve({ batchId: 'b1', status: 'PENDING' }),
    });

    await uploadImport(new File(['x'], 'c.xlsx'));

    expect(postMock).toHaveBeenCalledWith(
      'imports',
      expect.objectContaining({ timeout: IMPORT_UPLOAD_TIMEOUT_MS }),
    );
  });

  it('returns { batchId, status } from the 202 response (no longer a summary)', async () => {
    postMock.mockReturnValue({
      json: () => Promise.resolve({ batchId: 'batch-9', status: 'PENDING' }),
    });

    const result = await uploadImport(new File(['x'], 'c.xlsx'));

    expect(result).toEqual({ batchId: 'batch-9', status: 'PENDING' });
  });

  it('maps a ky TimeoutError to a "still running, check Histórico" message', () => {
    const msg = importTimeoutMessage(new TimeoutError(new Request('http://x')));
    expect(msg).toMatch(/Histórico/i);
  });

  it('returns the generic failure message for non-timeout errors', () => {
    expect(importTimeoutMessage(new Error('boom'))).toBe('Falha ao importar');
  });
});
