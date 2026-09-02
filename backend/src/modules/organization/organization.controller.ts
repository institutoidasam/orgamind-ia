import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  OrganizationService,
  type OrganizationView,
} from './organization.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

/**
 * Identidade da organização — **ADMIN**.
 *
 * Quem edita este registro edita o nome que aparece no consentimento de todos os
 * titulares daqui para a frente. É a mesma gravidade de escrever o texto de
 * consentimento: por isso mora ao lado dele, atrás de ADMIN.
 */
@ApiTags('organization')
@Roles('ADMIN')
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @ApiOperation({
    summary:
      'Identidade da organização titular deste deploy (nome, razão social, política de privacidade, contato)',
  })
  @Get()
  get(): Promise<OrganizationView> {
    return this.organization.get();
  }

  @ApiOperation({
    summary:
      'Edita a identidade da organização. NÃO reescreve consentimento já colhido: os textos publicados e os eventos seguem apontando para o que a pessoa leu. Para colher com o nome novo, publique uma nova versão do texto de consentimento',
  })
  @Patch()
  update(
    @Body() dto: UpdateOrganizationDto,
    @Req() req: AuthRequest,
  ): Promise<OrganizationView> {
    return this.organization.update(dto, req.user.sub);
  }
}

/**
 * A MESMA identidade, aberta.
 *
 * A landing `/opt-in` é pública (aberta por QR de cartaz, no celular de quem não
 * tem conta no orgamind) e precisa nomear a organização no cabeçalho, no título e
 * na tela de erro — inclusive quando o texto de consentimento nem carregou. Não
 * há segredo aqui: esta identidade está impressa no cartaz que gerou o QR.
 */
@ApiTags('organization')
@Public()
@Controller('public')
export class PublicOrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @ApiOperation({
    summary: 'Identidade pública da organização (o que a landing de opt-in exibe)',
  })
  @Get('organization')
  get(): Promise<OrganizationView> {
    return this.organization.get();
  }
}
