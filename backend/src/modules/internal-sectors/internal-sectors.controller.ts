import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import {
  CreateSectorDto,
  ListSectorsDto,
  MembersQueryDto,
  UpdateSectorDto,
} from './dto';
import { InternalSectorsService } from './internal-sectors.service';
type AuthRequest = { user: JwtPayload };
@ApiTags('internal-sectors')
@Controller('internal/sectors')
export class InternalSectorsController {
  constructor(private readonly sectors: InternalSectorsService) {}
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER') @Get() list(
    @Query() q: ListSectorsDto,
  ) {
    return this.sectors.list(q.page, q.pageSize, q.activeOnly);
  }
  @Roles('ADMIN') @Post() create(
    @Body() dto: CreateSectorDto,
    @Req() req: AuthRequest,
  ) {
    return this.sectors.create(dto, req.user.sub);
  }
  @Roles('ADMIN') @Get(':id') get(@Param('id') id: string) {
    return this.sectors.get(id);
  }
  @Roles('ADMIN') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: UpdateSectorDto,
    @Req() req: AuthRequest,
  ) {
    return this.sectors.update(id, dto, req.user.sub);
  }
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER')
  @Get(':id/members')
  members(@Param('id') id: string, @Query() q: MembersQueryDto) {
    return this.sectors.members(id, q.eligible);
  }
}
