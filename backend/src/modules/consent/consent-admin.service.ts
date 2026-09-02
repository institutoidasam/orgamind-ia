import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { OrganizationService } from '../organization/organization.service';
import type {
  CreateConsentText,
  CreatePurpose,
  UpdatePurpose,
} from '../../schemas/contracts/consent-admin.schema';
import {
  composeConsentBody,
  namesOrganization,
  suggestTextVersion,
} from './consent-text.composer';
import {
  ConsentTextVersionTakenError,
  PurposeInUseError,
  PurposeKeyTakenError,
  PurposeNotFoundError,
} from './errors/consent.errors';

export type ConsentTextView = {
  id: string;
  version: string;
  body: string;
  activeFrom: Date;
  createdAt: Date;
};

/** A finalidade como o ADMIN a vê: com os textos e com o que a prende. */
export type AdminPurposeView = {
  key: string;
  label: string;
  description: string;
  isSensitive: boolean;
  active: boolean;
  /** Versões do texto canônico, da mais nova para a mais antiga. */
  texts: ConsentTextView[];
  /** A versão vigente (activeFrom <= agora). null = a finalidade não coleta nada ainda. */
  activeText: ConsentTextView | null;
  /** Consentimentos (qualquer estado) — é o que impede o DELETE. */
  consents: number;
  /** Eventos na trilha (GRANT + REVOKE). */
  events: number;
  campaigns: number;
};

const PURPOSE_INCLUDE = {
  texts: { orderBy: { activeFrom: 'desc' } },
} as const satisfies Prisma.ConsentPurposeInclude;

type PurposeRow = Prisma.ConsentPurposeGetPayload<{
  include: typeof PURPOSE_INCLUDE;
}>;

type UsageCounts = {
  consents: number;
  events: number;
  campaigns: number;
  links: number;
};

/** O rascunho que a tela abre quando o operador vai publicar uma versão nova. */
export type SuggestedConsentText = {
  purposeKey: string;
  /** Rótulo de versão livre de colisão (`optin-<organização>-vN`). */
  version: string;
  /** Corpo composto com a identidade CONFIGURADA da organização. */
  body: string;
  /** O texto VIGENTE já nomeia a organização deste deploy? */
  activeTextNamesOrganization: boolean;
};

/**
 * CRUD de finalidades e textos de consentimento (spec §2.2 e §3.0).
 *
 * Por que isto precisa existir: as 5 finalidades e os textos que as declaram
 * nasceram numa migração de referência, com o nome de uma organização específica
 * dentro. Um cliente novo não tem como colher consentimento válido com o nome de
 * OUTRA organização no texto — a Meta exige que o texto *"clearly state the
 * business's name"* e a LGPD exige finalidade determinada (art. 8º §4º). Sem
 * esta tela, cada cliente novo dependeria de uma migração de banco.
 *
 * As duas invariantes que o serviço protege:
 *  1. **A key é imutável.** Ela é a chave estável do gate, das campanhas e de
 *     cada evento da trilha. Renomear = órfã a prova.
 *  2. **O texto é versionado e imutável.** Publicar v2 nunca reescreve a v1: os
 *     `ConsentEvent` já gravados apontam para a versão que a pessoa LEU, e é ela
 *     que prova o consentimento em 2028 (art. 8º §2º — o ônus é do controlador).
 */
@Injectable()
export class ConsentAdminService {
  private readonly logger = new Logger(ConsentAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly organization: OrganizationService,
  ) {}

  /** TODAS as finalidades (inclusive inativas) — é a tela de administração. */
  async listPurposes(): Promise<AdminPurposeView[]> {
    const [purposes, consents, events, campaigns] = await Promise.all([
      this.prisma.consentPurpose.findMany({
        orderBy: [{ active: 'desc' }, { label: 'asc' }],
        include: PURPOSE_INCLUDE,
      }),
      this.prisma.contactConsent.groupBy({
        by: ['purposeKey'],
        _count: { _all: true },
      }),
      this.prisma.consentEvent.groupBy({
        by: ['purposeKey'],
        _count: { _all: true },
      }),
      this.prisma.campaign.groupBy({
        by: ['purposeKey'],
        _count: { _all: true },
      }),
    ]);

    const countOf = (
      rows: { purposeKey: string | null; _count: { _all: number } }[],
      key: string,
    ) => rows.find((r) => r.purposeKey === key)?._count._all ?? 0;

    return purposes.map((p) =>
      this.toView(p, {
        consents: countOf(consents, p.key),
        events: countOf(events, p.key),
        campaigns: countOf(campaigns, p.key),
        links: 0,
      }),
    );
  }

  async createPurpose(
    input: CreatePurpose,
    actorUserId?: string,
  ): Promise<AdminPurposeView> {
    try {
      const row = await this.prisma.consentPurpose.create({
        data: {
          key: input.key,
          label: input.label,
          description: input.description,
          isSensitive: input.isSensitive,
          active: input.active,
        },
        include: PURPOSE_INCLUDE,
      });
      await this.audit.log(
        'consent.purpose_created',
        'ConsentPurpose',
        row.key,
        {
          actorUserId,
          label: row.label,
          isSensitive: row.isSensitive,
        },
      );
      this.logger.log({ key: row.key }, 'finalidade de consentimento criada');
      return this.toView(row, ZERO_USAGE);
    } catch (err) {
      if (isPrismaCode(err, 'P2002')) throw new PurposeKeyTakenError(input.key);
      throw err;
    }
  }

  /** Rótulo, descrição, sensibilidade e ativo. NUNCA a key (ver invariante 1). */
  async updatePurpose(
    key: string,
    input: UpdatePurpose,
    actorUserId?: string,
  ): Promise<AdminPurposeView> {
    try {
      const row = await this.prisma.consentPurpose.update({
        where: { key },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.isSensitive !== undefined
            ? { isSensitive: input.isSensitive }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        include: PURPOSE_INCLUDE,
      });
      await this.audit.log(
        'consent.purpose_updated',
        'ConsentPurpose',
        key,
        { actorUserId, ...input },
      );
      return this.toView(row, await this.usageOf(key));
    } catch (err) {
      if (isPrismaCode(err, 'P2025')) throw new PurposeNotFoundError(key);
      throw err;
    }
  }

  /**
   * Só apaga finalidade VIRGEM. Qualquer vínculo — consentimento, evento da
   * trilha, campanha ou ponto de coleta — bloqueia, e o erro manda desativar.
   */
  async deletePurpose(key: string, actorUserId?: string): Promise<void> {
    const purpose = await this.prisma.consentPurpose.findUnique({
      where: { key },
      select: { key: true },
    });
    if (!purpose) throw new PurposeNotFoundError(key);

    const usage = await this.usageOf(key);
    if (
      usage.consents > 0 ||
      usage.events > 0 ||
      usage.campaigns > 0 ||
      usage.links > 0
    ) {
      throw new PurposeInUseError(key, usage);
    }

    await this.prisma.$transaction([
      this.prisma.consentText.deleteMany({ where: { purposeKey: key } }),
      this.prisma.consentPurpose.delete({ where: { key } }),
    ]);

    await this.audit.log('consent.purpose_deleted', 'ConsentPurpose', key, {
      actorUserId,
    });
    this.logger.warn({ key }, 'finalidade de consentimento apagada (sem uso)');
  }

  /**
   * Publica uma versão NOVA do texto canônico. Nunca reescreve as anteriores —
   * `create`, jamais `update` (invariante 2).
   */
  async publishText(
    input: CreateConsentText,
    actorUserId?: string,
  ): Promise<ConsentTextView> {
    const purpose = await this.prisma.consentPurpose.findUnique({
      where: { key: input.purposeKey },
      select: { key: true },
    });
    if (!purpose) throw new PurposeNotFoundError(input.purposeKey);

    try {
      const row = await this.prisma.consentText.create({
        data: {
          purposeKey: input.purposeKey,
          version: input.version,
          body: input.body,
          ...(input.activeFrom ? { activeFrom: input.activeFrom } : {}),
        },
      });
      await this.audit.log('consent.text_published', 'ConsentText', row.id, {
        actorUserId,
        purposeKey: input.purposeKey,
        version: input.version,
      });
      this.logger.log(
        { purposeKey: input.purposeKey, version: input.version },
        'texto de consentimento publicado (nova versão; as anteriores permanecem)',
      );
      return toTextView(row);
    } catch (err) {
      if (isPrismaCode(err, 'P2002')) {
        throw new ConsentTextVersionTakenError(input.version, input.purposeKey);
      }
      throw err;
    }
  }

  /**
   * O RASCUNHO de uma versão nova, composta com a identidade configurada — o
   * caminho claro (e o único que o orgamind oferece) para trocar a organização
   * nomeada num texto de consentimento.
   *
   * É sugestão, não escrita: quem publica é o operador, e o corpo continua
   * editável antes de virar prova. E, de novo, publicar é sempre **criar**: o
   * texto que os titulares antigos leram permanece intacto, e os
   * consentimentos deles continuam apontando para ele.
   */
  async suggestText(purposeKey: string): Promise<SuggestedConsentText> {
    const purpose = await this.prisma.consentPurpose.findUnique({
      where: { key: purposeKey },
      include: PURPOSE_INCLUDE,
    });
    if (!purpose) throw new PurposeNotFoundError(purposeKey);

    const org = await this.organization.get();
    const now = Date.now();
    const active = purpose.texts.find((t) => t.activeFrom.getTime() <= now);

    return {
      purposeKey: purpose.key,
      version: suggestTextVersion(
        org,
        purpose.texts.map((t) => t.version),
      ),
      body: composeConsentBody(org, { label: purpose.label }),
      activeTextNamesOrganization: active
        ? namesOrganization(active.body, org)
        : false,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async usageOf(key: string): Promise<UsageCounts> {
    const [consents, events, campaigns, links] = await Promise.all([
      this.prisma.contactConsent.count({ where: { purposeKey: key } }),
      this.prisma.consentEvent.count({ where: { purposeKey: key } }),
      this.prisma.campaign.count({ where: { purposeKey: key } }),
      this.prisma.optInLink.count({ where: { purposeKey: key } }),
    ]);
    return { consents, events, campaigns, links };
  }

  private toView(row: PurposeRow, usage: UsageCounts): AdminPurposeView {
    const texts = (row.texts ?? []).map(toTextView);
    const now = Date.now();
    return {
      key: row.key,
      label: row.label,
      description: row.description,
      isSensitive: row.isSensitive,
      active: row.active,
      texts,
      activeText:
        texts.find((t) => t.activeFrom.getTime() <= now) ?? null,
      consents: usage.consents,
      events: usage.events,
      campaigns: usage.campaigns,
    };
  }
}

const ZERO_USAGE: UsageCounts = {
  consents: 0,
  events: 0,
  campaigns: 0,
  links: 0,
};

function toTextView(row: {
  id: string;
  version: string;
  body: string;
  activeFrom: Date;
  createdAt: Date;
}): ConsentTextView {
  return {
    id: row.id,
    version: row.version,
    body: row.body,
    activeFrom: row.activeFrom,
    createdAt: row.createdAt,
  };
}

function isPrismaCode(err: unknown, code: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}
