import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
import { CreateTwilioTemplateDto } from './dto/create-twilio-template.dto';
import { CreateZernioTemplateDto } from './dto/create-zernio-template.dto';
import { DeclareConsentButtonsDto } from './dto/declare-consent-buttons.dto';
import { UpdateTwilioDraftDto } from './dto/update-twilio-draft.dto';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @ApiOperation({ summary: 'List approved WhatsApp templates' })
  @Get()
  list(@Query() query: ListTemplatesDto) {
    return this.templates.list(query.provider);
  }

  @ApiOperation({ summary: 'Sync template catalog from Meta Cloud API' })
  @Roles('ADMIN')
  @Post('sync')
  sync() {
    return this.templates.syncFromMeta();
  }

  @ApiOperation({ summary: 'Sync template catalog from Zernio' })
  @Roles('ADMIN')
  @Post('sync/zernio')
  syncZernio() {
    return this.templates.syncFromZernio();
  }

  @ApiOperation({ summary: 'Create a new template (Evolution mode / manual)' })
  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateTemplateDto) {
    return this.templates.create(body);
  }

  // ── ZB: criar template COM BOTÕES no Zernio ──────────────────────────────

  /**
   * A lista fechada de rótulos de consentimento que o form pode oferecer.
   *
   * Servida pelo backend porque o frontend NÃO pode ter uma cópia: a lista que a
   * UI oferece e a lista que o webhook reconhece TÊM de ser a mesma, e duas
   * cópias divergem em silêncio — apagando consentimento. Sem cópia, nada
   * diverge. (Não é ADMIN-only: é só um vocabulário, e o form precisa dele para
   * sequer renderizar.)
   */
  @ApiOperation({
    summary: 'Closed list of recognized consent button labels (opt-in/opt-out)',
  })
  @Get('consent-buttons')
  consentButtons() {
    return this.templates.consentButtonChoices();
  }

  @ApiOperation({
    summary: 'Create a WhatsApp template (with buttons) on Meta, via Zernio',
  })
  @Roles('ADMIN')
  @Post('zernio')
  createZernio(@Body() body: CreateZernioTemplateDto) {
    return this.templates.createZernio(body);
  }

  /**
   * Diz o que cada botão de resposta rápida de um template IMPORTADO significa.
   *
   * Um template criado direto no painel do Zernio chega pelo sync sem essa
   * declaração — e do rótulo sozinho é indecidível se "Bora, quero!" é um botão
   * comum ou o "sim" de um opt-in (a diferença entre 13.400 consentimentos
   * documentados e zero). Até alguém declarar, o gate de campanha recusa o
   * template. Aqui é onde se declara — e uma declaração que o reconhecedor
   * desmente é REJEITADA (marcar "Bora, quero!" como opt-in não faz o clique
   * passar a ser lido).
   */
  @ApiOperation({
    summary: 'Declare the consent role of each quick-reply button (Zernio)',
  })
  @Roles('ADMIN')
  @Patch(':id/consent-buttons')
  declareConsentButtons(
    @Param('id') id: string,
    @Body() body: DeclareConsentButtonsDto,
  ) {
    return this.templates.declareConsentButtons(id, body);
  }

  @ApiOperation({ summary: 'Update an existing template' })
  @Roles('ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateTemplateDto) {
    return this.templates.update(id, body);
  }

  @ApiOperation({ summary: 'Delete a template (refused if in use)' })
  @Roles('ADMIN')
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.templates.delete(id);
  }

  // ── twilio-platform T4: Content API (criar/submeter/editar rascunho) ──────

  @ApiOperation({
    summary: 'Create a Twilio Content template draft (Content API)',
  })
  @Roles('ADMIN')
  @Post('twilio')
  createTwilio(@Body() body: CreateTwilioTemplateDto) {
    return this.templates.createTwilio(body);
  }

  @ApiOperation({
    summary: 'Submit a Twilio draft for WhatsApp approval (draft only)',
  })
  @Roles('ADMIN')
  @Post(':id/twilio-submit')
  submitTwilio(@Param('id') id: string) {
    return this.templates.submitTwilioApproval(id);
  }

  @ApiOperation({
    summary: 'Update a Twilio Content draft (pre-submission only)',
  })
  @Roles('ADMIN')
  @Patch(':id/twilio-draft')
  updateTwilioDraft(
    @Param('id') id: string,
    @Body() body: UpdateTwilioDraftDto,
  ) {
    return this.templates.updateTwilioDraft(id, body);
  }
}
