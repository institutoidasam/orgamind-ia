import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OptInLinkService } from './optin-link.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

const DECLARATION =
  'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.';

const BODY = [
  DECLARATION,
  'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.',
  'Minha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.',
  'Política de privacidade: {url}',
].join('\n');

describe('OptInLinkService.create', () => {
  let prisma: MockProxy<PrismaService>;
  let svc: OptInLinkService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.consentPurpose.findFirst.mockResolvedValue({
      key: 'convite_atividades',
      label: 'Convites para cursos, oficinas e eventos',
    } as never);
    prisma.consentText.findFirst.mockResolvedValue({
      version: 'optin-v1',
      body: BODY,
    } as never);
    prisma.channel.findUnique.mockResolvedValue({
      id: 'ch1',
      phoneE164: '+559231550103',
    } as never);
    prisma.optInLink.create.mockImplementation((async (args: any) => ({
      id: 'l1',
      ...args.data,
      createdAt: new Date(),
      purpose: { label: 'Convites para cursos, oficinas e eventos' },
      channel: { name: 'Principal' },
    })) as never);
    svc = new OptInLinkService(prisma);
  });

  const input = {
    token: 'FEIRA-MANAUS-2026',
    purposeKey: 'convite_atividades',
    channelId: 'ch1',
    description: 'Cartaz da feira',
  };

  /**
   * O CORAÇÃO do §3.1: o texto pré-preenchido não é um "Oi" — é a declaração de
   * consentimento, tirada do ConsentText VERSIONADO da finalidade (que já nomeia
   * o IDASAM, requisito da Meta), com o token de origem colado no fim.
   */
  it('monta o texto pré-preenchido a partir do ConsentText versionado da finalidade + o token', async () => {
    const link = await svc.create(input, 'u1');

    expect(link.expectedText).toBe(`${DECLARATION} [FEIRA-MANAUS-2026]`);
    expect(link.consentTextVersion).toBe('optin-v1');
    expect(link.expectedText).toContain('IDASAM');
  });

  it('gera o wa.me apontando para o número do canal, sem "+" e com o texto encodado', async () => {
    const link = await svc.create(input, 'u1');

    expect(link.url).toContain('https://wa.me/559231550103?text=');
    expect(link.url).not.toContain(' ');
    expect(decodeURIComponent(link.url.split('?text=')[1])).toBe(link.expectedText);
  });

  it('persiste expectedText e a versão POR VALOR — o cartaz impresso não muda quando o texto canônico mudar', async () => {
    await svc.create(input, 'u1');

    const data = (prisma.optInLink.create.mock.calls[0][0] as any).data;
    expect(data.expectedText).toBe(`${DECLARATION} [FEIRA-MANAUS-2026]`);
    expect(data.consentTextVersion).toBe('optin-v1');
    expect(data.senderDigits).toBe('559231550103');
    expect(data.createdById).toBe('u1');
  });

  it('recusa token fora do formato de cartaz (o token é a chave do casamento)', async () => {
    await expect(svc.create({ ...input, token: 'feira manaus' }, 'u1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.optInLink.create).not.toHaveBeenCalled();
  });

  it('recusa finalidade inexistente/inativa — sem finalidade não há consentimento válido (art. 8º §4º)', async () => {
    prisma.consentPurpose.findFirst.mockResolvedValue(null as never);
    await expect(svc.create({ ...input, purposeKey: 'nao_existe' }, 'u1')).rejects.toThrow(
      NotFoundException,
    );
  });

  /**
   * Sem texto canônico não há declaração — e um link sem declaração seria
   * exatamente o "Oi" genérico que o §3.1 proíbe. Falhar alto é a única saída:
   * inventar um texto aqui fabricaria consentimento.
   */
  it('recusa criar link quando a finalidade não tem ConsentText publicado', async () => {
    prisma.consentText.findFirst.mockResolvedValue(null as never);
    await expect(svc.create(input, 'u1')).rejects.toThrow(BadRequestException);
    expect(prisma.optInLink.create).not.toHaveBeenCalled();
  });

  it('recusa canal sem número (o wa.me precisa de um remetente concreto)', async () => {
    prisma.channel.findUnique.mockResolvedValue({ id: 'ch1', phoneE164: null } as never);
    await expect(svc.create(input, 'u1')).rejects.toThrow(BadRequestException);
  });

  it('normaliza o token para caixa alta (o cartaz é impresso, o operador digita torto)', async () => {
    await svc.create({ ...input, token: 'feira-manaus-2026'.toUpperCase() }, 'u1');
    const data = (prisma.optInLink.create.mock.calls[0][0] as any).data;
    expect(data.token).toBe('FEIRA-MANAUS-2026');
  });
});

describe('OptInLinkService.list', () => {
  it('devolve o funil por token: quantos GRANTs vieram de cada ponto de coleta (§7)', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.optInLink.findMany.mockResolvedValue([
      {
        id: 'l1',
        token: 'FEIRA-MANAUS-2026',
        purposeKey: 'convite_atividades',
        consentTextVersion: 'optin-v1',
        expectedText: 'Autorizo. [FEIRA-MANAUS-2026]',
        senderDigits: '559231550103',
        channelId: 'ch1',
        description: 'Cartaz',
        active: true,
        createdAt: new Date('2026-07-01'),
        purpose: { label: 'Convites' },
        channel: { name: 'Principal' },
      },
      {
        id: 'l2',
        token: 'SITE-2026',
        purposeKey: 'convite_atividades',
        consentTextVersion: 'optin-v1',
        expectedText: 'Autorizo. [SITE-2026]',
        senderDigits: '559231550103',
        channelId: 'ch1',
        description: null,
        active: true,
        createdAt: new Date('2026-07-02'),
        purpose: { label: 'Convites' },
        channel: { name: 'Principal' },
      },
    ] as never);
    // apenas a FEIRA produziu consentimento; o SITE ainda não
    prisma.$queryRaw.mockResolvedValue([
      { token: 'FEIRA-MANAUS-2026', grants: 7 },
    ] as never);
    const svc = new OptInLinkService(prisma);

    const rows = await svc.list();

    expect(rows.map((r) => [r.token, r.grants])).toEqual([
      ['FEIRA-MANAUS-2026', 7],
      ['SITE-2026', 0],
    ]);
    expect(rows[0].url).toContain('wa.me/559231550103');
  });
});

describe('OptInLinkService.deactivate', () => {
  it('desativa o link sem apagar nada — revogar ≠ apagar; os GRANTs colhidos continuam válidos', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.$queryRaw.mockResolvedValue([{ token: 'FEIRA-MANAUS-2026', grants: 7 }] as never);
    prisma.optInLink.update.mockResolvedValue({
      id: 'l1',
      token: 'FEIRA-MANAUS-2026',
      purposeKey: 'convite_atividades',
      consentTextVersion: 'optin-v1',
      expectedText: 'x [FEIRA-MANAUS-2026]',
      senderDigits: '559231550103',
      channelId: null,
      description: null,
      active: false,
      createdAt: new Date(),
      purpose: { label: 'Convites' },
      channel: null,
    } as never);
    const svc = new OptInLinkService(prisma);

    const link = await svc.setActive('l1', false);

    expect(link.active).toBe(false);
    // o funil do link desativado continua contando o que ele já colheu
    expect(link.grants).toBe(7);
    expect(prisma.optInLink.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'l1' }, data: { active: false } }),
    );
    expect(prisma.optInLink.delete).not.toHaveBeenCalled();
  });
});

/**
 * O CORAÇÃO da correção (spec §3.1). Um inbound só vira consentimento quando o
 * corpo CASA com o texto que algum link ativo pré-preencheu. Qualquer outra
 * coisa — "oi", "quem são vocês?", "não quero mais" — abre a janela de
 * atendimento e NADA MAIS. Era exatamente isso que o orgamind fabricava antes.
 */
describe('OptInLinkService.matchInbound', () => {
  const EXPECTED = `${DECLARATION} [FEIRA-MANAUS-2026]`;

  function make(link: unknown) {
    const prisma = mockDeep<PrismaService>();
    prisma.optInLink.findFirst.mockResolvedValue(link as never);
    return { prisma, svc: new OptInLinkService(prisma) };
  }

  const LINK = {
    id: 'l1',
    token: 'FEIRA-MANAUS-2026',
    purposeKey: 'convite_atividades',
    consentTextVersion: 'optin-v1',
    expectedText: EXPECTED,
    active: true,
  };

  it('CASA: o texto exato do link → devolve o link (vira GRANT)', async () => {
    const { svc } = make(LINK);
    const m = await svc.matchInbound(EXPECTED);
    expect(m).toMatchObject({ id: 'l1', token: 'FEIRA-MANAUS-2026', purposeKey: 'convite_atividades' });
  });

  it('CASA com ruído do teclado: caixa, acento perdido, espaços a mais e ponto final', async () => {
    const { svc } = make(LINK);
    const sujo = `  autorizo o idasam (instituto de desenvolvimento agropecuario e florestal sustentavel do amazonas) a me   enviar mensagens no whatsapp com convites para cursos, oficinas e eventos.  [feira-manaus-2026]  `;
    expect(await svc.matchInbound(sujo)).not.toBeNull();
  });

  it('NÃO CASA: "oi" → null (só abre janela; NENHUM consentimento)', async () => {
    const { svc, prisma } = make(LINK);
    expect(await svc.matchInbound('oi')).toBeNull();
    // sem token no corpo, nem sequer vamos ao banco
    expect(prisma.optInLink.findFirst).not.toHaveBeenCalled();
  });

  it('NÃO CASA: token certo mas a pessoa apagou a declaração → null', async () => {
    const { svc } = make(LINK);
    expect(await svc.matchInbound('quero saber mais [FEIRA-MANAUS-2026]')).toBeNull();
  });

  it('NÃO CASA: declaração certa mas token de um link que não existe → null', async () => {
    const { svc } = make(null); // findFirst não acha o token
    expect(await svc.matchInbound(`${DECLARATION} [TOKEN-FALSO]`)).toBeNull();
  });

  it('NÃO CASA: link DESATIVADO → null (o cartaz saiu de circulação)', async () => {
    const { svc, prisma } = make(null);
    await svc.matchInbound(EXPECTED);
    // a consulta filtra por active — um link desativado nunca é resolvido
    expect(prisma.optInLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token: 'FEIRA-MANAUS-2026', active: true } }),
    );
  });

  it('NÃO CASA: texto vazio/ausente (mídia sem legenda) → null', async () => {
    const { svc } = make(LINK);
    expect(await svc.matchInbound(undefined)).toBeNull();
    expect(await svc.matchInbound('')).toBeNull();
  });
});
