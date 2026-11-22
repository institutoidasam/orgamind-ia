import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { InternalNumbersService } from './internal-numbers.service';
import { ListInternalNumbersDto } from './dto/internal-number.dto';

/**
 * D4: o cadastro de números por setor foi aposentado. A tabela e a leitura
 * ficam; a área de um número é definida só em Conexões (`Sector.channelId`).
 */
@ApiTags('internal-numbers')
@Roles('ADMIN')
@Controller('internal/numbers')
export class InternalNumbersController {
  constructor(private readonly numbers: InternalNumbersService) {}

  @Get()
  list(@Query() query: ListInternalNumbersDto) {
    return this.numbers.list(query.page, query.pageSize);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.numbers.findById(id);
  }
}
