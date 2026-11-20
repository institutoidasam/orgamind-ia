import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type {
  BatchList,
  BatchSummary,
  RowsPage,
} from '../../schemas/contracts/people-import.schema';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { BatchListQueryDto } from './dto/batch-list-query.dto';
import { ConfirmBodyDto } from './dto/confirm-body.dto';
import { MappingBodyDto } from './dto/mapping-body.dto';
import { RowsQueryDto } from './dto/rows-query.dto';
import { TemplateQueryDto } from './dto/template-query.dto';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportFilesService } from './people-import-files.service';
import { PeopleImportPreviewService } from './people-import-preview.service';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriterService } from './people-import-writer.service';
import { SpreadsheetUploadInterceptor } from './spreadsheet-upload.interceptor';

type AuthRequest = { user: JwtPayload };

/** EX28: ler e classificar até 5.000 linhas pesa num servidor de 2 vCPU. */
const SHEET_WORK_LIMIT = { default: { ttl: 60_000, limit: 10 } };

/**
 * Importar pessoas por planilha (Lote E). A chave `pessoas.importar` fica só
 * na classe e nenhum handler declara `@Roles`: o `RolesGuard` não confere papel
 * e quem decide é a matriz (ADMIN sempre; VIEWER nunca), inclusive no modelo.
 * Um handler novo sem a chave, ou com `@Roles`, cairia na regra antiga de
 * papéis; o `route-parity.spec.ts` falha nesse caso. As outras regras (quem
 * enviou, `pessoas.editar`, setor gerido, situação do lote) são dos serviços.
 *
 * `@Res()` sem `passthrough` no modelo e no relatório: o serviço escreve o
 * arquivo direto na resposta; erro antes dos headers vai ao filtro global.
 */
@ApiTags('people-import')
@RequirePermission('pessoas.importar')
@Controller('internal/people-import')
export class PeopleImportController {
  // Injetado por propriedade: o construtor já tem 4 dependências, o teto de
  // parâmetros. Resolvido pelo Nest antes do primeiro pedido.
  @Inject(PeopleImportWriterService)
  private readonly writer!: PeopleImportWriterService;

  constructor(
    private readonly preview: PeopleImportPreviewService,
    private readonly query: PeopleImportQueryService,
    private readonly files: PeopleImportFilesService,
    private readonly confirmation: PeopleImportConfirmService,
  ) {}

  @Get('template')
  @ApiOperation({ summary: 'Baixa o modelo da planilha (CSV ou XLSX)' })
  async template(
    @Query() q: TemplateQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.files.template(q.format, res);
  }

  @Get('batches')
  @ApiOperation({ summary: 'Lista os lotes de importação visíveis ao usuário' })
  list(
    @Query() q: BatchListQueryDto,
    @Req() req: AuthRequest,
  ): Promise<BatchList> {
    return this.query.list(req.user.sub, q);
  }

  @Post('batches')
  @Throttle(SHEET_WORK_LIMIT)
  @UseInterceptors(SpreadsheetUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Envia a planilha e devolve a prévia do lote' })
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    // `originalname` vai cru (latin1 do multer): o serviço converte e corta.
    return this.preview.upload(req.user.sub, {
      originalName: file.originalname,
      size: file.size,
      buffer: file.buffer,
    });
  }

  @Get('batches/:id')
  @ApiOperation({ summary: 'Resumo do lote' })
  summary(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    return this.query.summary(req.user.sub, id);
  }

  @Put('batches/:id/mapping')
  @Throttle(SHEET_WORK_LIMIT)
  @ApiOperation({ summary: 'Troca o mapeamento das colunas e refaz a prévia' })
  remap(
    @Param('id') id: string,
    @Body() body: MappingBodyDto,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    return this.preview.remap(req.user.sub, id, body.mapping);
  }

  @Get('batches/:id/rows')
  @ApiOperation({ summary: 'Página das linhas da prévia' })
  rows(
    @Param('id') id: string,
    @Query() q: RowsQueryDto,
    @Req() req: AuthRequest,
  ): Promise<RowsPage> {
    return this.query.rows(req.user.sub, id, q);
  }

  @Post('batches/:id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirma a prévia e começa a gravação' })
  confirm(
    @Param('id') id: string,
    @Body() body: ConfirmBodyDto,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    return this.confirmation.confirm(req.user.sub, id, body);
  }

  @Post('batches/:id/write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Grava o próximo bloco de linhas do lote' })
  write(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    return this.writer.writeBlock(req.user.sub, id);
  }

  @Post('batches/:id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Encerra o lote sem gravar o que falta (ADMIN)' })
  close(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<BatchSummary> {
    return this.confirmation.close(req.user.sub, id);
  }

  @Delete('batches/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Descarta a prévia' })
  discard(@Param('id') id: string, @Req() req: AuthRequest): Promise<void> {
    return this.preview.discard(req.user.sub, id);
  }

  @Get('batches/:id/errors.csv')
  @ApiOperation({ summary: 'Baixa o relatório das linhas não gravadas' })
  async errors(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.files.errorReport(req.user.sub, id, res);
  }
}
