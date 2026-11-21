import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { manualAckSchema, type ManualAckInput } from './dto/manual-ack.dto';
import {
  sendReminderSchema,
  type SendReminderInput,
} from './dto/send-reminder.dto';
import { TeamAlertAckService } from './team-alert-ack.service';
import { TeamAlertPanelService } from './team-alert-panel.service';
import {
  TeamAlertReminderService,
  type TeamReminderResponse,
} from './team-alert-reminder.service';

type AuthRequest = { user: JwtPayload };

/**
 * Alerta urgente (Lote I, DI13): mesmo prefixo e mesmos guards globais do
 * `TeamWhatsappController`, que não muda. Leitura só com `@Roles(...)` (VIEWER
 * barrado pelo RolesGuard); escrita só com `@RequirePermission('equipe.enviar')`;
 * nunca os dois na mesma rota. Ver o painel não exige a chave da urgência (I1).
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamAlertController {
  /** Lembrete aos pendentes (CI7); por propriedade, para o construtor das rotas da T6/T7 não mudar (GI8). */
  @Inject(TeamAlertReminderService)
  private readonly reminder!: TeamAlertReminderService;

  constructor(
    private readonly panel: TeamAlertPanelService,
    private readonly ack: TeamAlertAckService,
  ) {}

  @Get('dispatches/:id/alert')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Painel de pendências do alerta urgente: grupos, ciência, respostas e lembretes (quem vê o envio; senão 404; sem prazo gravado, 422)',
  })
  alertPanel(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.panel.getPanel(req.user.sub, id);
  }

  /** Ciência manual (I5, CI6): a chave `equipe.urgencia` é checada no serviço, antes do 404. */
  @Post('dispatches/:id/recipients/:recipientId/ack')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Marca a pessoa do alerta como ciente, com observação (quem vê o envio e tem equipe.urgencia; já ciente → 422)',
  })
  async markAck(
    @Param('id') id: string,
    @Param('recipientId') recipientId: string,
    @Body(new ZodValidationPipe(manualAckSchema)) dto: ManualAckInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.ack.markManual(req.user.sub, id, recipientId, {
      note: dto.note,
      now: new Date(),
    });
  }

  /** Desfaz só a ciência manual; com um "OK" já recebido, ela vira automática (DI7). */
  @Delete('dispatches/:id/recipients/:recipientId/ack')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Desfaz a ciência manual (a automática não; com OK já recebido, passa a automática)',
  })
  async undoAck(
    @Param('id') id: string,
    @Param('recipientId') recipientId: string,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.ack.undoManual(req.user.sub, id, recipientId);
  }

  /**
   * Lembrete aos pendentes (I7, DI10): a chave `equipe.urgencia`, a área e as
   * recusas ficam no serviço; o relógio é lido aqui (GI9).
   */
  @Post('dispatches/:id/reminders')
  @HttpCode(202)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Lembrete aos pendentes do alerta: só os elegíveis entre os ids pedidos (vazio → 422; 3 lembretes ou menos de 5 min → 409; canal fechado → 409)',
  })
  sendReminder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sendReminderSchema)) dto: SendReminderInput,
    @Req() req: AuthRequest,
  ): Promise<TeamReminderResponse> {
    return this.reminder.send(
      req.user.sub,
      id,
      { recipientIds: dto.recipientIds },
      new Date(),
    );
  }
}
