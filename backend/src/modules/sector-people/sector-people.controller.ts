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
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { AddFromContactsDto } from './dto/add-from-contacts.dto';
import { CreateSectorPersonDto } from './dto/create-sector-person.dto';
import { ListCandidatesQueryDto } from './dto/list-candidates.query';
import { MovePeopleDto } from './dto/move-people.dto';
import { UpdateSectorPersonDto } from './dto/update-sector-person.dto';
import { SectorPeopleService } from './sector-people.service';
import { SectorPeopleWriteService } from './sector-people-write.service';

type AuthRequest = { user: JwtPayload };

/**
 * Página do setor (C3). Papel de escrita no controller (VIEWER fora); quem
 * pode qual setor é da política P1, aplicada no serviço.
 */
@ApiTags('sector-people')
@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
@Controller('internal/sectors/:sectorId/people')
export class SectorPeopleController {
  constructor(
    private readonly people: SectorPeopleService,
    private readonly write: SectorPeopleWriteService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Setor, pessoas ativas dele e opções de nível e turno',
  })
  list(@Param('sectorId') sectorId: string, @Req() req: AuthRequest) {
    return this.people.list(req.user.sub, sectorId);
  }

  @Get('candidates')
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
  @ApiOperation({ summary: 'Contatos para cadastrar como pessoas do setor' })
  contactCandidates(
    @Param('sectorId') sectorId: string,
    @Query() query: ListCandidatesQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.people.contactCandidates(req.user.sub, sectorId, query.q);
  }

  @Post()
  @ApiOperation({ summary: 'Nova pessoa sem acesso neste setor' })
  create(
    @Param('sectorId') sectorId: string,
    @Body() body: CreateSectorPersonDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.create(req.user.sub, sectorId, body);
  }

  @Post('from-contacts')
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
  @HttpCode(200)
  @ApiOperation({ summary: 'Traz pessoas já cadastradas para o setor' })
  move(
    @Param('sectorId') sectorId: string,
    @Body() body: MovePeopleDto,
    @Req() req: AuthRequest,
  ) {
    return this.write.move(req.user.sub, sectorId, body.userIds);
  }

  @Patch(':userId')
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

  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Tira do setor pessoa sem acesso' })
  remove(
    @Param('sectorId') sectorId: string,
    @Param('userId') userId: string,
    @Req() req: AuthRequest,
  ) {
    return this.write.remove(req.user.sub, sectorId, userId);
  }
}
