import { Module } from '@nestjs/common';
import { StaffScheduleEditService } from './staff-schedule-edit.service';
import { StaffScheduleController } from './staff-schedule.controller';
import { StaffScheduleRepository } from './staff-schedule.repository';
import { StaffScheduleService } from './staff-schedule.service';

/**
 * Escala da equipe. O repositório é exportado para o envio por data (T7b) ler a
 * escala sem duplicar as queries; a política fica em funções puras.
 */
@Module({
  controllers: [StaffScheduleController],
  providers: [
    StaffScheduleService,
    StaffScheduleEditService,
    StaffScheduleRepository,
  ],
  exports: [StaffScheduleRepository],
})
export class StaffScheduleModule {}
