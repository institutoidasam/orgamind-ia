import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ExcelService } from './excel.service';
import { ValidationError } from '../../shared/errors/domain.error';
import { QUEUE_NAMES, type ExcelImportJob } from '../queue/queue.constants';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user?: JwtPayload };

/** Hard cap mirrored from the multer fileSize limit; defended again here. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

@ApiTags('imports')
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly excel: ExcelService,
    @InjectQueue(QUEUE_NAMES.EXCEL_IMPORT)
    private readonly importQueue: Queue<ExcelImportJob>,
  ) {}

  @ApiOperation({ summary: 'List previous .xlsx import batches' })
  @Get()
  list() {
    return this.excel.listBatches();
  }

  @ApiOperation({
    summary:
      'Upload .xlsx contact spreadsheet (max 10 MB). Returns immediately (202); the import runs asynchronously in the worker. Aceita consentimento coletado no papel: colunas `consentimento` (SIM/NÃO), `termo_ref`, `data_coleta`, `finalidade` (ou o campo `purposeKey` deste upload), `evento_local`, `link_scan`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        purposeKey: {
          type: 'string',
          description:
            'Finalidade padrão do lote (C4/§3.3), usada quando a planilha não tem a coluna `finalidade`. A coluna da linha sempre vence.',
        },
      },
      required: ['file'],
    },
  })
  @Post()
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
      fileFilter: (_req, file, cb) => {
        // MIME-only allowlist. Trusting the originalname extension lets a
        // renamed .html (or anything else) past the gate; ExcelJS then throws
        // unhandled errors deep in the parser.
        const ok =
          file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          file.mimetype === 'application/vnd.ms-excel';
        cb(
          ok
            ? null
            : new ValidationError(
                'Apenas arquivos .xlsx são aceitos',
                undefined,
                'excel.invalid_mime',
              ),
          ok,
        );
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    /** C4 (§3.3) — finalidade padrão do lote; a coluna `finalidade` da linha vence. */
    @Body('purposeKey') purposeKey?: string,
    @Req() req?: AuthRequest,
  ) {
    if (!file) {
      throw new ValidationError(
        'Arquivo é obrigatório',
        'Nenhum arquivo enviado',
        'excel.file_required',
      );
    }

    // Defend the 10MB cap again before doing any work — the multer limit is the
    // primary gate, but we never want an oversized buffer base64-encoded into a
    // job payload. Runs BEFORE creating the batch row or enqueueing.
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        'Arquivo muito grande — o limite é 10MB',
        undefined,
        'excel.file_too_large',
      );
    }

    // Create the batch row immediately (status PENDING) so the operator gets a
    // trackable id, then enqueue the actual parse+import to the worker. The
    // buffer is base64-encoded into the job payload (≤10MB) to avoid any shared
    // volume between api and worker.
    const batch = await this.excel.createPendingBatch(file.originalname);
    await this.importQueue.add('import', {
      batchId: batch.id,
      filename: file.originalname,
      fileBase64: file.buffer.toString('base64'),
      // C4 (§3.3): a finalidade do lote e QUEM importou. O worker não tem
      // `req.user` — se estes dois não viajarem no job, um GRANT de papel nasce
      // sem finalidade (nulo, art. 8º §4º) e sem autor na trilha.
      purposeKey: purposeKey?.trim() || undefined,
      actorUserId: req?.user?.sub,
    });

    return { batchId: batch.id, status: 'PENDING' as const };
  }
}
