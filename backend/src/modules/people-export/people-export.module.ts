import { Module } from '@nestjs/common';
import { StaffScheduleModule } from '../staff-schedule/staff-schedule.module';
import { PeopleExportController } from './people-export.controller';
import { PeopleExportRepository } from './people-export.repository';
import { PeopleExportService } from './people-export.service';
import { ScheduleExportService } from './schedule-export.service';

/**
 * Exportar pessoas e escala (Lote D). `StaffScheduleModule` exporta o
 * `StaffScheduleService`, que a escala usa para o alcance do ator e o quadro;
 * `PrismaModule` e `AuditModule` são `@Global`.
 */
@Module({
  imports: [StaffScheduleModule],
  controllers: [PeopleExportController],
  providers: [
    PeopleExportService,
    ScheduleExportService,
    PeopleExportRepository,
  ],
})
export class PeopleExportModule {}
