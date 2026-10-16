import { Module } from '@nestjs/common';
import { TeamWhatsappController } from './team-whatsapp.controller';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappService } from './team-whatsapp.service';

/**
 * ConsentService, AuditService e a fila TEAM_WHATSAPP_SEND vêm de módulos
 * @Global. O módulo expõe as rotas HTTP; o processor da fila team-whatsapp.send
 * fica no WorkerModule e acessa o banco pelo PrismaService.
 */
@Module({
  controllers: [TeamWhatsappController],
  providers: [TeamWhatsappService, TeamWhatsappRepository],
  exports: [TeamWhatsappRepository],
})
export class TeamWhatsappModule {}
