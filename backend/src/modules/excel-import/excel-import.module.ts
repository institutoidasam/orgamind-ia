import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ExcelService } from './excel.service';
import { ImportsController } from './imports.controller';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.CONTACT_SYNC }),
    // EXCEL_IMPORT producer side: the controller enqueues the parse+import job
    // here; the consumer (ExcelImportProcessor) lives only in WorkerModule.
    BullModule.registerQueue({ name: QUEUE_NAMES.EXCEL_IMPORT }),
  ],
  controllers: [ImportsController],
  providers: [ExcelService],
  exports: [ExcelService],
})
export class ExcelImportModule {}
