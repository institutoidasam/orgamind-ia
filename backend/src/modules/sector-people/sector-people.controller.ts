import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { AddFromContactsDto } from './dto/add-from-contacts.dto';
import { CreateSectorPersonDto } from './dto/create-sector-person.dto';
import { ListCandidatesQueryDto } from './dto/list-candidates.query';
import { ListSectorPeopleQueryDto } from './dto/list-sector-people.query';
import { MovePeopleDto } from './dto/move-people.dto';
import { RemoveSectorPersonDto } from './dto/remove-sector-person.dto';
import { SetSectorPersonStatusDto } from './dto/set-sector-person-status.dto';
import { UpdateSectorPersonDto } from './dto/update-sector-person.dto';
import { SectorPeopleService } from './sector-people.service';
import { SectorPeopleWriteService } from './sector-people-write.service';

type AuthRequest = { user: JwtPayload };

/**
 * Página do setor (C3). Leituras por papel em cada handler (VIEWER fora);
 * escritas por permissão (`pessoas.editar`; a inativação, `pessoas.inativar`).
 * Quem pode qual setor é da política P1, aplicada no serviço e somada a isto.
 */
@ApiTags('sector-people')
@Controller('internal/sectors/:sectorId/people')
export class SectorPeopleController {
  constructor(
    private readonly people: SectorPeopleService,
    private readonly write: SectorPeopleWriteService,
  ) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Setor, pessoas dele (inativas só com includeInactive) e opções de nível e turno',
  })
  list(
    @Param('sectorId') sectorId: string,
    @Query() query: ListSectorPeopleQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.people.list(req.user.sub, sectorId, query.includeInactive);
  }

  @Get('candidates')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Pessoas já cadastradas que podem vir para o setor',
  })
  candidates(
    @Param('sectorId') sectorId: string,
    @Query() query: ListCandidatesQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.people.candidates(req.user.sub, sectorId, query.q);
  }

  @Get('contact-candidates')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({ summary: 'Contatos para cadastrar como pessoas do setor' })
  contactCandidates(
    @Param('sectorId') sectorId: string,
    @Query() query: ListCandidatesQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.people.contactCandidates(req.user.sub, sectorId, query.q);
  }

  @Post()
  @RequirePermission('pessoas.editar')
  @ApiOperation({ summary: 'Nova pessoa sem acesso neste setor' })
  create(
    @Param('sectorId') sectorId: string,
    @Body() body: CreateSectorPersonDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.create(req.user.sub, sectorId, body);
  }

  @Post('from-contacts')
  @RequirePermission('pessoas.editar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pessoas do setor a partir de contatos, em lote' })
  addFromContacts(
    @Param('sectorId') sectorId: string,
    @Body() body: AddFromContactsDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.addFromContacts(req.user.sub, sectorId, body);
  }

  @Post('move')
  @RequirePermission('pessoas.editar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Traz pessoas já cadastradas para o setor' })
  move(
    @Param('sectorId') sectorId: string,
    @Body() body: MovePeopleDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.move(req.user.sub, sectorId, body.userIds, body.reason);
  }

  @Patch(':userId')
  @RequirePermission('pessoas.editar')
  @ApiOperation({
    summary: 'Edita pessoa do setor (com acesso: nível, função, turno)',
  })
  update(
    @Param('sectorId') sectorId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateSectorPersonDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.update(req.user.sub, sectorId, userId, body);
  }

  @Post(':userId/status')
  @RequirePermission('pessoas.inativar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inativa ou reativa pessoa do setor, com motivo' })
  setStatus(
    @Param('sectorId') sectorId: string,
    @Param('userId') userId: string,
    @Body() body: SetSectorPersonStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.setStatus(req.user.sub, sectorId, userId, body);
  }

  @Delete(':userId')
  @RequirePermission('pessoas.editar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Tira do setor pessoa sem acesso' })
  remove(
    @Param('sectorId') sectorId: string,
    @Param('userId') userId: string,
    @Body() body: RemoveSectorPersonDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.remove(req.user.sub, sectorId, userId, body.reason);
  }
}
