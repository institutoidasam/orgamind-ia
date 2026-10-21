import { Module } from '@nestjs/common';
import { StaffScheduleModule } from '../staff-schedule/staff-schedule.module';
import { TeamWhatsappController } from './team-whatsapp.controller';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappService } from './team-whatsapp.service';

/**
 * ConsentService, AuditService e a fila TEAM_WHATSAPP_SEND vêm de módulos
 * @Global. O módulo expõe as rotas HTTP; o processor da fila team-whatsapp.send
 * fica no WorkerModule e acessa o banco pelo PrismaService. O StaffScheduleModule
 * exporta o repositório da escala, que o envio por data lê (T7b). Agendados
 * (lista e cancelamento) ficam no TeamWhatsappScheduleService (T8).
 */
@Module({
  imports: [StaffScheduleModule],
  controllers: [TeamWhatsappController],
  providers: [
    TeamWhatsappService,
    TeamWhatsappScheduleService,
    TeamWhatsappRepository,
  ],
  exports: [TeamWhatsappRepository],
})
export class TeamWhatsappModule {}
