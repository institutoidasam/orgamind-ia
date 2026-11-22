import { Module } from '@nestjs/common';
import { LevelsModule } from '../levels/levels.module';
import { StaffScheduleModule } from '../staff-schedule/staff-schedule.module';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { TeamAlertAckService } from './team-alert-ack.service';
import { TeamAlertPanelService } from './team-alert-panel.service';
import { TeamAlertReminderService } from './team-alert-reminder.service';
import { TeamAlertController } from './team-alert.controller';
import { TeamAudienceService } from './team-audience.service';
import { TeamPanoramaController } from './team-panorama.controller';
import { TeamPanoramaService } from './team-panorama.service';
import { TeamWhatsappController } from './team-whatsapp.controller';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappService } from './team-whatsapp.service';

/**
 * ConsentService, AuditService e a fila TEAM_WHATSAPP_SEND vêm de módulos
 * @Global. O módulo expõe as rotas HTTP; o processor da fila team-whatsapp.send
 * fica no WorkerModule e acessa o banco pelo PrismaService. O StaffScheduleModule
 * exporta o repositório da escala, que o envio por data lê (T7b). Agendados
 * (lista e cancelamento) ficam no TeamWhatsappScheduleService (T8); a tela de
 * resultado (detalhe e destinatários), no TeamWhatsappResultsService (T11); o
 * "Repetir" (troca atômica e fila), no TeamWhatsappRetryService (T12). O
 * LevelsModule exporta `listActive` para `targets.levels` (C4). O
 * WhatsappProvidersModule exporta a porta `ChannelLiveStateService`, que dá o
 * estado ao vivo do número na prévia (D7). O público por finalidade (prévia
 * e resolução do envio) fica no TeamAudienceService; o ConfigService (global)
 * dá o JWT_SECRET de que sai a chave da impressão do público. O alerta urgente
 * (Lote I) tem controller próprio, `TeamAlertController`, no mesmo prefixo; o
 * painel de pendências fica no TeamAlertPanelService; a ciência manual e o
 * desfazer, no TeamAlertAckService; o lembrete aos pendentes, no
 * TeamAlertReminderService.
 */
@Module({
  imports: [StaffScheduleModule, LevelsModule, WhatsappProvidersModule],
  controllers: [
    TeamWhatsappController,
    TeamAlertController,
    TeamPanoramaController,
  ],
  providers: [
    TeamWhatsappService,
    TeamAudienceService,
    TeamWhatsappScheduleService,
    TeamWhatsappResultsService,
    TeamWhatsappRetryService,
    TeamAlertPanelService,
    TeamAlertAckService,
    TeamAlertReminderService,
    TeamPanoramaService,
    TeamWhatsappRepository,
  ],
  exports: [TeamWhatsappRepository],
})
export class TeamWhatsappModule {}
