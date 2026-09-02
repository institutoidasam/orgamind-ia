import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ExcelService } from './excel.service';
import { QUEUE_NAMES, type ExcelImportJob } from '../queue/queue.constants';
import { DomainError } from '../../shared/errors/domain.error';

/**
 * Consumes the EXCEL_IMPORT queue (A8 deeper fix): the upload endpoint creates a
 * PENDING ImportBatch and enqueues the base64-encoded .xlsx; this processor
 * decodes it, marks the batch PROCESSING, runs the EXISTING import pipeline
 * (ExcelService.importBuffer, reused verbatim — same parse/classify/insert/
 * chunked-createMany/tag-preservation logic), then records COMPLETED with the
 * summary or FAILED with the error.
 *
 * IMPORTANT: this @Processor is registered ONLY in WorkerModule. A duplicate
 * registration in a feature module breaks DI and crashes the whole worker
 * (it caused a prod worker outage before — never do it).
 */
@Processor(QUEUE_NAMES.EXCEL_IMPORT, { concurrency: 1 })
export class ExcelImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ExcelImportProcessor.name);

  constructor(private readonly excel: ExcelService) {
    super();
  }

  async process(job: Job<ExcelImportJob>): Promise<void> {
    const { batchId, filename, fileBase64, purposeKey, actorUserId } = job.data;
    const buffer = Buffer.from(fileBase64, 'base64');

    await this.excel.markProcessing(batchId);

    try {
      const result = await this.excel.importBuffer(filename, buffer, {
        batchId,
        // C4 (§3.3) — a finalidade do lote e o operador que importou. Vêm do
        // request; o worker não teria como descobrir nenhum dos dois.
        purposeKey,
        actorUserId,
      });
      await this.excel.markCompleted(batchId, {
        total: result.total,
        created: result.created,
        updated: result.updated,
        invalid: result.invalid,
        duplicates: result.duplicates,
        // O resumo do consentimento é o que o operador precisa ver depois de
        // subir uma planilha de fichas: quantas viraram GRANT, quantas ficaram
        // pelo caminho e por quê.
        consentGranted: result.consentGranted,
        consentRefused: result.consentRefused,
        consentIncomplete: result.consentIncomplete,
        consentSuppressed: result.consentSuppressed,
      });
      this.logger.log(
        `Import batch ${batchId} (${filename}) completed: ` +
          `total=${result.total} created=${result.created} updated=${result.updated} ` +
          `invalid=${result.invalid} duplicates=${result.duplicates} ` +
          `consentGranted=${result.consentGranted} consentIncomplete=${result.consentIncomplete} ` +
          `consentSuppressed=${result.consentSuppressed}`,
      );
    } catch (err) {
      // Keep the DomainError.detail in the persisted batch error — it carries
      // the actionable part (e.g. WHICH column is duplicated) that the bare
      // message loses (U1).
      const message =
        err instanceof DomainError && err.detail
          ? `${err.message} — ${err.detail}`
          : err instanceof Error
            ? err.message
            : String(err);
      await this.excel.markFailed(batchId, message);
      this.logger.error({ err, batchId, filename }, 'Import batch failed');
      // Rethrow so the job is recorded as failed in BullMQ (visible in the
      // queue/Bull board). The queue is configured attempts:1, so a corrupt
      // file is not reprocessed in a loop.
      throw err;
    }
  }
}
