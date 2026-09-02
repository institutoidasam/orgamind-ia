import { Global, Module } from '@nestjs/common';
import { ConsentAdminController } from './consent-admin.controller';
import { ConsentAdminService } from './consent-admin.service';
import { ConsentBulkGrantService } from './consent-bulk-grant.service';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { OptInLinkController } from './optin-link.controller';
import { OptInLinkService } from './optin-link.service';
import { PublicConsentController } from './public-consent.controller';
import { PublicConsentService } from './public-consent.service';
import { SourceOriginService } from './source-origin.service';
import { ConsentMetricsService } from './consent-metrics.service';

/**
 * @Global de propósito: o consentimento é um corte transversal (chat-ingest,
 * webhooks, dispatch de campanha, importação de XLSX, worker) e é o ÚNICO
 * caminho de escrita permitido. Deixá-lo global remove o incentivo a alguém
 * "resolver" um import circular escrevendo `prisma.contact.update({ optInAt })`
 * na mão — que é exatamente o bug que esta feature corrige.
 */
@Global()
@Module({
  controllers: [
    ConsentController,
    ConsentAdminController,
    OptInLinkController,
    PublicConsentController,
  ],
  providers: [
    ConsentService,
    ConsentAdminService,
    ConsentBulkGrantService,
    OptInLinkService,
    PublicConsentService,
    SourceOriginService,
    ConsentMetricsService,
  ],
  exports: [ConsentService, OptInLinkService, SourceOriginService],
})
export class ConsentModule {}
