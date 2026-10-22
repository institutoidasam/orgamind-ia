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
import { CreateLevelDto } from './dto/create-level.dto';
import { ReorderLevelsDto } from './dto/reorder-levels.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { LevelsService } from './levels.service';

type AuthRequest = { user: JwtPayload };

/** Cadastro de níveis: todas as rotas só ADMIN (papel no controller, sem override por rota). Sem DELETE. */
@ApiTags('levels')
@Roles('ADMIN')
@Controller('internal/levels')
export class LevelsController {
  constructor(private readonly levels: LevelsService) {}

  @Get()
  @ApiOperation({
    summary: 'Níveis por ordem, com quantas pessoas têm cada um',
  })
  list() {
    return this.levels.list();
  }

  @Post()
  @ApiOperation({ summary: 'Cria nível no fim da ordem' })
  create(@Body() dto: CreateLevelDto, @Req() req: AuthRequest) {
    return this.levels.create(req.user.sub, dto);
  }

  @Put('order')
  @ApiOperation({
    summary: 'Reordena todos os níveis (1..n na ordem recebida)',
  })
  reorder(@Body() dto: ReorderLevelsDto, @Req() req: AuthRequest) {
    return this.levels.reorder(req.user.sub, dto.ids);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Renomeia, desativa ou reativa nível' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLevelDto,
    @Req() req: AuthRequest,
  ) {
    return this.levels.update(req.user.sub, id, dto);
  }
}
