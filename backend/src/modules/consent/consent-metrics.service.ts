import { Injectable } from '@nestjs/common';
import {
  ConsentAction,
  ConsentSource,
  ConsentState,
  ContactSourceOrigin,
  MessageDirection,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

/** Coortes + o estado "ainda não classificado", que também é um número a encarar. */
export const NAO_CLASSIFICADO = 'NAO_CLASSIFICADO';
export type CoorteKey = ContactSourceOrigin | typeof NAO_CLASSIFICADO;

export type PurposeBreakdown = {
  purposeKey: string;
  label: string;
  granted: number;
  /** % da base inteira. Uma barra sobre 13k, não sobre "quem já consentiu". */
  pctBase: number;
};

export type SourceBreakdown = { source: ConsentSource; granted: number };

export type FunnelRow = {
  token: string;
  description: string | null;
  purposeKey: string;
  active: boolean;
  /** Inbounds que CHEGARAM carregando este token de origem. */
  inbounds: number;
  /** Quantos viraram GRANT (o texto casou com a declaração). */
  grants: number;
  /** grants/inbounds em %. Baixo = o titular está apagando o texto antes de enviar. */
  conversao: number;
};

export type ConsentOverview = {
  total: number;
  /** O NÚMERO QUE IMPORTA: GRANT ativo para alguma finalidade E não suprimido. */
  podemReceberHoje: number;
  semConsentimento: number;
  suprimidos: number;
  suprimidosNaSemana: number;
  porFinalidade: PurposeBreakdown[];
  porFonte: SourceBreakdown[];
  funil: FunnelRow[];
  coortes: Record<CoorteKey, number>;
  /** Sem consentimento E sem procedência comprovável. A parte da base que não serve. */
  inutilizaveis: number;
  /** whatsappValid = null: nunca checados (não excluem, mas não são "válidos"). */
  semChecagemWhatsapp: number;
  /** Quando a classificação de coortes rodou pela última vez (null = nunca). */
  auditadoEm: Date | null;
};

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * C5 — o PAINEL DE OPT-IN (spec §7).
 *
 * A métrica de sucesso do orgamind deixa de ser "mensagens enviadas". Esta tela
 * responde três perguntas, nesta ordem:
 *
 *  1. **Quantos podem receber campanha hoje?** — GRANT ativo por finalidade e não
 *     suprimido. É o único número que autoriza apertar um botão.
 *  2. **Qual canal de coleta funciona?** — quebra por fonte e funil por token de
 *     origem. Um QR de feira com muitos inbounds e poucos GRANTs não é problema de
 *     canal: é o texto pré-preenchido sendo apagado antes do envio (problema de
 *     copy).
 *  3. **Quanto da base é inutilizável?** — sem consentimento E sem procedência
 *     comprovável. É a pergunta que ninguém quer fazer, e é a que evita o caso
 *     Telekall.
 *
 * Tudo aqui é AGREGADO: nenhuma linha de contato, nenhum telefone, nenhuma PII.
 */
@Injectable()
export class ConsentMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(): Promise<ConsentOverview> {
    const semanaAtras = new Date(Date.now() - SEMANA_MS);

    const [
      total,
      podemReceberHoje,
      comConsentimento,
      inutilizaveis,
      semChecagemWhatsapp,
      suprimidos,
      suprimidosNaSemana,
      porPurpose,
      porSource,
      purposes,
      coorteRows,
      auditoria,
      funil,
    ] = await Promise.all([
      this.prisma.contact.count(),
      this.prisma.contact.count({
        where: {
          optedOut: false,
          consents: { some: { state: ConsentState.GRANTED } },
        },
      }),
      this.prisma.contact.count({
        where: { consents: { some: { state: ConsentState.GRANTED } } },
      }),
      // "Inutilizável" é uma conjunção, não uma coorte: um contato C4 que
      // consentiu pela landing é perfeitamente utilizável (o consentimento é a
      // base legal — a procedência só importa para quem NÃO consentiu). E o
      // não-classificado entra porque procedência que ninguém apurou não é
      // procedência comprovada.
      this.prisma.contact.count({
        where: {
          consents: { none: { state: ConsentState.GRANTED } },
          OR: [
            { sourceOrigin: ContactSourceOrigin.DESCONHECIDA },
            { sourceOrigin: null },
          ],
        },
      }),
      this.prisma.contact.count({ where: { whatsappValid: null } }),
      // A SuppressionList (chaveada por phoneHash) e não `Contact.optedOut`: ela
      // sobrevive à exclusão do contato, e é justamente quem foi apagado depois
      // de dar PARAR que o cache subnotificaria.
      this.prisma.suppressionList.count(),
      this.prisma.suppressionList.count({
        where: { suppressedAt: { gte: semanaAtras } },
      }),
      this.prisma.contactConsent.groupBy({
        by: ['purposeKey'],
        where: { state: ConsentState.GRANTED },
        _count: { _all: true },
      }),
      this.prisma.contactConsent.groupBy({
        by: ['source'],
        where: { state: ConsentState.GRANTED },
        _count: { _all: true },
      }),
      this.prisma.consentPurpose.findMany({
        where: { active: true },
        orderBy: { label: 'asc' },
        select: { key: true, label: true },
      }),
      this.prisma.contact.groupBy({
        by: ['sourceOrigin'],
        _count: { _all: true },
      }),
      this.prisma.contact.aggregate({ _max: { sourceOriginAt: true } }),
      this.funnelByOriginToken(),
    ]);

    const grantedByPurpose = new Map(
      porPurpose.map((r) => [r.purposeKey, r._count._all]),
    );
    const pct = (n: number) =>
      total === 0 ? 0 : Math.round((n / total) * 1000) / 10;

    return {
      total,
      podemReceberHoje,
      semConsentimento: total - comConsentimento,
      suprimidos,
      suprimidosNaSemana,
      porFinalidade: purposes.map((p) => {
        const granted = grantedByPurpose.get(p.key) ?? 0;
        return {
          purposeKey: p.key,
          label: p.label,
          granted,
          pctBase: pct(granted),
        };
      }),
      porFonte: porSource
        .filter(
          (r): r is typeof r & { source: ConsentSource } => r.source !== null,
        )
        .map((r) => ({ source: r.source, granted: r._count._all })),
      funil,
      coortes: this.coortes(coorteRows),
      inutilizaveis,
      semChecagemWhatsapp,
      auditadoEm: auditoria._max.sourceOriginAt,
    };
  }

  /**
   * O funil do §7: **inbounds que chegaram carregando o token → GRANTs**.
   *
   * A diferença entre as duas colunas é o diagnóstico que a spec pede: um cartaz
   * com 300 inbounds e 12 GRANTs não tem problema de alcance — as pessoas estão
   * apagando a declaração pré-preenchida antes de apertar "enviar", e o inbound
   * sem a declaração (corretamente) abre janela e NÃO consente.
   *
   * SQL cru por dois motivos: `originToken` mora dentro do JSON de evidência (o
   * Prisma não agrupa por caminho de JSON) e o inbound se reconhece pelo token
   * `[...]` dentro do corpo da mensagem. `token` é validado na criação do link
   * (A–Z, 0–9, hífen), e nem `[` nem `]` são metacaracteres de LIKE.
   */
  private async funnelByOriginToken(): Promise<FunnelRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        token: string;
        description: string | null;
        purposeKey: string;
        active: boolean;
        inbounds: number | bigint;
        grants: number | bigint;
      }>
    >`
      SELECT l."token",
             l."description",
             l."purposeKey",
             l."active",
             COALESCE(i.inbounds, 0)::int AS inbounds,
             COALESCE(g.grants, 0)::int   AS grants
      FROM "OptInLink" l
      LEFT JOIN (
        SELECT "evidence"->>'originToken' AS token, COUNT(*)::int AS grants
        FROM "ConsentEvent"
        WHERE "action" = ${ConsentAction.GRANT}::"ConsentAction"
          AND "evidence"->>'originToken' IS NOT NULL
        GROUP BY 1
      ) g ON g.token = l."token"
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS inbounds
        FROM "Message" m
        WHERE m."direction" = ${MessageDirection.INBOUND}::"MessageDirection"
          AND m."content" ILIKE '%[' || l."token" || ']%'
      ) i ON TRUE
      ORDER BY l."createdAt" DESC
    `;

    return rows.map((r) => {
      const inbounds = Number(r.inbounds);
      const grants = Number(r.grants);
      return {
        token: r.token,
        description: r.description,
        purposeKey: r.purposeKey,
        active: r.active,
        inbounds,
        grants,
        conversao:
          inbounds === 0 ? 0 : Math.round((grants / inbounds) * 1000) / 10,
      };
    });
  }

  /** Todas as coortes sempre presentes (um zero é informação; uma chave ausente é bug). */
  private coortes(
    rows: Array<{
      sourceOrigin: ContactSourceOrigin | null;
      _count: { _all: number };
    }>,
  ): Record<CoorteKey, number> {
    const out = {
      INTERAGIU: 0,
      DOCUMENTADA_COM_DECLARACAO: 0,
      DOCUMENTADA_SEM_DECLARACAO: 0,
      DESCONHECIDA: 0,
      INVALIDO_NAO_WHATSAPP: 0,
      [NAO_CLASSIFICADO]: 0,
    } as Record<CoorteKey, number>;

    for (const row of rows) {
      out[row.sourceOrigin ?? NAO_CLASSIFICADO] = row._count._all;
    }
    return out;
  }
}
