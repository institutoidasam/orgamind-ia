import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import { ExcelImportProcessor } from './excel-import.processor';
import { ExcelService } from './excel.service';
import type { ExcelImportJob } from '../queue/queue.constants';
import { DomainError } from '../../shared/errors/domain.error';

/** Planilha sem coluna de consentimento: nenhum GRANT, nenhuma recusa (C4). */
const NO_CONSENT = {
  consentGranted: 0,
  consentRefused: 0,
  consentIncomplete: 0,
  consentSuppressed: 0,
};

function makeJob(data: Partial<ExcelImportJob> = {}): Job<ExcelImportJob> {
  return {
    data: {
      batchId: 'b1',
      filename: 'list.xlsx',
      fileBase64: Buffer.from('xlsx-bytes').toString('base64'),
      ...data,
    },
  } as Job<ExcelImportJob>;
}

describe('ExcelImportProcessor', () => {
  let processor: ExcelImportProcessor;
  let excel: MockProxy<ExcelService>;

  beforeEach(() => {
    excel = mockDeep<ExcelService>();
    processor = new ExcelImportProcessor(excel);
  });

  it('marks the batch PROCESSING before importing', async () => {
    const order: string[] = [];
    excel.markProcessing.mockImplementation(async () => {
      order.push('processing');
    });
    excel.importBuffer.mockImplementation(async () => {
      order.push('import');
      return {
        batchId: 'b1',
        total: 1,
        created: 1,
        updated: 0,
        invalid: 0,
        duplicates: 0,
        ...NO_CONSENT,
      };
    });

    await processor.process(makeJob());

    expect(excel.markProcessing).toHaveBeenCalledWith('b1');
    // PROCESSING must be set before the (potentially long) import begins.
    expect(order).toEqual(['processing', 'import']);
  });

  it('decodes the base64 buffer and runs importBuffer against the existing batchId', async () => {
    excel.importBuffer.mockResolvedValue({
      batchId: 'b1',
      total: 2,
      created: 2,
      updated: 0,
      invalid: 0,
      duplicates: 0,
      ...NO_CONSENT,
    });

    const buf = Buffer.from('real-xlsx-bytes');
    await processor.process(
      makeJob({ fileBase64: buf.toString('base64'), filename: 'real.xlsx' }),
    );

    expect(excel.importBuffer).toHaveBeenCalledTimes(1);
    const [filename, buffer, opts] = excel.importBuffer.mock.calls[0];
    expect(filename).toBe('real.xlsx');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect((buffer as Buffer).equals(buf)).toBe(true);
    expect(opts).toEqual({
      batchId: 'b1',
      purposeKey: undefined,
      actorUserId: undefined,
    });
  });

  /**
   * C4 (§3.3): a finalidade do lote e o operador que subiu a planilha viajam no
   * job. Sem eles, um GRANT de papel nasceria sem finalidade (nulo, art. 8º §4º)
   * ou sem autor (o worker não tem `req.user`).
   */
  it('repassa a finalidade do lote e o operador para o importBuffer', async () => {
    excel.importBuffer.mockResolvedValue({
      batchId: 'b1',
      total: 1,
      created: 1,
      updated: 0,
      invalid: 0,
      duplicates: 0,
      ...NO_CONSENT,
      consentGranted: 1,
    });

    await processor.process(
      makeJob({ purposeKey: 'convite_atividades', actorUserId: 'user-operador' }),
    );

    const [, , opts] = excel.importBuffer.mock.calls[0];
    expect(opts).toEqual({
      batchId: 'b1',
      purposeKey: 'convite_atividades',
      actorUserId: 'user-operador',
    });
  });

  it('marks the batch COMPLETED with the summary on success', async () => {
    excel.importBuffer.mockResolvedValue({
      batchId: 'b1',
      total: 5,
      created: 3,
      updated: 1,
      invalid: 1,
      duplicates: 0,
      ...NO_CONSENT,
    });

    await processor.process(makeJob());

    // O resumo do lote carrega o consentimento: é o número que o operador tem de
    // ver depois de subir uma planilha de fichas ("quantas viraram GRANT?").
    expect(excel.markCompleted).toHaveBeenCalledWith('b1', {
      total: 5,
      created: 3,
      updated: 1,
      invalid: 1,
      duplicates: 0,
      ...NO_CONSENT,
    });
    expect(excel.markFailed).not.toHaveBeenCalled();
  });

  it('marks the batch FAILED when the import throws, and rethrows', async () => {
    excel.importBuffer.mockRejectedValue(new Error('corrupt workbook'));

    await expect(processor.process(makeJob())).rejects.toThrow(
      /corrupt workbook/,
    );

    expect(excel.markFailed).toHaveBeenCalledWith(
      'b1',
      expect.stringContaining('corrupt workbook'),
    );
    expect(excel.markCompleted).not.toHaveBeenCalled();
  });

  it('persists "<message> — <detail>" when the failure is a DomainError with detail', async () => {
    excel.importBuffer.mockRejectedValue(
      new DomainError({
        code: 'excel.duplicate_header',
        message: 'Cabeçalhos duplicados na planilha',
        status: 422,
        detail: 'A coluna "nome" aparece mais de uma vez.',
      }),
    );

    await expect(processor.process(makeJob())).rejects.toThrow(
      /Cabeçalhos duplicados/,
    );

    expect(excel.markFailed).toHaveBeenCalledWith(
      'b1',
      'Cabeçalhos duplicados na planilha — A coluna "nome" aparece mais de uma vez.',
    );
  });

  it('persists only the message for a DomainError WITHOUT detail', async () => {
    excel.importBuffer.mockRejectedValue(
      new DomainError({
        code: 'excel.empty_workbook',
        message: 'Planilha vazia',
        status: 422,
      }),
    );

    await expect(processor.process(makeJob())).rejects.toThrow(
      /Planilha vazia/,
    );

    expect(excel.markFailed).toHaveBeenCalledWith('b1', 'Planilha vazia');
  });

  it('persists only the message for a plain Error (existing behaviour preserved)', async () => {
    excel.importBuffer.mockRejectedValue(new Error('plain boom'));

    await expect(processor.process(makeJob())).rejects.toThrow(/plain boom/);

    expect(excel.markFailed).toHaveBeenCalledWith('b1', 'plain boom');
  });
});
