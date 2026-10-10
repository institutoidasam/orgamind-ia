import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { InternalNumbersService } from './internal-numbers.service';
import {
  CreateInternalNumberDto,
  ListInternalNumbersDto,
  UpdateInternalNumberDto,
} from './dto/internal-number.dto';

@ApiTags('internal-numbers')
@Roles('ADMIN')
@Controller('internal/numbers')
export class InternalNumbersController {
  constructor(private readonly numbers: InternalNumbersService) {}

  @Get()
  list(@Query() query: ListInternalNumbersDto) {
    return this.numbers.list(query.page, query.pageSize);
  }

  @Post()
  create(@Body() body: CreateInternalNumberDto) {
    return this.numbers.create(body);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.numbers.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateInternalNumberDto) {
    return this.numbers.update(id, body);
  }
}
