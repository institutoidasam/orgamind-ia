import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import {
  ConsentSource,
  ConsentState,
  ContactSourceOrigin,
} from '@prisma/client';
import { ConsentMetricsService } from './consent-metrics.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * A base fictícia deste teste (13 contatos, escala 1:1000 dos 13k reais):
 *
 *   total ................. 13
 *   com GRANT ativo ........ 4   (1 deles suprimido depois → 3 podem receber)
 *   suprimidos ............. 2
 *   coortes ................ C1:3  C2:4  C3:2  C4:3  C5:1
 *   inutilizáveis .......... 3   (sem consentimento E coorte C4/não classificado)
 */
function seedPrisma(prisma: MockProxy<PrismaService>) {
  prisma.contact.count.mockImplementation((async (args: any) => {
    const where = args?.where ?? {};
    if (Object.keys(where).length === 0) return 13; // total da base
    if (
      where.optedOut === false &&
      where.consents?.some?.state === ConsentState.GRANTED
    ) {
      return 3; // podem receber campanha hoje
    }
    if (where.consents?.some?.state === ConsentState.GRANTED) return 4; // com consentimento
    if (where.consents?.none?.state === ConsentState.GRANTED) return 3; // inutilizáveis
    if (where.whatsappValid === null) return 6; // nunca checados
    return 0;
  }) as never);

  prisma.suppressionList.count.mockImplementation((async (args: any) =>
    args?.where?.suppressedAt ? 1 : 2) as never);

  prisma.contactConsent.groupBy.mockImplementation((async (args: any) => {
    if (args.by[0] === 'purposeKey') {
      return [
        { purposeKey: 'convite_atividades', _count: { _all: 3 } },
        { purposeKey: 'captacao_recursos', _count: { _all: 1 } },
      ];
    }
    return [
      { source: ConsentSource.WA_LINK, _count: { _all: 2 } },
      { source: ConsentSource.WEB_FORM, _count: { _all: 1 } },
      { source: ConsentSource.PAPER_FORM, _count: { _all: 1 } },
    ];
  }) as never);

  prisma.consentPurpose.findMany.mockResolvedValue([
    {
      key: 'convite_atividades',
      label: 'Convites para cursos, oficinas e eventos',
    },
    { key: 'captacao_recursos', label: 'Campanhas de doação e apoio' },
    { key: 'pesquisa_avaliacao', label: 'Pesquisas e avaliações' },
  ] as never);

  prisma.contact.groupBy.mockResolvedValue([
    { sourceOrigin: ContactSourceOrigin.INTERAGIU, _count: { _all: 3 } },
    {
      sourceOrigin: ContactSourceOrigin.DOCUMENTADA_COM_DECLARACAO,
      _count: { _all: 4 },
    },
    {
      sourceOrigin: ContactSourceOrigin.DOCUMENTADA_SEM_DECLARACAO,
      _count: { _all: 2 },
    },
    { sourceOrigin: ContactSourceOrigin.DESCONHECIDA, _count: { _all: 3 } },
    {
      sourceOrigin: ContactSourceOrigin.INVALIDO_NAO_WHATSAPP,
      _count: { _all: 1 },
    },
  ] as never);

  prisma.contact.aggregate.mockResolvedValue({
    _max: { sourceOriginAt: new Date('2026-07-11T09:00:00Z') },
  });

  prisma.$queryRaw.mockResolvedValue([
    {
      token: 'FEIRA-MANAUS-2026',
      description: 'Cartaz da feira',
      purposeKey: 'convite_atividades',
      active: true,
      inbounds: 10,
      grants: 2,
    },
    {
      token: 'RADIO-RIO-NEGRO',
      description: null,
      purposeKey: 'convite_atividades',
      active: true,
      inbounds: 0,
      grants: 0,
    },
  ] as never);
}

describe('ConsentMetricsService — painel de opt-in (spec §7)', () => {
  let prisma: MockProxy<PrismaService>;
  let service: ConsentMetricsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    seedPrisma(prisma);
    service = new ConsentMetricsService(prisma);
  });

  describe('o número que importa', () => {
    it('"X de N podem receber campanha hoje" — com GRANT ativo E não suprimido', async () => {
      const o = await service.overview();

      // 4 têm GRANT ativo, mas 1 foi suprimido depois: a supressão é absoluta e
      // nem override de ADMIN a fura. Prometer 4 seria mentir para o operador.
      expect(o.podemReceberHoje).toBe(3);
      expect(o.total).toBe(13);
    });

    it('sem consentimento = total − quem tem GRANT ativo (o denominador do problema)', async () => {
      const o = await service.overview();
      expect(o.semConsentimento).toBe(9);
    });
  });

  describe('estado do consentimento', () => {
    it('conta consentimentos ativos POR FINALIDADE, inclusive a que tem zero', async () => {
      const o = await service.overview();

      expect(o.porFinalidade).toEqual([
        {
          purposeKey: 'convite_atividades',
          label: 'Convites para cursos, oficinas e eventos',
          granted: 3,
          pctBase: 23.1,
        },
        {
          purposeKey: 'captacao_recursos',
          label: 'Campanhas de doação e apoio',
          granted: 1,
          pctBase: 7.7,
        },
        // Uma finalidade sem NENHUM consentimento é informação, não ausência de
        // informação: é ela que diz onde a coleta não está acontecendo.
        {
          purposeKey: 'pesquisa_avaliacao',
          label: 'Pesquisas e avaliações',
          granted: 0,
          pctBase: 0,
        },
      ]);
    });

    it('quebra por FONTE do consentimento (qual canal de coleta funciona)', async () => {
      const o = await service.overview();

      expect(o.porFonte).toEqual([
        { source: ConsentSource.WA_LINK, granted: 2 },
        { source: ConsentSource.WEB_FORM, granted: 1 },
        { source: ConsentSource.PAPER_FORM, granted: 1 },
      ]);
    });

    it('suprimidos: total durável (SuppressionList, não o cache de Contact) + novos na semana', async () => {
      const o = await service.overview();

      // A SuppressionList é chaveada por phoneHash e sobrevive à exclusão do
      // contato — contar `Contact.optedOut` subnotificaria justamente quem o
      // IDASAM apagou depois de ter dado PARAR.
      expect(o.suprimidos).toBe(2);
      expect(o.suprimidosNaSemana).toBe(1);
    });
  });

  describe('funil por token de origem (§7)', () => {
    it('inbounds com o token → GRANTs: a diferença é o texto sendo apagado antes de enviar', async () => {
      const o = await service.overview();

      expect(o.funil[0]).toEqual({
        token: 'FEIRA-MANAUS-2026',
        description: 'Cartaz da feira',
        purposeKey: 'convite_atividades',
        active: true,
        inbounds: 10,
        grants: 2,
        conversao: 20,
      });
    });

    it('token sem nenhum inbound tem conversão 0, não NaN', async () => {
      const o = await service.overview();
      expect(o.funil[1].conversao).toBe(0);
    });
  });

  describe('auditoria das coortes (§6.2)', () => {
    it('conta a base em cada coorte de procedência', async () => {
      const o = await service.overview();

      expect(o.coortes).toMatchObject({
        INTERAGIU: 3,
        DOCUMENTADA_COM_DECLARACAO: 4,
        DOCUMENTADA_SEM_DECLARACAO: 2,
        DESCONHECIDA: 3,
        INVALIDO_NAO_WHATSAPP: 1,
        NAO_CLASSIFICADO: 0,
      });
      expect(o.auditadoEm).toEqual(new Date('2026-07-11T09:00:00Z'));
    });

    it('INUTILIZÁVEL = sem consentimento E sem procedência comprovável', async () => {
      const o = await service.overview();

      expect(o.inutilizaveis).toBe(3);
      expect(prisma.contact.count).toHaveBeenCalledWith({
        where: {
          consents: { none: { state: ConsentState.GRANTED } },
          OR: [
            { sourceOrigin: ContactSourceOrigin.DESCONHECIDA },
            { sourceOrigin: null },
          ],
        },
      });
    });

    it('reporta quantos nunca passaram pela checagem de WhatsApp', async () => {
      const o = await service.overview();
      expect(o.semChecagemWhatsapp).toBe(6);
    });
  });

  it('base vazia não divide por zero', async () => {
    prisma.contact.count.mockResolvedValue(0);
    prisma.contactConsent.groupBy.mockResolvedValue([] as never);
    prisma.contact.groupBy.mockResolvedValue([] as never);

    const o = await service.overview();

    expect(o.total).toBe(0);
    expect(o.podemReceberHoje).toBe(0);
    expect(o.porFinalidade.every((p) => p.pctBase === 0)).toBe(true);
  });
});
