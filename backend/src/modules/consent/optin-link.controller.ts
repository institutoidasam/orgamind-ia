import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { OptInLinkService, type OptInLinkView } from './optin-link.service';
import { CreateOptInLinkDto } from './dto/create-optin-link.dto';
import { SetOptInLinkActiveDto } from './dto/set-optin-link-active.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

/**
 * C3 — os pontos de coleta wa.me/QR (spec §3.1).
 *
 * **ADMIN**: gerar um link é decidir de onde virá consentimento, com que
 * finalidade e sob que texto — e o token acaba impresso num cartaz que ninguém
 * recolhe. Um token errado (ou uma finalidade errada) contamina todos os GRANTs
 * que passarem por ele, e a correção não é um `UPDATE`: é reimprimir o cartaz.
 *
 * Não há DELETE de propósito. Um ponto de coleta que já produziu consentimentos
 * é parte da trilha de prova (art. 8º §2º) — desativa-se, não se apaga. Revogar
 * ≠ apagar, e isso vale para o link tanto quanto para o consentimento.
 */
@ApiTags('consent')
@Roles('ADMIN')
@Controller('consent/links')
export class OptInLinkController {
  constructor(private readonly links: OptInLinkService) {}

  @ApiOperation({
    summary:
      'Lista os pontos de coleta wa.me/QR com o funil por token (quantos GRANTs vieram de cada um)',
  })
  @Get()
  list(): Promise<OptInLinkView[]> {
    return this.links.list();
  }

  @ApiOperation({
    summary:
      'Cria um ponto de coleta: gera o link wa.me cujo texto pré-preenchido é a declaração de consentimento da finalidade',
  })
  @Post()
  create(
    @Body() dto: CreateOptInLinkDto,
    @Req() req: AuthRequest,
  ): Promise<OptInLinkView> {
    return this.links.create(dto, req.user.sub);
  }

  @ApiOperation({
    summary:
      'Ativa/desativa um ponto de coleta. Desativar tira o link de circulação; NÃO invalida os consentimentos já colhidos por ele',
  })
  @Patch(':id')
  setActive(
    @Param('id') id: string,
    @Body() dto: SetOptInLinkActiveDto,
  ): Promise<OptInLinkView> {
    return this.links.setActive(id, dto.active);
  }
}
