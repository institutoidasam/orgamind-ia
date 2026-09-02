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
import {
  ConsentAdminService,
  type AdminPurposeView,
  type ConsentTextView,
  type SuggestedConsentText,
} from './consent-admin.service';
import {
  ConsentBulkGrantService,
  type BulkGrantResult,
} from './consent-bulk-grant.service';
import { CreatePurposeDto } from './dto/create-purpose.dto';
import { UpdatePurposeDto } from './dto/update-purpose.dto';
import { CreateConsentTextDto } from './dto/create-consent-text.dto';
import { BulkGrantDto } from './dto/bulk-grant.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

/**
 * Administração das finalidades e dos textos de consentimento (§2.2, §3.0).
 *
 * **ADMIN**, sem exceção: quem escreve o texto de consentimento escreve a PROVA.
 * Um texto que nomeia a organização errada, ou que omite como sair, produz
 * consentimentos inválidos — colhidos de gente real, e descobertos só na
 * fiscalização. A finalidade, por sua vez, é o que o gate consulta: criar uma
 * errada é abrir uma porta de envio.
 *
 * Convive com `ConsentController` no mesmo prefixo `consent` (lá ficam as
 * LEITURAS abertas a qualquer operador: `GET purposes` só das ativas, para o
 * wizard de campanha; `GET overview`). Os verbos de escrita vivem aqui.
 */
@ApiTags('consent')
@Roles('ADMIN')
@Controller('consent')
export class ConsentAdminController {
  constructor(
    private readonly admin: ConsentAdminService,
    private readonly bulk: ConsentBulkGrantService,
  ) {}

  @ApiOperation({
    summary:
      'Lista TODAS as finalidades (inclusive inativas), com os textos versionados e o que impede apagá-las',
  })
  @Get('purposes/all')
  listAll(): Promise<AdminPurposeView[]> {
    return this.admin.listPurposes();
  }

  @ApiOperation({ summary: 'Cria uma finalidade de consentimento' })
  @Post('purposes')
  createPurpose(
    @Body() dto: CreatePurposeDto,
    @Req() req: AuthRequest,
  ): Promise<AdminPurposeView> {
    return this.admin.createPurpose(dto, req.user.sub);
  }

  @ApiOperation({
    summary:
      'Edita rótulo/descrição/sensibilidade/ativo de uma finalidade. A key é imutável — ela é a chave estável da trilha',
  })
  @Patch('purposes/:key')
  updatePurpose(
    @Param('key') key: string,
    @Body() dto: UpdatePurposeDto,
    @Req() req: AuthRequest,
  ): Promise<AdminPurposeView> {
    return this.admin.updatePurpose(key, dto, req.user.sub);
  }

  @ApiOperation({
    summary:
      'Apaga uma finalidade que NUNCA foi usada. Com consentimento vinculado, recusa (409) e manda desativar — a trilha é prova e não se apaga',
  })
  @HttpCode(204)
  @Delete('purposes/:key')
  deletePurpose(
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ): Promise<void> {
    return this.admin.deletePurpose(key, req.user.sub);
  }

  @ApiOperation({
    summary:
      'Rascunho de uma nova versão do texto, composta com a identidade CONFIGURADA da organização. Diz também se o texto vigente já nomeia esta organização — quando não nomeia, os consentimentos colhidos por ele são inválidos e o operador precisa publicar uma versão nova',
  })
  @Get('texts/suggested')
  suggestText(
    @Query('purposeKey') purposeKey: string,
  ): Promise<SuggestedConsentText> {
    return this.admin.suggestText(purposeKey);
  }

  @ApiOperation({
    summary:
      'Publica uma NOVA versão do texto de consentimento da finalidade. Não altera as versões anteriores: os consentimentos já colhidos apontam para o texto que a pessoa viu',
  })
  @Post('texts')
  publishText(
    @Body() dto: CreateConsentTextDto,
    @Req() req: AuthRequest,
  ): Promise<ConsentTextView> {
    return this.admin.publishText(dto, req.user.sub);
  }

  @ApiOperation({
    summary:
      'Quantos contatos o registro em massa afetaria (concedidos / pulados por supressão / já tinham). Não grava nada',
  })
  @HttpCode(200)
  @Post('bulk-grant/preview')
  bulkGrantPreview(@Body() dto: BulkGrantDto): Promise<BulkGrantResult> {
    return this.bulk.preview(dto);
  }

  @ApiOperation({
    summary:
      'Registra consentimento da BASE EXISTENTE (§6.2 C2): base legal colhida fora do WhatsApp, com evidência obrigatória (onde + quando). Nunca concede a quem está suprimido; idempotente; auditado com a identificação do operador',
  })
  @HttpCode(200)
  @Post('bulk-grant')
  bulkGrant(
    @Body() dto: BulkGrantDto,
    @Req() req: AuthRequest,
  ): Promise<BulkGrantResult> {
    // O ator vai para a evidência (o `evidenceText` é assinado com o e-mail
    // dele) e para a auditoria. Quem declara, se identifica.
    return this.bulk.apply(dto, { id: req.user.sub, email: req.user.email });
  }
}
