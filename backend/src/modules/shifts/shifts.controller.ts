import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { CreateShiftDto } from './dto/create-shift.dto';
import { ReorderShiftsDto } from './dto/reorder-shifts.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { ShiftsService } from './shifts.service';

type AuthRequest = { user: JwtPayload };

/** Cadastro de turnos: todas as rotas só ADMIN (papel no controller, sem override por rota). */
@ApiTags('shifts')
@Roles('ADMIN')
@Controller('internal/shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  @ApiOperation({ summary: 'Turnos por ordem, com os motivos de "em uso"' })
  list() {
    return this.shifts.list();
  }

  @Post()
  @ApiOperation({ summary: 'Cria turno no fim da ordem' })
  create(@Body() dto: CreateShiftDto, @Req() req: AuthRequest) {
    return this.shifts.create(req.user.sub, dto);
  }

  @Put('order')
  @ApiOperation({
    summary: 'Reordena todos os turnos (1..n na ordem recebida)',
  })
  reorder(@Body() dto: ReorderShiftsDto, @Req() req: AuthRequest) {
    return this.shifts.reorder(req.user.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita, desativa ou reativa turno' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateShiftDto,
    @Req() req: AuthRequest,
  ) {
    return this.shifts.update(req.user.sub, id, dto);
  }
}
