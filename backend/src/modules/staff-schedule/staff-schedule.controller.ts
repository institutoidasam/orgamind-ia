import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { BoardQueryDto } from './dto/board-query.dto';
import { CreateExceptionDto } from './dto/create-exception.dto';
import { PutScheduleDto } from './dto/put-schedule.dto';
import { StaffScheduleEditService } from './staff-schedule-edit.service';
import { StaffScheduleService } from './staff-schedule.service';

type AuthRequest = { user: JwtPayload };

/**
 * Escala da equipe. VIEWER é barrado pelo RolesGuard; entre os demais papéis,
 * quem decide é a política do serviço (ADMIN ou gestor de setor, senão 403).
 */
@ApiTags('staff-schedule')
@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
@Controller('internal/staff-schedule')
export class StaffScheduleController {
  constructor(
    private readonly schedule: StaffScheduleService,
    private readonly edit: StaffScheduleEditService,
  ) {}

  @Get('options')
  @ApiOperation({ summary: 'Hoje, setores alcançados e turnos ativos' })
  options(@Req() req: AuthRequest) {
    return this.schedule.options(req.user.sub);
  }

  @Get('board')
  @ApiOperation({
    summary: 'Quadro da escala do setor no período (até 42 dias)',
  })
  board(@Query() query: BoardQueryDto, @Req() req: AuthRequest) {
    return this.schedule.board(req.user.sub, query);
  }

  @Put('users/:userId/schedule')
  @ApiOperation({ summary: 'Grava o ciclo da pessoa (um item por dia)' })
  putSchedule(
    @Param('userId') userId: string,
    @Body() dto: PutScheduleDto,
    @Req() req: AuthRequest,
  ) {
    return this.edit.putSchedule(req.user.sub, userId, dto);
  }

  @Delete('users/:userId/schedule')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Apaga o ciclo; a pessoa volta ao turno do cadastro',
  })
  deleteSchedule(@Param('userId') userId: string, @Req() req: AuthRequest) {
    return this.edit.deleteSchedule(req.user.sub, userId);
  }

  @Post('users/:userId/exceptions')
  @ApiOperation({
    summary: 'Cria exceção, recortando as anteriores nos dias em comum',
  })
  createException(
    @Param('userId') userId: string,
    @Body() dto: CreateExceptionDto,
    @Req() req: AuthRequest,
  ) {
    return this.edit.createException(req.user.sub, userId, dto);
  }

  @Delete('exceptions/:exceptionId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a exceção inteira' })
  deleteException(
    @Param('exceptionId') exceptionId: string,
    @Req() req: AuthRequest,
  ) {
    return this.edit.deleteException(req.user.sub, exceptionId);
  }
}
