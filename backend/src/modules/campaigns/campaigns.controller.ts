import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CampaignsService } from './campaigns.service';
import { PreviewCampaignDto } from './dto/preview-campaign.dto';
import { PreflightChecksDto } from './dto/preflight-checks.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { ListCampaignMessagesDto } from './dto/list-messages.dto';
import {
  SendCampaignBatchDto,
  ListCampaignRecipientsDto,
} from './dto/send-batch.dto';
import { RedispatchCampaignDto } from './dto/redispatch-campaign.dto';
import { ReleaseUnconfirmedSentDto } from './dto/release-unconfirmed-sent.dto';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @ApiOperation({ summary: 'List campaigns ordered by creation date' })
  @Get()
  list() {
    return this.campaigns.list();
  }

  @ApiOperation({ summary: 'Fetch campaign with stats and recent messages' })
  @Get(':id')
  get(@Param('id') id: string) {
    return this.campaigns.getById(id);
  }

  @ApiOperation({
    summary:
      'Return a WhatsApp reachability summary for the campaign audience (cached, no live scan)',
  })
  @Get(':id/preflight')
  preflight(@Param('id') id: string) {
    return this.campaigns.preflight(id);
  }

  @ApiOperation({
    summary: 'Count messages waiting for a disconnected instance to reconnect',
  })
  @Get(':id/waiting')
  waiting(@Param('id') id: string) {
    return this.campaigns.waitingByCampaign(id);
  }

  @ApiOperation({
    summary: 'List campaign messages with status/search filters and pagination',
  })
  @Get(':id/messages')
  listMessages(@Param('id') id: string, @Query() q: ListCampaignMessagesDto) {
    return this.campaigns.listMessages(id, q);
  }

  @ApiOperation({ summary: 'Preview audience size for given filters' })
  @Post('preview')
  preview(@Body() body: PreviewCampaignDto) {
    return this.campaigns.preview(
      body.filters,
      body.limit,
      body.templateId,
      body.excludeAnyPreviousCampaign,
    );
  }

  @ApiOperation({
    summary:
      'WhatsApp reachability pre-flight for a filter group (wizard, before campaign is created)',
  })
  @Post('preflight')
  preflightByFilters(@Body() body: PreviewCampaignDto) {
    return this.campaigns.preflightByFilters(body.filters);
  }

  @ApiOperation({
    summary:
      'Send analysis (anti-ban checks) for a filter group + instance + schedule (wizard, before the campaign is created)',
  })
  @Post('preflight-checks')
  preflightChecks(@Body() body: PreflightChecksDto) {
    return this.campaigns.preflightChecks(body);
  }

  @ApiOperation({ summary: 'Create a draft campaign' })
  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateCampaignDto) {
    return this.campaigns.create(body);
  }

  @ApiOperation({ summary: 'Cancel a campaign (stops further sends)' })
  @Roles('ADMIN')
  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.campaigns.cancel(id);
  }

  /**
   * APAGAR a campanha — de vez.
   *
   * Destrutivo e assimétrico: o CASCADE leva junto as Message da campanha, que
   * são as BOLHAS DO INBOX. Apagar uma campanha que enviou de verdade arranca
   * essas bolhas das conversas. A tela avisa ANTES, com o número de mensagens, e
   * exige confirmação — o backend não tem como saber se o operador leu, então o
   * aviso é responsabilidade da UI e o guard-rail (campanha em voo) é daqui.
   *
   * Os CONSENTIMENTOS não são afetados: ConsentEvent não tem FK para Campaign e
   * é protegido por trigger no banco.
   */
  @ApiOperation({ summary: 'Delete a campaign (cascades its messages)' })
  @Roles('ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.campaigns.remove(id);
  }

  /**
   * F1 T9 — alimenta o aviso da tela de apagar: quais Segmentos citam esta
   * campanha num nó history e ficam "cegos" para ela assim que o registro de
   * quem recebeu (Message, CASCADE) sumir. Só leitura — mesma política de
   * /preflight, /waiting e /batch-summary (não é @Roles('ADMIN')).
   */
  @ApiOperation({
    summary:
      'Segments whose filter has a history node targeting this campaign (feeds the delete-campaign warning)',
  })
  @Get(':id/dependent-segments')
  dependentSegments(@Param('id') id: string) {
    return this.campaigns.getDependentSegments(id);
  }

  @ApiOperation({ summary: 'Transition campaign DRAFT → QUEUED + enqueue' })
  @Roles('ADMIN')
  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.campaigns.run(id);
  }

  @ApiOperation({ summary: 'Re-enqueue all FAILED messages of a campaign' })
  @Roles('ADMIN')
  @Post(':id/retry-failed')
  retryFailed(@Param('id') id: string) {
    return this.campaigns.retryFailedMessages(id);
  }

  // ── ZE — CAMPANHA EM LOTES ────────────────────────────────────────────────

  @ApiOperation({
    summary:
      'Enviar um LOTE: "enviar agora para N contatos". Resolve sozinho PARA QUEM — ' +
      'só quem ainda não foi contatado nesta campanha e não é inalcançável para marketing.',
  })
  @Roles('ADMIN')
  @Post(':id/batches')
  sendBatch(@Param('id') id: string, @Body() body: SendCampaignBatchDto) {
    return this.campaigns.sendBatch(id, body.size);
  }

  @ApiOperation({
    summary:
      'Enviados × Pendentes × Inalcançáveis da campanha (os números do painel de lotes)',
  })
  @Get(':id/batch-summary')
  batchSummary(@Param('id') id: string) {
    return this.campaigns.batchSummary(id);
  }

  @ApiOperation({
    summary: 'Histórico dos lotes da campanha (quando, quantos, resultado)',
  })
  @Get(':id/batches')
  listBatches(@Param('id') id: string) {
    return this.campaigns.listBatches(id);
  }

  @ApiOperation({
    summary:
      'Destinatários por grupo: enviados × pendentes (não enviados) × inalcançáveis × falhados',
  })
  @Get(':id/recipients')
  listRecipients(
    @Param('id') id: string,
    @Query() q: ListCampaignRecipientsDto,
  ) {
    return this.campaigns.listRecipients(id, q);
  }

  @ApiOperation({
    summary:
      'Falhas da campanha agrupadas por motivo — [{failureReason, count, label}]',
  })
  @Get(':id/failure-reasons')
  failureReasons(@Param('id') id: string) {
    return this.campaigns.getFailureReasons(id);
  }

  @ApiOperation({
    summary:
      'Disparar novamente: default reenvia só a quem NÃO recebeu (reavalia o gate para os pulados). ' +
      'resendToAll:true reabre a audiência inteira (creates a new batch)',
  })
  @Roles('ADMIN')
  @Post(':id/redispatch')
  redispatch(@Param('id') id: string, @Body() dto: RedispatchCampaignDto) {
    return this.campaigns.redispatchCampaign(id, dto.resendToAll);
  }

  // ── I15 — A SAÍDA EM MASSA PARA O NÚMERO BANIDO ───────────────────────────
  //
  // Uma campanha CANCELADA bloqueia também o que ficou em `SENT`, porque
  // cancelar não cancela o que já está no provedor. Mas quando o motivo do
  // cancelamento foi o CANAL TER MORRIDO (número banido no meio do disparo),
  // aquelas `SENT` nunca chegaram — e, sem esta porta, aquelas pessoas ficam
  // inalcançáveis para o template, com uma válvula de UM CLIQUE POR LINHA.
  //
  // Dois endpoints porque são dois passos: primeiro o operador VÊ o número,
  // depois ele DECLARA. Ver `CampaignsService.previewUnconfirmedSent` para a
  // pergunta que isto faz e por que só o dono pode respondê-la.

  @ApiOperation({
    summary:
      'Quantas mensagens desta campanha saíram e NUNCA tiveram confirmação de entrega ' +
      '(o número que a liberação em massa vai afetar)',
  })
  @Get(':id/unconfirmed-sent')
  previewUnconfirmedSent(@Param('id') id: string) {
    return this.campaigns.previewUnconfirmedSent(id);
  }

  @ApiOperation({
    summary:
      '"O canal morreu: estas nunca chegaram" — declara não entregues as mensagens ENVIADAS ' +
      'de uma campanha CANCELADA, devolvendo aquelas pessoas à audiência do mesmo template. ' +
      'Não toca no que foi ENTREGUE/LIDO e não enfileira nada.',
  })
  @Roles('ADMIN')
  @Post(':id/release-unconfirmed-sent')
  releaseUnconfirmedSent(
    @Param('id') id: string,
    @Body() dto: ReleaseUnconfirmedSentDto,
  ) {
    return this.campaigns.releaseUnconfirmedSent(id, dto);
  }

  @ApiOperation({ summary: 'Re-enqueue a single FAILED message' })
  @Roles('ADMIN')
  @Post('messages/:messageId/retry')
  retryMessage(@Param('messageId') messageId: string) {
    return this.campaigns.retryMessage(messageId);
  }

  @ApiOperation({
    summary:
      'Dispatch a single contact again (REUSES the message row — never clones it; allowed in any status)',
  })
  @Roles('ADMIN')
  @Post('messages/:messageId/redispatch')
  redispatchMessage(@Param('messageId') messageId: string) {
    return this.campaigns.redispatchMessage(messageId);
  }
}
