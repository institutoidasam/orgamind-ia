import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import {
  CreateTeamDispatchDto,
  PreviewTeamDispatchDto,
} from './dto/create-team-dispatch.dto';
import { DispatchListQueryDto } from './dto/dispatch-list-query.dto';
import { DispatchRecipientsQueryDto } from './dto/dispatch-recipients-query.dto';
import { PageQueryDto } from './dto/page-query.dto';
import { PersonRouteQueryDto } from './dto/person-route-query.dto';
import {
  retryRecipientsSchema,
  type RetryRecipientsInput,
} from './dto/retry-recipients.dto';
import { RosterQueryDto } from './dto/roster-query.dto';
import { TeamAudienceService } from './team-audience.service';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappService } from './team-whatsapp.service';

type AuthRequest = { user: JwtPayload };

/**
 * WhatsApp da equipe. Leituras: VIEWER é barrado pelo RolesGuard. Prévia,
 * enviar, cancelar e repetir: o portão é `equipe.enviar` (PermissionsGuard).
 * Entre quem passa, quem decide é a política do serviço (ADMIN ou gestor de
 * setor, senão 403) e, no envio a todos os setores, `equipe.disparo_amplo`.
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamWhatsappController {
  /**
   * Prévia do público (C4). Injetado por propriedade para o construtor não
   * passar de quatro parâmetros (limite do gate).
   */
  @Inject(TeamAudienceService)
  private readonly audience!: TeamAudienceService;

  constructor(
    private readonly team: TeamWhatsappService,
    private readonly schedule: TeamWhatsappScheduleService,
    private readonly results: TeamWhatsappResultsService,
    private readonly retryService: TeamWhatsappRetryService,
  ) {}

  @Get('targets')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Canais e setores para os quais o remetente pode enviar',
  })
  targets(@Req() req: AuthRequest) {
    return this.team.targets(req.user.sub);
  }

  @Get('roster')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Escala do setor na data: quem está escalado, de folga ou sem escala',
  })
  roster(@Query() query: RosterQueryDto, @Req() req: AuthRequest) {
    return this.team.roster(req.user.sub, query);
  }

  @Get('person-route')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Número pelo qual a pessoa recebe hoje: o da área onde ela atua, com o estado ao vivo',
  })
  personRoute(@Query() query: PersonRouteQueryDto, @Req() req: AuthRequest) {
    return this.team.personRoute(req.user.sub, query.userId);
  }

  @Post('dispatches')
  @HttpCode(202)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Enfileira um recado de WhatsApp para um usuário ou setor, ou agenda para o início do turno',
  })
  createDispatch(@Body() dto: CreateTeamDispatchDto, @Req() req: AuthRequest) {
    return this.team.dispatch(req.user.sub, dto);
  }

  /**
   * Prévia (C4, CF1): mesma porta do POST dispatches (`equipe.enviar`, sem
   * `@Roles`) e 200, pois não enfileira nada. Alcance nos setores e disparo
   * amplo são conferidos no serviço, como no envio.
   */
  @Post('dispatches/preview')
  @HttpCode(200)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Prévia do envio a setores por finalidade: quem recebe, quem fica de fora e por quê, e as travas',
  })
  preview(@Body() dto: PreviewTeamDispatchDto, @Req() req: AuthRequest) {
    return this.audience.preview(req.user.sub, dto);
  }

  @Get('dispatches')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Histórico de envios, paginado, com filtros de período, finalidade e situação (ADMIN vê todos; os demais, os próprios)',
  })
  listDispatches(
    @Query() query: DispatchListQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.team.listDispatches(req.user.sub, query);
  }

  @Get('dispatches/:id')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Resultado de um envio: contagens, números e quem ficou de fora (ADMIN vê todos; os demais, os próprios; senão 404)',
  })
  dispatchDetail(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.results.detail(req.user.sub, id);
  }

  @Get('dispatches/:id/recipients')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Destinatários de um envio, por nome e paginados, com filtro por situação e busca pelo nome exibido (mesma visibilidade do detalhe)',
  })
  dispatchRecipients(
    @Param('id') id: string,
    @Query() query: DispatchRecipientsQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.results.recipients(req.user.sub, id, query);
  }

  @Get('scheduled')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Envios agendados ainda não disparados, paginado (ADMIN vê todos; gestor, os dos seus setores)',
  })
  listScheduled(@Query() page: PageQueryDto, @Req() req: AuthRequest) {
    return this.schedule.listScheduled(req.user.sub, page);
  }

  @Post('dispatches/:id/cancel')
  @HttpCode(200)
  @RequirePermission('equipe.enviar')
  @ApiOperation({ summary: 'Cancela um envio agendado antes do disparo' })
  cancel(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.schedule.cancel(req.user.sub, id);
  }

  @Post('dispatches/:id/retry')
  @HttpCode(200)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Repete as falhas certas de um envio (uma, várias ou todas); quem vê o envio e pode enviar à área',
  })
  retry(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(retryRecipientsSchema))
    dto: RetryRecipientsInput,
    @Req() req: AuthRequest,
  ) {
    return this.retryService.retry(req.user.sub, id, dto);
  }
}
