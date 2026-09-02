import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import type { UpdateOrganization } from '../../schemas/contracts/organization.schema';
import {
  organizationFromEnv,
  type OrgIdentity,
} from './organization-identity';

/**
 * Singleton: o orgamind é single-tenant POR INSTALAÇÃO (um deploy Dokploy por
 * cliente). Uma linha, id fixo — não há "escolher a organização".
 */
export const ORGANIZATION_ID = 'singleton';

export type OrganizationView = OrgIdentity & { id: string };

/**
 * A identidade da organização titular deste deploy.
 *
 * É ela que vai para o TITULAR DOS DADOS — no texto de consentimento, na landing
 * pública `/opt-in` e no texto pré-preenchido do wa.me/QR. Um consentimento que
 * nomeia a organização errada não é um erro de copy: é um consentimento
 * inválido, colhido de gente real (a Meta exige *"clearly state the business's
 * name"*; a LGPD, controlador e finalidade determinados).
 */
@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env>,
  ) {}

  /**
   * NUNCA lança e nunca escreve: a landing pública chama isto a cada render, e
   * uma organização ausente (seed que não rodou, migração aplicada sem seed) não
   * pode derrubar a única página que colhe consentimento. Sem linha, o env
   * responde — e sem env, o fallback é neutro, jamais o nome de outro cliente.
   */
  async get(): Promise<OrganizationView> {
    const row = await this.prisma.organization.findUnique({
      where: { id: ORGANIZATION_ID },
    });

    if (!row) return { id: ORGANIZATION_ID, ...this.fromEnv() };

    return {
      id: row.id,
      name: row.name,
      legalName: row.legalName,
      privacyPolicyUrl: row.privacyPolicyUrl,
      supportContact: row.supportContact,
    };
  }

  /**
   * PATCH parcial. O que não vem no corpo NÃO é apagado — trocar o nome curto
   * não pode zerar a razão social por acidente.
   *
   * Upsert (e não update) porque o singleton pode não existir ainda: o operador
   * que abre Configurações antes do primeiro seed grava a identidade ali mesmo.
   *
   * **Trocar a identidade não reescreve consentimento nenhum.** Os `ConsentText`
   * já publicados seguem intactos e os `ConsentEvent` seguem apontando para a
   * versão que a pessoa leu — é o que os torna prova. Para colher com o nome
   * novo, o operador publica uma versão NOVA do texto (Opt-in → Texto), que já
   * vem sugerida com esta identidade.
   */
  async update(
    input: UpdateOrganization,
    actorUserId?: string,
  ): Promise<OrganizationView> {
    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
      ...(input.privacyPolicyUrl !== undefined
        ? { privacyPolicyUrl: input.privacyPolicyUrl }
        : {}),
      ...(input.supportContact !== undefined
        ? { supportContact: input.supportContact }
        : {}),
    };

    const row = await this.prisma.organization.upsert({
      where: { id: ORGANIZATION_ID },
      create: { id: ORGANIZATION_ID, ...this.fromEnv(), ...patch },
      update: patch,
    });

    await this.audit.log(
      'organization.updated',
      'Organization',
      ORGANIZATION_ID,
      { actorUserId, ...patch },
    );
    this.logger.log(
      { name: row.name },
      'identidade da organização atualizada — publique uma nova versão do texto de consentimento se o nome mudou',
    );

    return {
      id: row.id,
      name: row.name,
      legalName: row.legalName,
      privacyPolicyUrl: row.privacyPolicyUrl,
      supportContact: row.supportContact,
    };
  }

  private fromEnv(): OrgIdentity {
    return organizationFromEnv({
      ORG_NAME: this.config.get('ORG_NAME', { infer: true }),
      ORG_LEGAL_NAME: this.config.get('ORG_LEGAL_NAME', { infer: true }),
      ORG_PRIVACY_POLICY_URL: this.config.get('ORG_PRIVACY_POLICY_URL', {
        infer: true,
      }),
      ORG_SUPPORT_CONTACT: this.config.get('ORG_SUPPORT_CONTACT', {
        infer: true,
      }),
    });
  }
}
