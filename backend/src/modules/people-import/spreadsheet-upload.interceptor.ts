import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { IMPORT_MAX_BYTES } from '../../shared/spreadsheet/sheet-data';
import { importFileTooLarge, importInvalidFile } from './people-import.errors';

/**
 * EX4: lê o campo `file` do multipart com o multer, que para de ler ao passar
 * de `IMPORT_MAX_BYTES` (o arquivo não chega inteiro à memória) e aceita um
 * arquivo só. Os guards já rodaram antes (chave e limite de envios), então
 * nada é lido de quem não pode importar.
 *
 * O 413 do multer vira o 422 `people_import.file_too_large` da spec; pedido
 * sem arquivo vira o 422 `people_import.invalid_file`. Os outros erros do
 * multer (campo com outro nome, dois arquivos, multipart quebrado) seguem como
 * o 400 do Nest, inclusive campo de texto (`fields: 0`). Tipo e conteúdo são
 * conferidos pelo serviço (T16).
 */
@Injectable()
export class SpreadsheetUploadInterceptor extends FileInterceptor('file', {
  // `fields: 0`: o multipart só traz o arquivo; campo de texto (até 1 MB cada,
  // em memória) vira 400 do multer. `parts: 2` limita o trabalho de um corpo
  // com milhares de partes vazias (T21 M1).
  limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 0, parts: 2 },
}) {
  override async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    let handled: Observable<unknown>;
    try {
      // `next.handle()` é preguiçoso: o handler só roda quando o Nest assinar.
      handled = await super.intercept(context, next);
    } catch (error) {
      throw error instanceof PayloadTooLargeException
        ? importFileTooLarge()
        : error;
    }
    const req = context.switchToHttp().getRequest<{ file?: unknown }>();
    if (req.file === undefined) throw importInvalidFile();
    return handled;
  }
}
