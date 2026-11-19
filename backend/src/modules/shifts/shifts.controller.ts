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
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { CreateShiftDto } from './dto/create-shift.dto';
import { ReorderShiftsDto } from './dto/reorder-shifts.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { ShiftsService } from './shifts.service';

type AuthRequest = { user: JwtPayload };

/** Cadastro de turnos: todas as rotas pela permissão estrutura.manter (na classe, sem override por rota). */
@ApiTags('shifts')
@RequirePermission('estrutura.manter')
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
