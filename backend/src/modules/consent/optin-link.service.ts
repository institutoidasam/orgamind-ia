import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConsentAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  buildExpectedText,
  buildWaMeUrl,
  declarationFrom,
  extractOriginToken,
  isValidOriginToken,
  normalizeForMatch,
  senderDigitsFrom,
} from './optin-link.util';

/** O link que um inbound CASOU — é o que autoriza o GRANT e diz qual finalidade. */
export type MatchedOptInLink = {
  id: string;
  token: string;
  purposeKey: string;
  consentTextVersion: string;
  /** O texto que o link pré-preencheu (vai para a evidência). */
  expectedText: string;
};

/** Um ponto de coleta como a UI o vê: o link pronto, o texto e o funil. */
export type OptInLinkView = {
  id: string;
  token: string;
  purposeKey: string;
  purposeLabel: string;
  consentTextVersion: string;
  /** O texto que o wa.me pré-preenche — e que o inbound tem de casar. */
  expectedText: string;
  /** `https://wa.me/<digits>?text=…` — é ISTO que vira o QR Code. */
  url: string;
  senderDigits: string;
  channelId: string | null;
  channelName: string | null;
  description: string | null;
  active: boolean;
  /** Quantos GRANTs já vieram deste token (funil por origem, spec §7). */
  grants: number;
  createdAt: Date;
};

export type CreateOptInLinkInput = {
  token: string;
  purposeKey: string;
  channelId: string;
  description?: string | null;
};

type LinkRow = Prisma.OptInLinkGetPayload<{
  include: { purpose: { select: { label: true } }; channel: { select: { name: true } } };
}>;

const LINK_INCLUDE = {
  purpose: { select: { label: true } },
  channel: { select: { name: true } },
} as const;

/**
 * C3 — gerência dos pontos de coleta wa.me/QR (spec §3.1).
 *
 * O que este serviço garante, e que é a razão de ele existir: **nenhum link sai
 * daqui sem carregar a declaração de consentimento versionada da finalidade**.
 * Um wa.me com "Oi" pré-preenchido é o que o orgamind fazia antes (inbound genérico
 * = opt-in fabricado); um wa.me cujo `?text=` é a declaração é um ato afirmativo
 * com evidência de terceiro (o `wamid` verificável na Twilio).
 *
 * O casamento do inbound com estes links vive em `matchInbound` (usado pelo
 * chat-ingest) — ele é quem decide se um inbound vira GRANT ou só abre janela.
 */
@Injectable()
export class OptInLinkService {
  private readonly logger = new Logger(OptInLinkService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateOptInLinkInput, actorUserId?: string): Promise<OptInLinkView> {
    const token = input.token.trim().toUpperCase();
    if (!isValidOriginToken(token)) {
      throw new BadRequestException(
        'Token de origem inválido: use apenas letras (A–Z), números e hífen, entre 3 e 48 caracteres. Ex.: FEIRA-MANAUS-2026.',
      );
    }

    // Só finalidade ATIVA. Uma finalidade desativada não pode nascer num cartaz
    // novo — mas os links já impressos com ela continuam casando (o gate é por
    // ContactConsent, não por "a finalidade ainda está no menu").
    const purpose = await this.prisma.consentPurpose.findFirst({
      where: { key: input.purposeKey, active: true },
      select: { key: true, label: true },
    });
    if (!purpose) {
      throw new NotFoundException(`Finalidade '${input.purposeKey}' não existe ou está inativa.`);
    }

    // O texto canônico VIGENTE da finalidade (§3.0). Sem ele não há declaração —
    // e um link sem declaração é o "Oi" genérico que o §3.1 proíbe. Falhamos
    // alto: inventar um texto aqui seria fabricar consentimento, que é o bug que
    // esta feature inteira existe para fechar.
    const text = await this.prisma.consentText.findFirst({
      where: { purposeKey: purpose.key, activeFrom: { lte: new Date() } },
      orderBy: { activeFrom: 'desc' },
      select: { version: true, body: true },
    });
    const declaration = text ? declarationFrom(text.body) : '';
    if (!text || !declaration) {
      throw new BadRequestException(
        `A finalidade '${purpose.key}' não tem texto de consentimento publicado (ConsentText). Publique o texto antes de gerar o link.`,
      );
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: input.channelId },
      select: { id: true, phoneE164: true },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado.');
    const senderDigits = channel.phoneE164 ? senderDigitsFrom(channel.phoneE164) : '';
    if (!senderDigits) {
      throw new BadRequestException(
        'O canal não tem número de WhatsApp configurado — o link wa.me precisa de um remetente concreto.',
      );
    }

    const expectedText = buildExpectedText(declaration, token);

    try {
      const row = await this.prisma.optInLink.create({
        data: {
          token,
          purposeKey: purpose.key,
          consentTextVersion: text.version,
          expectedText,
          senderDigits,
          channelId: channel.id,
          description: input.description?.trim() || null,
          createdById: actorUserId ?? null,
        },
        include: LINK_INCLUDE,
      });
      return this.toView(row, 0);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException(
          `Já existe um link com o token '${token}'. Cada ponto de coleta precisa do seu próprio token — é ele que atribui o consentimento à origem certa.`,
        );
      }
      throw err;
    }
  }

  /**
   * O CASAMENTO (spec §3.1) — a regra que separa "abriu janela" de "consentiu".
   *
   * Um inbound só é consentimento quando o corpo dele CASA com o texto que algum
   * link ATIVO pré-preencheu. Qualquer outra coisa — "oi", "quem são vocês?",
   * "não quero mais" — devolve null, e o ingest apenas abre a janela de
   * atendimento. Esse null é a correção inteira: era o `optInAt` escrito a partir
   * de QUALQUER inbound que fabricava consentimento, inclusive a partir de uma
   * reclamação.
   *
   * Duas condições, ambas necessárias:
   *  1. o token `[...]` resolve um `OptInLink` ativo — é ele que diz QUAL
   *     finalidade o titular autorizou (sem isso, seria autorização genérica,
   *     nula pelo art. 8º §4º);
   *  2. o corpo, normalizado, é IGUAL ao `expectedText` daquele link — porque a
   *     prova é o texto, não o token. Um "quero saber mais [FEIRA-MANAUS-2026]"
   *     tem o token, mas não declara nada: não é consentimento.
   *
   * Comparamos contra o `expectedText` GRAVADO no link (snapshot por valor), e
   * não contra o ConsentText vigente — o cartaz impresso continua valendo depois
   * de o texto canônico ser reeditado.
   */
  async matchInbound(text: string | null | undefined): Promise<MatchedOptInLink | null> {
    if (!text || !text.trim()) return null;

    const token = extractOriginToken(text);
    if (!token) return null; // sem token não há origem — e nem ida ao banco

    const link = await this.prisma.optInLink.findFirst({
      where: { token, active: true },
      select: {
        id: true,
        token: true,
        purposeKey: true,
        consentTextVersion: true,
        expectedText: true,
      },
    });
    if (!link) return null;

    if (normalizeForMatch(text) !== normalizeForMatch(link.expectedText)) {
      // O titular apagou/alterou a declaração e mandou só o token (ou o texto
      // veio truncado). Não há manifestação inequívoca a registrar.
      this.logger.log(
        { token, linkId: link.id },
        'inbound com token de origem mas texto que NÃO casa com a declaração — janela aberta, nenhum consentimento',
      );
      return null;
    }
    return link;
  }

  /** Todos os pontos de coleta (ativos e inativos), com o funil por token. */
  async list(): Promise<OptInLinkView[]> {
    const rows = await this.prisma.optInLink.findMany({
      orderBy: { createdAt: 'desc' },
      include: LINK_INCLUDE,
    });
    const grants = await this.grantsByToken();
    return rows.map((r) => this.toView(r, grants.get(r.token) ?? 0));
  }

  async setActive(id: string, active: boolean): Promise<OptInLinkView> {
    try {
      const row = await this.prisma.optInLink.update({
        where: { id },
        data: { active },
        include: LINK_INCLUDE,
      });
      const grants = await this.grantsByToken();
      return this.toView(row, grants.get(row.token) ?? 0);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('Link de opt-in não encontrado.');
      }
      throw err;
    }
  }

  /**
   * GRANTs por token de origem, numa consulta só. O funil do §7 ("um QR de feira
   * com muitos inbounds e poucos GRANTs significa que o texto está sendo
   * apagado") depende de contar por origem, e `originToken` mora dentro do JSON
   * de evidência — Prisma não agrupa por caminho de JSON, então é SQL cru.
   *
   * Uma consulta por link seria N+1 numa tela que lista todos os cartazes.
   */
  private async grantsByToken(): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ token: string; grants: number | bigint }[]>`
      SELECT "evidence"->>'originToken' AS token, COUNT(*)::int AS grants
      FROM "ConsentEvent"
      WHERE "action" = ${ConsentAction.GRANT}::"ConsentAction"
        AND "evidence"->>'originToken' IS NOT NULL
      GROUP BY 1
    `;
    return new Map(rows.map((r) => [r.token, Number(r.grants)]));
  }

  private toView(row: LinkRow, grants: number): OptInLinkView {
    return {
      id: row.id,
      token: row.token,
      purposeKey: row.purposeKey,
      purposeLabel: row.purpose?.label ?? row.purposeKey,
      consentTextVersion: row.consentTextVersion,
      expectedText: row.expectedText,
      url: buildWaMeUrl(row.senderDigits, row.expectedText),
      senderDigits: row.senderDigits,
      channelId: row.channelId,
      channelName: row.channel?.name ?? null,
      description: row.description,
      active: row.active,
      grants,
      createdAt: row.createdAt,
    };
  }
}
