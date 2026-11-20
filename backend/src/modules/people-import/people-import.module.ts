import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { BatchClassifier } from './batch-classifier';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportFilesService } from './people-import-files.service';
import { PeopleImportPreviewService } from './people-import-preview.service';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriteRepository } from './people-import-write.repository';
import { PeopleImportWriterService } from './people-import-writer.service';
import { PeopleImportController } from './people-import.controller';
import { PeopleImportRepository } from './people-import.repository';
import { RowWriter } from './row-writer';

/**
 * Importar pessoas por planilha (Lote E). `UsersModule` exporta o
 * `UsersService`, que o `RowWriter` usa para criar e atualizar pessoas pelo
 * caminho de escrita existente; `PrismaModule` e `AuditModule` são `@Global`
 * (o `AuditService` chega ao `PeopleImportConfirmService` por propriedade).
 */
@Module({
  imports: [UsersModule],
  controllers: [PeopleImportController],
  providers: [
    PeopleImportRepository,
    PeopleImportWriteRepository,
    PeopleImportCloseRepository,
    BatchClassifier,
    RowWriter,
    PeopleImportQueryService,
    PeopleImportPreviewService,
    PeopleImportFilesService,
    PeopleImportConfirmService,
    PeopleImportWriterService,
  ],
})
export class PeopleImportModule {}
