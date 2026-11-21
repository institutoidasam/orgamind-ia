import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import {
  assumePendencySchema,
  type AssumePendencyInput,
} from './dto/assume-pendency.dto';
import {
  closePendencySchema,
  type ClosePendencyInput,
} from './dto/close-pendency.dto';
import { PendencyListQueryDto } from './dto/pendency-list-query.dto';
import {
  pendencyNoteSchema,
  type PendencyNoteInput,
} from './dto/pendency-note.dto';
import {
  reopenPendencySchema,
  type ReopenPendencyInput,
} from './dto/reopen-pendency.dto';
import {
  transferPendencySchema,
  type TransferPendencyInput,
} from './dto/transfer-pendency.dto';
import { TeamPendencyActionsService } from './team-pendency-actions.service';
import { TeamPendencyService } from './team-pendency.service';

type AuthRequest = { user: JwtPayload };

/**
 * Pendências da equipe (Lote K2, DK9): mesmo prefixo e mesmos guards globais do
 * `TeamWhatsappController`, que não muda. Leitura só com `@Roles(...)` (VIEWER
 * barrado pelo RolesGuard; "Ver não exige chave"); o 403 de quem não é
 * remetente e o 404 do que está fora do alcance ficam no serviço. As rotas de
 * escrita (T7, T8a e T8b) só têm `@RequirePermission`; o 403 `not_handler` e os
 * 404/409 de destino e de estado também ficam no serviço.
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamPendencyController {
  constructor(
    private readonly pendencies: TeamPendencyService,
    private readonly actions: TeamPendencyActionsService,
  ) {}

  @Get('pendencies')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Lista de pendências dos alertas urgentes no alcance de quem consulta, por situação, setor e "Minhas" (só remetente; abertas sem limite de data; com teto e aviso de truncada)',
  })
  list(@Query() query: PendencyListQueryDto, @Req() req: AuthRequest) {
    return this.pendencies.list(req.user.sub, query, new Date());
  }

  /** Fora de `pendencies/` para nunca colidir com `pendencies/:id` (DK9). */
  @Get('pendency-count')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Número de pendências Sem responsável com prazo de ciência vencido, no alcance de quem consulta, sem limite de data e sem teto (só remetente)',
  })
  count(@Req() req: AuthRequest) {
    return this.pendencies.count(req.user.sub, new Date());
  }

  @Get('pendencies/:id')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Uma pendência com anotações e última resposta ligada ao alerta (só remetente; inexistente ou fora do alcance, 404)',
  })
  get(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.pendencies.get(req.user.sub, id, new Date());
  }

  @Get('pendencies/:id/handlers')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Usuários que podem receber a pendência (remetentes ativos com equipe.enviar que a veem), só id e nome (só remetente; inexistente ou fora do alcance, 404)',
  })
  handlers(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.pendencies.handlers(req.user.sub, id);
  }

  /** Assumir e Assumir de outro (K2-7, DK11); o relógio é lido aqui (GK8). */
  @Post('pendencies/:id/assume')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Assume a pendência (ou a assume de outro responsável ativo), com prazo de 60 min e observação opcional; quem vê a pendência e tem equipe.enviar (já ciente ou encerrada, ou responsável diferente do mostrado → 409)',
  })
  async assume(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assumePendencySchema)) dto: AssumePendencyInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.actions.assume(req.user.sub, id, dto, new Date());
  }

  /** Transferir (K2-7, DK12); o relógio é lido aqui (GK8). */
  @Post('pendencies/:id/transfer')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Transfere a pendência a outro usuário que possa tratá-la (ativo, com equipe.enviar e que a veja; senão 404), com prazo de 60 min; só o responsável mostrado ou um ADMIN (senão 403 not_handler); ciente, encerrada ou responsável diferente do mostrado → 409',
  })
  async transfer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transferPendencySchema))
    dto: TransferPendencyInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.actions.transfer(req.user.sub, id, dto, new Date());
  }

  /** Registrar contato (K2-7, DK13); o relógio é lido aqui (GK8). */
  @Post('pendencies/:id/notes')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Registra contato: anotação obrigatória (até 200) sem mudar situação nem prazo; só o responsável mostrado ou um ADMIN (senão 403 not_handler); vale também em pendência ciente ou encerrada; responsável diferente do mostrado → 409',
  })
  async addNote(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(pendencyNoteSchema)) dto: PendencyNoteInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.actions.addNote(req.user.sub, id, dto, new Date());
  }

  /** Encerrar sem ciência (K2-7, DK14); o relógio é lido aqui (GK8). */
  @Post('pendencies/:id/close')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Encerra a pendência sem ciência, com motivo obrigatório (até 200); só o responsável mostrado ou um ADMIN (senão 403 not_handler); com ciência já registrada → 422 ack_exists; já encerrada ou responsável diferente do mostrado → 409',
  })
  async close(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(closePendencySchema)) dto: ClosePendencyInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.actions.close(req.user.sub, id, dto, new Date());
  }

  /** Reabrir a tratativa (K2-7, DK14); o relógio é lido aqui (GK8). */
  @Post('pendencies/:id/reopen')
  @HttpCode(204)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Reabre a tratativa de pendência encerrada sem ciência, com prazo novo (Sem responsável se não tem responsável); só o responsável mostrado ou um ADMIN (senão 403 not_handler); aberta, ciente ou responsável diferente do mostrado → 409',
  })
  async reopen(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reopenPendencySchema))
    dto: ReopenPendencyInput,
    @Req() req: AuthRequest,
  ): Promise<void> {
    await this.actions.reopen(req.user.sub, id, dto, new Date());
  }
}
