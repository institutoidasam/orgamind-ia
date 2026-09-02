import { describe, it, expect } from 'vitest';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from '../../shared/audit/audit.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ConsentModule } from './consent.module';
import { ConsentService } from './consent.service';
import { OrganizationModule } from '../organization/organization.module';

/**
 * Guarda de DI para o @Global do ConsentModule.
 *
 * O ConsentService é o CAMINHO ÚNICO de escrita do consentimento, e ele é
 * injetado em cinco lugares que não importam ConsentModule explicitamente
 * (ChatIngestService, WebhooksService, CampaignsService, ContactsService,
 * ExcelService, SendMessageProcessor). Se o @Global regredir — ou se alguém
 * "resolver" um import circular declarando ConsentService como provider local
 * de outro módulo —, o worker quebra no boot, não nos testes unitários (que
 * constroem os serviços com `new`).
 *
 * Este teste monta um módulo consumidor que NÃO importa ConsentModule e exige
 * que o ConsentService seja resolvível assim mesmo.
 */
describe('ConsentModule (@Global)', () => {
  it('expõe ConsentService a um módulo que NÃO o importa', async () => {
    @Module({})
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        // O ConfigModule real do orgamind valida o env inteiro (exige um grupo de
        // provider configurado) — irrelevante aqui: o que este teste guarda é o
        // @Global e a injeção do ConfigService (o sal do phoneHash).
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        // O ConsentAdminService audita quem cria finalidade e quem escreve o
        // texto de consentimento. Em produção o AuditModule é @Global (como
        // para CampaignsService, que também não o importa) — aqui o módulo de
        // teste é mínimo, então o registramos junto com o CLS de onde o
        // AuditService lê o ator.
        ClsModule.forRoot({ global: true }),
        AuditModule,
        // A identidade da organização é o que o consentimento NOMEIA (texto,
        // landing, wa.me). PublicConsentService e ConsentAdminService a injetam;
        // em produção o OrganizationModule é @Global, como aqui.
        OrganizationModule,
        ConsentModule,
        ConsumerModule,
      ],
    }).compile();

    const service = moduleRef.get(ConsentService, { strict: false });

    expect(service).toBeInstanceOf(ConsentService);
    // Constrói de verdade: prova que ConfigService (o sal) resolveu.
    expect(service.hashOf('+5592998887777')).toMatch(/^[0-9a-f]{64}$/);

    await moduleRef.close();
  });
});
