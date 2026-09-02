import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ImportsController } from './imports.controller';
import { ExcelService } from './excel.service';
import { ValidationError } from '../../shared/errors/domain.error';
import type { Queue } from 'bullmq';
import type { ExcelImportJob } from '../queue/queue.constants';

describe('ImportsController', () => {
  let controller: ImportsController;
  let excel: MockProxy<ExcelService>;
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    excel = mockDeep<ExcelService>();
    queue = { add: vi.fn().mockResolvedValue(undefined) };
    controller = new ImportsController(excel, queue as unknown as Queue);
  });

  it('throws ValidationError when no file is uploaded', async () => {
    await expect(
      controller.upload(undefined as unknown as Express.Multer.File),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError with code excel.file_required when no file', async () => {
    try {
      await controller.upload(undefined as unknown as Express.Multer.File);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('excel.file_required');
    }
  });

  it('does NOT import inline — it must NOT call importBuffer on upload', async () => {
    excel.createPendingBatch.mockResolvedValue({ id: 'b1' });
    const file = {
      originalname: 'list.xlsx',
      buffer: Buffer.from('xlsx-bytes'),
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    await controller.upload(file);

    // The whole point of A8's deeper fix: the HTTP request no longer parses or
    // imports — that work moves to the worker.
    expect(excel.importBuffer).not.toHaveBeenCalled();
  });

  it('creates a PENDING ImportBatch and returns { batchId, status: PENDING }', async () => {
    excel.createPendingBatch.mockResolvedValue({ id: 'batch-42' });
    const file = {
      originalname: 'list.xlsx',
      buffer: Buffer.from('xlsx-bytes'),
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    const result = await controller.upload(file);

    expect(excel.createPendingBatch).toHaveBeenCalledWith('list.xlsx');
    expect(result).toEqual({ batchId: 'batch-42', status: 'PENDING' });
  });

  it('enqueues an EXCEL_IMPORT job carrying the base64-encoded buffer + batchId', async () => {
    excel.createPendingBatch.mockResolvedValue({ id: 'batch-42' });
    const buf = Buffer.from('xlsx-bytes');
    const file = {
      originalname: 'list.xlsx',
      buffer: buf,
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    await controller.upload(file);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, payload] = queue.add.mock.calls[0] as [string, ExcelImportJob];
    expect(payload.batchId).toBe('batch-42');
    expect(payload.filename).toBe('list.xlsx');
    // The buffer is base64-encoded so it survives JSON serialization in the job.
    expect(payload.fileBase64).toBe(buf.toString('base64'));
    expect(Buffer.from(payload.fileBase64, 'base64').equals(buf)).toBe(true);
  });

  it('rejects a file over the 10MB cap BEFORE creating a batch or enqueueing', async () => {
    const file = {
      originalname: 'big.xlsx',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    await expect(controller.upload(file)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(excel.createPendingBatch).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('delegates listing to ExcelService.listBatches', () => {
    controller.list();
    expect(excel.listBatches).toHaveBeenCalled();
  });

  /**
   * C4 (§3.3) — o consentimento de papel precisa saber DE QUE finalidade ele é e
   * QUEM o transcreveu. Nenhum dos dois está na planilha, e nenhum dos dois pode
   * ser inventado no worker: viajam no job desde o request.
   */
  it('leva a finalidade do lote e o OPERADOR que importou para dentro do job', async () => {
    excel.createPendingBatch.mockResolvedValue({ id: 'batch-42' });
    const file = {
      originalname: 'fichas.xlsx',
      buffer: Buffer.from('xlsx-bytes'),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    await controller.upload(file, 'convite_atividades', {
      user: { sub: 'user-operador' },
    } as never);

    const [, payload] = queue.add.mock.calls[0] as [string, ExcelImportJob];
    expect(payload.purposeKey).toBe('convite_atividades');
    // Vira `ConsentEvent.actorUserId`: um GRANT de papel NÃO é ato do titular
    // dentro do orgamind — alguém o transcreveu, e a trilha tem de dizer quem.
    expect(payload.actorUserId).toBe('user-operador');
  });

  it('sem finalidade no upload, o job vai sem ela (a coluna da planilha decide)', async () => {
    excel.createPendingBatch.mockResolvedValue({ id: 'batch-42' });
    const file = {
      originalname: 'contatos.xlsx',
      buffer: Buffer.from('xlsx-bytes'),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    await controller.upload(file, undefined, { user: { sub: 'u1' } } as never);

    const [, payload] = queue.add.mock.calls[0] as [string, ExcelImportJob];
    expect(payload.purposeKey).toBeUndefined();
  });
});
