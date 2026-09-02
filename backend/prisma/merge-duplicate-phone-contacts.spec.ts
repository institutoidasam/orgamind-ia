import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import {
  mergeDuplicatePhoneContacts,
  maskPhonesInLog,
} from './merge-duplicate-phone-contacts';

/**
 * O REPARO DAS DUPLICATAS DO 9º DÍGITO.
 *
 * O caso real (produção, 08/07): a Katarina está na planilha como
 * +5592986550101; ela respondeu ao broadcast e o WhatsApp reportou o inbound
 * como +559286550101; a variante não era gerada, o ingest não a achou e criou um
 * contato NOVO — que é onde ficaram a conversa e as mensagens dela.
 *
 * O que este script NÃO pode fazer, sob nenhuma hipótese: apagar o contato novo
 * antes de tirar as mensagens de cima dele. `Message.contactId` é
 * `onDelete: Cascade` — a ordem errada apaga as respostas da campanha.
 */
/**
 * O par é fundido DENTRO de uma transação interativa (`db.$transaction(fn)`) —
 * é o que garante "ou o par inteiro, ou nada". O mock do Prisma não executa a
 * função sozinho, então aqui ele executa passando o próprio mock como `tx`:
 * assim os testes continuam assertando sobre o ARGUMENTO das chamadas reais.
 * `message.findMany` é o que a neutralização de colisão usa; vazio por padrão.
 */
function armaTransacaoEColisoes(db: DeepMockProxy<PrismaClient>) {
  (db.$transaction as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
    ((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: PrismaClient) => unknown)(db)
        : Promise.all(arg as unknown[])) as never,
  );
  db.message.findMany.mockResolvedValue([] as never);
}

describe('mergeDuplicatePhoneContacts', () => {
  let db: DeepMockProxy<PrismaClient>;

  const CANONICAL = {
    id: 'c-planilha',
    phoneE164: '+5592986550101', // 9 díg. — o da planilha
    name: 'Katarina Pereira Rodrigues',
    city: 'Manaus',
    group: 'Zona Leste',
    tags: ['apoiador'],
    whatsappValid: true,
    createdAt: new Date('2026-07-08T10:00:00Z'),
  };

  const DUPLICATE = {
    id: 'c-ingest',
    phoneE164: '+559286550101', // 8 díg. — o que o ingest fabricou
    name: '👩🙁', // nome de perfil do WhatsApp
    city: null,
    group: null,
    tags: [],
    whatsappValid: null,
    createdAt: new Date('2026-07-13T09:00:00Z'),
  };

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockResolvedValue([CANONICAL, DUPLICATE] as never);
    db.importItem.count.mockResolvedValue(0 as never);
    db.message.count.mockResolvedValue(3 as never);
    db.conversation.findMany.mockResolvedValue([] as never);
    db.conversation.findFirst.mockResolvedValue(null as never);
    db.message.findFirst.mockResolvedValue(null as never);
    db.conversation.findUnique.mockResolvedValue(null as never);
    armaTransacaoEColisoes(db);
  });

  it('acha o par pelas variantes corrigidas e elege o de 9 dígitos como canônico', async () => {
    const r = await mergeDuplicatePhoneContacts(db, { apply: false });

    expect(r.pairs).toBe(1);
    expect(r.merged).toBe(1);
    // Não existe mais "ambíguo": duas variantes são o mesmo assinante, ponto.
    expect(r.messagesMoved).toBe(3);
  });

  it('DRY-RUN não escreve absolutamente nada', async () => {
    await mergeDuplicatePhoneContacts(db, { apply: false });

    expect(db.contact.delete).not.toHaveBeenCalled();
    expect(db.contact.update).not.toHaveBeenCalled();
    expect(db.message.updateMany).not.toHaveBeenCalled();
    expect(db.conversation.update).not.toHaveBeenCalled();
    expect(db.conversation.delete).not.toHaveBeenCalled();
  });

  it('MIGRA as mensagens do duplicado ANTES de apagá-lo (Message.contactId é Cascade)', async () => {
    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'c-ingest' },
      data: { contactId: 'c-planilha' },
    });
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c-ingest' } });

    // A ORDEM é a garantia. Invertida, o cascade leva as respostas da campanha.
    const moved = db.message.updateMany.mock.invocationCallOrder[0];
    const deleted = db.contact.delete.mock.invocationCallOrder[0];
    expect(moved).toBeLessThan(deleted);
  });

  it('reponta a conversa do duplicado quando o canônico não tem conversa no canal', async () => {
    db.conversation.findMany.mockResolvedValue([
      { id: 'conv-dup', instanceId: 'i1', lastMessageAt: new Date('2026-07-13T09:05:00Z'), createdAt: new Date('2026-07-13T09:00:00Z') },
    ] as never);
    db.conversation.findFirst.mockResolvedValue(null as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.conversationsMoved).toBe(1);
    expect(r.conversationsFolded).toBe(0);
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-dup' },
      data: { contactId: 'c-planilha' },
    });
    expect(db.conversation.delete).not.toHaveBeenCalled();
  });

  it('FUNDE as duas conversas do mesmo canal mantendo a MAIS ATIVA — e move as mensagens antes de apagar a outra', async () => {
    // O disparo caiu na conversa do canônico (JID de 9 díg.); a RESPOSTA dela
    // caiu na do duplicado (JID de 8 díg., que é o que o provedor reporta) — e
    // por isso a do duplicado é a mais recente.
    db.conversation.findMany.mockResolvedValue([
      { id: 'conv-dup', instanceId: 'i1', lastMessageAt: new Date('2026-07-13T09:05:00Z'), createdAt: new Date('2026-07-13T09:00:00Z') },
    ] as never);
    db.conversation.findFirst.mockResolvedValue({
      id: 'conv-canon', lastMessageAt: new Date('2026-07-12T08:00:00Z'), createdAt: new Date('2026-07-12T08:00:00Z'),
    } as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.conversationsFolded).toBe(1);
    // Sobrevive a do DUPLICADO (a que tem o inbound). Se apagássemos ela, o
    // próximo inbound recriaria a conversa de 8 díg. e partiria a thread de novo.
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-canon' },
      data: { conversationId: 'conv-dup' },
    });
    expect(db.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conv-canon' } });
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-dup' },
      data: { contactId: 'c-planilha' },
    });

    // Mensagens saem da perdedora ANTES de ela ser apagada (Cascade em conversationId).
    const movedMsgs = db.message.updateMany.mock.invocationCallOrder[0];
    const deletedConv = db.conversation.delete.mock.invocationCallOrder[0];
    expect(movedMsgs).toBeLessThan(deletedConv);
  });

  /**
   * O BURACO QUE DEIXAVA A BASE SUJA APESAR DO SCRIPT RODAR TODO DEPLOY.
   *
   * O par que o IMPORT defeituoso cria tem procedência de planilha DOS DOIS
   * LADOS — e era exatamente esse par que o script classificava como AMBÍGUO e
   * não tocava. Duas linhas que são variante uma da outra são, por definição do
   * WhatsApp, o MESMO assinante: não existem duas pessoas com o mesmo número.
   */
  it('FUNDE o par mesmo quando o de 12 dígitos também tem procedência de planilha', async () => {
    db.contact.findMany.mockResolvedValue([
      CANONICAL,
      { ...DUPLICATE, city: 'Manaus', group: 'Centro', whatsappValid: true },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.pairs).toBe(1);
    expect(r.merged).toBe(1);
    // O nome de perfil do WhatsApp e o grupo do gêmeo divergem do que a planilha
    // gravou no canônico: o canônico vence e o par sai REPORTADO — não recusado.
    expect(r.conflicts).toEqual([
      {
        canonicalPhone: '+5592986550101',
        duplicatePhone: '+559286550101',
        fields: ['name', 'group'],
      },
    ]);
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c-ingest' } });
  });

  it('FUNDE o par mesmo quando o de 12 dígitos tem ImportItem', async () => {
    db.importItem.count.mockResolvedValue(1 as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.merged).toBe(1);
    expect(db.importItem.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'c-ingest' },
      data: { contactId: 'c-planilha' },
    });
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c-ingest' } });
  });

  it('PRESERVA DADO: campo vazio no sobrevivente é preenchido pelo gêmeo', async () => {
    // As duas grafias igualmente mudas (mesma evidência, mesmo whatsappValid):
    // aí — e só aí — o formato desempata e o de 13 díg. sobrevive.
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, city: null, group: null, whatsappValid: null },
      { ...DUPLICATE, city: 'Manaus', group: 'Zona Leste', whatsappValid: null },
    ] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: {
        city: 'Manaus',
        group: 'Zona Leste',
        tags: ['apoiador'],
      },
    });
  });

  it('NUNCA sobrescreve valor existente do canônico com o do gêmeo', async () => {
    db.contact.findMany.mockResolvedValue([
      CANONICAL, // city Manaus, group Zona Leste, whatsappValid true
      {
        ...DUPLICATE,
        name: 'Outro Nome',
        city: 'Itacoatiara',
        group: 'Outro Grupo',
        whatsappValid: false,
      },
    ] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: { tags: ['apoiador'] },
    });
  });

  it('REPORTA os campos em conflito para conferência humana — sem deixar de fundir', async () => {
    db.contact.findMany.mockResolvedValue([
      CANONICAL,
      { ...DUPLICATE, name: 'Outro Nome', city: 'Itacoatiara' },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.merged).toBe(1);
    expect(r.conflicts).toEqual([
      {
        canonicalPhone: '+5592986550101',
        duplicatePhone: '+559286550101',
        fields: ['name', 'city'],
      },
    ]);
  });

  /**
   * O `optedOut` que a fusão escreve é REDE, não a trava.
   *
   * A trava é a SuppressionList (`@id phoneHash`, sem FK com Contact, consultada
   * por `phoneHashVariants`): ela sobrevive ao delete do gêmeo por conta própria.
   * `Contact.optedOut` é cache derivado, e o `rehydrate` que roda logo depois o
   * REESCREVE a partir dela (`refreshContactCache`) — desfazendo este write
   * sempre que o titular tem trilha de consentimento. Estes dois testes dizem a
   * verdade sobre os DOIS casos, em vez de mockar o rehydrate com `vi.fn()` e
   * provar um estado que a produção desfaz.
   */
  it('sem trilha de consentimento, o opt-out do gêmeo é preservado pela fusão (a rede)', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, optedOut: false },
      { ...DUPLICATE, optedOut: true },
    ] as never);
    // ConsentService.rehydrate sem NENHUM ConsentEvent retorna cedo e não toca
    // no cache — é o único caso em que este write é o que fica.
    const rehydrate = vi.fn().mockResolvedValue([]);

    await mergeDuplicatePhoneContacts(db, { apply: true, rehydrate });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: { optedOut: true, tags: ['apoiador'] },
    });
  });

  it('com trilha, quem decide o optedOut é a SuppressionList — o rehydrate roda DEPOIS e é a última palavra', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, optedOut: false },
      { ...DUPLICATE, optedOut: true },
    ] as never);
    // O rehydrate real termina em refreshContactCache, que grava
    // `optedOut: suppressed !== null` INCONDICIONALMENTE. Aqui não há supressão
    // para nenhuma das duas grafias: o `true` da fusão é sobrescrito.
    const rehydrate = vi.fn(async (contactId: string) => {
      await db.contact.update({
        where: { id: contactId },
        data: { optInAt: null, optInSource: null, optedOut: false },
      });
    });

    await mergeDuplicatePhoneContacts(db, { apply: true, rehydrate });

    const ultimaEscrita = db.contact.update.mock.calls.at(-1)?.[0];
    expect(ultimaEscrita).toMatchObject({
      where: { id: 'c-planilha' },
      data: { optedOut: false },
    });
    // E a ORDEM é essa mesmo: a fusão escreve, a trilha corrige.
    expect(db.contact.update.mock.invocationCallOrder[0]).toBeLessThan(
      db.contact.update.mock.invocationCallOrder[1],
    );
  });

  it('DRY-RUN conta o par de planilha como fundível, sem escrever nada', async () => {
    db.contact.findMany.mockResolvedValue([
      CANONICAL,
      { ...DUPLICATE, city: 'Manaus', whatsappValid: true },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: false });

    expect(r.merged).toBe(1);
    expect(db.contact.update).not.toHaveBeenCalled();
    expect(db.contact.delete).not.toHaveBeenCalled();
  });

  it('adota o nome de perfil só quando o canônico não tem nome — nunca sobrescreve o da planilha', async () => {
    await mergeDuplicatePhoneContacts(db, { apply: true });

    // O canônico TEM nome ("Katarina..."): o "👩🙁" não pode vencer.
    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: { tags: ['apoiador'] },
    });
  });

  it('adota o nome do duplicado quando o canônico está sem nome', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, name: null },
      { ...DUPLICATE, name: 'Katarina R.' },
    ] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: { name: 'Katarina R.', tags: ['apoiador'] },
    });
  });

  it('une as tags dos dois sem duplicar', async () => {
    db.contact.findMany.mockResolvedValue([
      CANONICAL,
      { ...DUPLICATE, tags: ['apoiador', 'respondeu'] },
    ] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c-planilha' },
      data: { tags: ['apoiador', 'respondeu'] },
    });
  });

  it('REIDRATA o consentimento do canônico ANTES de apagar o duplicado', async () => {
    const rehydrate = vi.fn().mockResolvedValue([]);

    await mergeDuplicatePhoneContacts(db, { apply: true, rehydrate });

    expect(rehydrate).toHaveBeenCalledWith('c-planilha', '+5592986550101');
    // Antes do delete: se a reidratação falhar, o duplicado ainda existe e a
    // re-execução refaz o par — em vez de deixar o canônico sem as finalidades
    // que só o duplicado tinha (o opt-in que ela deu ao responder).
    expect(rehydrate.mock.invocationCallOrder[0]).toBeLessThan(
      db.contact.delete.mock.invocationCallOrder[0],
    );
  });

  it('reporta a falha da reidratação sem abortar o lote', async () => {
    const rehydrate = vi.fn().mockRejectedValue(new Error('sem sal'));

    const r = await mergeDuplicatePhoneContacts(db, { apply: true, rehydrate });

    expect(r.rehydrateFailures).toEqual(['+5592986550101']);
    expect(r.merged).toBe(1);
  });

  it('é IDEMPOTENTE: sem o duplicado na base, não há par nem escrita', async () => {
    db.contact.findMany.mockResolvedValue([CANONICAL] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.pairs).toBe(0);
    expect(r.merged).toBe(0);
    expect(db.contact.delete).not.toHaveBeenCalled();
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });

  it('não pareia um FIXO com um celular fabricado', async () => {
    // +559232145678 é fixo (8 díg., começa com 3). Prefixar um 9 inventaria
    // +5592932145678, que é de outra pessoa — não pode virar par.
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, id: 'c-fixo', phoneE164: '+5592932145678' },
      { ...DUPLICATE, id: 'c-outro', phoneE164: '+559232145678' },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.pairs).toBe(0);
    expect(db.contact.delete).not.toHaveBeenCalled();
  });

  it('casa também o par 99… que já funcionava antes do fix', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...CANONICAL, id: 'c9', phoneE164: '+5592995550101' },
      { ...DUPLICATE, id: 'c8', phoneE164: '+559295550101' },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.pairs).toBe(1);
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c8' } });
  });
});

/**
 * A ELEIÇÃO DO SOBREVIVENTE — a parte que apaga uma linha para sempre.
 *
 * O incidente real deste projeto ([[picoa-9o-digito-entrega]]) mediu o A/B no
 * MESMO número: a forma de 13 dígitos parou em `Sent` para sempre; a de 12
 * chegou a `Delivered` em 15 segundos. O WhatsApp aceita a stanza da grafia
 * errada e a descarta CALADO.
 *
 * Eleger o sobrevivente por FORMATO ("13 dígitos vence") é, portanto, capaz de
 * fazer a base inteira convergir para a grafia que NÃO ENTREGA — e o `delete` é
 * irreversível. A regra passa a ser: quem manda é a EVIDÊNCIA de entrega
 * (DELIVERED/READ → inbound recebido → validação do WhatsApp); o formato só
 * desempata quando as duas linhas são igualmente mudas.
 */
describe('mergeDuplicatePhoneContacts — quem sobrevive é quem ENTREGA', () => {
  let db: DeepMockProxy<PrismaClient>;

  const NOVE = {
    id: 'c9',
    phoneE164: '+5592995550101', // 13 díg. — a grafia que o incidente mostrou muda
    name: 'Katarina',
    city: 'Manaus',
    group: null,
    tags: [],
    whatsappValid: null,
    optedOut: false,
    createdAt: new Date('2026-07-08T10:00:00Z'),
  };

  const OITO = {
    id: 'c8',
    phoneE164: '+559295550101', // 12 díg. — a que chegou a Delivered em 15s
    name: null,
    city: null,
    group: null,
    tags: [],
    whatsappValid: null,
    optedOut: false,
    createdAt: new Date('2026-07-13T09:00:00Z'),
  };

  /**
   * Conta mensagens OLHANDO O `where` — é o argumento que importa, não um
   * retorno fabricado. `evidence` diz, por contato, quantas DELIVERED/READ e
   * quantas INBOUND existem; qualquer outro `count` é o total do contato.
   */
  function countByWhere(
    evidence: Record<string, { delivered?: number; inbound?: number; total?: number }>,
  ) {
    return (args: { where: Record<string, unknown> }) => {
      const id = args.where.contactId as string;
      const e = evidence[id] ?? {};
      if (args.where.status) return Promise.resolve(e.delivered ?? 0);
      if (args.where.direction === 'INBOUND') return Promise.resolve(e.inbound ?? 0);
      return Promise.resolve(e.total ?? 0);
    };
  }

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockResolvedValue([NOVE, OITO] as never);
    db.importItem.count.mockResolvedValue(0 as never);
    db.conversation.findMany.mockResolvedValue([] as never);
    db.conversation.findFirst.mockResolvedValue(null as never);
    db.message.count.mockImplementation(countByWhere({}) as never);
    armaTransacaoEColisoes(db);
  });

  it('ENTREGA CONFIRMADA vence o formato: o de 12 dígitos sobrevive e o de 13 é apagado', async () => {
    db.message.count.mockImplementation(
      countByWhere({ c8: { delivered: 4, total: 9 }, c9: { delivered: 0, total: 2 } }) as never,
    );

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c9' } });
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'c9' },
      data: { contactId: 'c8' },
    });
    expect(r.merges[0]).toMatchObject({
      survivorPhone: '+559295550101',
      deletedPhone: '+5592995550101',
      criterion: 'entrega_confirmada',
    });
  });

  it('a evidência é contada pelo ARGUMENTO certo: OUTBOUND em DELIVERED/READ', async () => {
    await mergeDuplicatePhoneContacts(db, { apply: false });

    expect(db.message.count).toHaveBeenCalledWith({
      where: {
        contactId: 'c8',
        direction: 'OUTBOUND',
        status: { in: ['DELIVERED', 'READ'] },
      },
    });
    expect(db.message.count).toHaveBeenCalledWith({
      where: { contactId: 'c9', direction: 'INBOUND' },
    });
  });

  it('sem entrega dos dois lados, quem RESPONDEU decide', async () => {
    db.message.count.mockImplementation(
      countByWhere({ c8: { inbound: 3, total: 3 }, c9: { inbound: 0, total: 1 } }) as never,
    );

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c9' } });
    expect(r.merges[0].criterion).toBe('resposta_recebida');
  });

  it('sem mensagem nenhuma, `whatsappValid: true` vence `false` — mesmo estando no de 12 dígitos', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...NOVE, whatsappValid: false },
      { ...OITO, whatsappValid: true },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c9' } });
    expect(r.merges[0].criterion).toBe('validacao_whatsapp');
  });

  it('NUNCA copia `whatsappValid` do gêmeo: é medida de OUTRA string, não do sobrevivente', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...NOVE, whatsappValid: null },
      { ...OITO, whatsappValid: true },
    ] as never);
    // O de 13 dígitos ganha por entrega confirmada, apesar do `true` do outro.
    db.message.count.mockImplementation(
      countByWhere({ c9: { delivered: 5, total: 5 }, c8: { total: 0 } }) as never,
    );

    await mergeDuplicatePhoneContacts(db, { apply: true });

    const data = db.contact.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('whatsappValid');
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c8' } });
  });

  it('sobrevivente marcado `whatsappValid: false` que comprovadamente ENTREGOU volta para a fila de recheque', async () => {
    db.contact.findMany.mockResolvedValue([
      { ...NOVE, whatsappValid: false },
      { ...OITO, whatsappValid: null },
    ] as never);
    db.message.count.mockImplementation(
      countByWhere({ c9: { delivered: 2, total: 2 }, c8: { total: 0 } }) as never,
    );

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: 'c9' },
      data: expect.objectContaining({ whatsappValid: null, whatsappCheckedAt: null }),
    });
  });

  it('sem evidência de lado nenhum, o formato desempata e o de 13 dígitos sobrevive', async () => {
    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'c8' } });
    expect(r.merges[0].criterion).toBe('formato');
  });

  it('reidratação que FALHA não apaga o gêmeo — o par tem de sobrar para a próxima execução', async () => {
    const rehydrate = vi.fn().mockRejectedValue(new Error('sem sal'));

    const r = await mergeDuplicatePhoneContacts(db, { apply: true, rehydrate });

    expect(r.rehydrateFailures).toEqual(['+5592995550101']);
    expect(db.contact.delete).not.toHaveBeenCalled();
  });
});

/**
 * ★ A COLISÃO COM A TRAVA DE BANCO — o defeito que a integração dos dois pacotes
 *   criou e que só aparece contra um Postgres de verdade.
 *
 * A auditoria provou contra Postgres real: os dois gêmeos entram na MESMA
 * campanha, cada um com a sua `Message` viva; no instante em que o merge reaponta
 * `Message.contactId`, o par (campanha, contato) fica duplicado em estado vivo e
 * o índice único parcial recusa (P2002). O script morria no PRIMEIRO par, depois
 * de já ter apagado uma conversa, e o `|| echo non-fatal` do compose devolvia 0.
 *
 * Estes testes assertam sobre o ARGUMENTO das chamadas (com Prisma mockado o
 * `where` é ignorado e o retorno é fabricado — só o argumento é verdade). A prova
 * de que o conserto FUNCIONA contra o índice de verdade está no relatório da
 * frente, executada contra postgres:16-alpine com as migrations reais.
 */
describe('mergeDuplicatePhoneContacts — a colisão com "uma linha viva por (campanha, contato)"', () => {
  let db: DeepMockProxy<PrismaClient>;

  const NOVE = {
    id: 'c9',
    phoneE164: '+5592986550101',
    name: 'Katarina',
    city: 'Manaus',
    group: null,
    tags: [],
    whatsappValid: null,
    optedOut: false,
    createdAt: new Date('2026-07-08T10:00:00Z'),
  };
  const OITO = {
    id: 'c8',
    phoneE164: '+559286550101',
    name: null,
    city: null,
    group: null,
    tags: [],
    whatsappValid: null,
    optedOut: false,
    createdAt: new Date('2026-07-13T09:00:00Z'),
  };

  /** A chamada que NEUTRALIZA (where por id) vs. a que REPONTA (where por contactId). */
  const neutralizacoes = () =>
    db.message.updateMany.mock.calls.filter(
      (c) => (c[0] as { where: Record<string, unknown> }).where.id !== undefined,
    );
  const repontamentos = () =>
    db.message.updateMany.mock.calls.filter(
      (c) => (c[0] as { where: Record<string, unknown> }).where.contactId !== undefined,
    );

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockResolvedValue([NOVE, OITO] as never);
    db.message.count.mockResolvedValue(0 as never);
    db.importItem.count.mockResolvedValue(0 as never);
    db.conversation.findMany.mockResolvedValue([] as never);
    db.conversation.findFirst.mockResolvedValue(null as never);
    armaTransacaoEColisoes(db);
  });

  it('NEUTRALIZA a linha viva menos avançada ANTES de repontar o contactId', async () => {
    // Os dois gêmeos na MESMA campanha, os dois vivos: é o caso que estoura.
    db.message.findMany.mockResolvedValue([
      { id: 'm9', campaignId: 'cmp1', status: 'SENT', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
      { id: 'm8', campaignId: 'cmp1', status: 'DELIVERED', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    // A busca olha os DOIS contatos, só OUTBOUND de campanha, só estados vivos.
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contactId: { in: expect.arrayContaining(['c9', 'c8']) },
          direction: 'OUTBOUND',
          campaignId: { not: null },
          status: {
            in: ['QUEUED', 'WAITING_INSTANCE', 'SENDING', 'SENT', 'DELIVERED', 'READ'],
          },
        }),
      }),
    );

    // DELIVERED > SENT: quem cai é a SENT, e vira CANCELLED com o MESMO errorCode
    // que o PASSO 1 da migration usa. Nada é apagado.
    expect(neutralizacoes()).toHaveLength(1);
    expect(neutralizacoes()[0][0]).toEqual({
      where: { id: { in: ['m9'] } },
      data: expect.objectContaining({
        status: 'CANCELLED',
        errorCode: 'duplicate_row_neutralized',
      }),
    });
    expect(r.liveRowsNeutralized).toBe(1);

    // E — o ponto todo — ANTES do repontamento, senão o banco recusa.
    const ordemNeutralizacao = db.message.updateMany.mock.invocationCallOrder[0];
    const ordemRepontamento =
      db.message.updateMany.mock.invocationCallOrder[
        db.message.updateMany.mock.calls.indexOf(repontamentos()[0])
      ];
    expect(ordemNeutralizacao).toBeLessThan(ordemRepontamento);
    expect(repontamentos()[0][0]).toEqual({
      where: { contactId: 'c8' },
      data: { contactId: 'c9' },
    });
  });

  it('usa a régua da migration: mais avançada no funil fica, empate → mais antiga', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'a', campaignId: 'cmp1', status: 'QUEUED', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
      { id: 'b', campaignId: 'cmp1', status: 'READ', createdAt: new Date('2026-08-05'), errorCode: null, errorMessage: null },
      { id: 'c', campaignId: 'cmp2', status: 'SENDING', createdAt: new Date('2026-08-02'), errorCode: null, errorMessage: null },
      { id: 'd', campaignId: 'cmp2', status: 'SENDING', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
      { id: 'e', campaignId: 'cmp3', status: 'SENT', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    // cmp1: READ vence QUEUED → cai 'a'. cmp2: empate em SENDING → fica a MAIS
    // ANTIGA ('d') e cai 'c'. cmp3: linha sozinha, ninguém é tocado.
    expect(neutralizacoes()[0][0]).toEqual(
      expect.objectContaining({ where: { id: { in: ['a', 'c'] } } }),
    );
    expect(r.liveRowsNeutralized).toBe(2);
  });

  it('GUARDA o estado anterior antes de sobrescrever — a neutralização é reversível', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'm9', campaignId: 'cmp1', status: 'WAITING_INSTANCE', createdAt: new Date('2026-08-01'), errorCode: 'zernio.timeout', errorMessage: 'estourou' },
      { id: 'm8', campaignId: 'cmp1', status: 'DELIVERED', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
    ] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    // Sem isto, WAITING_INSTANCE e QUEUED ficam indistinguíveis depois do fato e
    // a prova da falha anterior (que o F2 preserva de propósito) some.
    const gravou = db.$executeRaw.mock.calls;
    expect(gravou).toHaveLength(1);
    expect(JSON.stringify(gravou[0])).toContain('_message_dup_neutralized_20260819');
    expect(gravou[0].slice(1)).toEqual(
      expect.arrayContaining(['m9', 'WAITING_INSTANCE', 'zernio.timeout', 'estourou']),
    );
  });

  it('DRY-RUN conta a colisão e não escreve nada', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'm9', campaignId: 'cmp1', status: 'SENT', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
      { id: 'm8', campaignId: 'cmp1', status: 'DELIVERED', createdAt: new Date('2026-08-01'), errorCode: null, errorMessage: null },
    ] as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: false });

    expect(r.liveRowsNeutralized).toBe(1);
    expect(db.message.updateMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('cada par é fundido DENTRO de uma transação — ou inteiro, ou nada', async () => {
    db.message.findMany.mockResolvedValue([] as never);

    await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof db.$transaction.mock.calls[0][0]).toBe('function');
  });
});

/**
 * ★ UM PAR DOENTE NÃO PODE SEQUESTRAR OS OUTROS 27.
 *
 * Antes, o erro subia e a varredura morria no primeiro par ruim — em TODO deploy,
 * sempre no mesmo lugar, deixando todos os pares seguintes eternamente sujos.
 */
describe('mergeDuplicatePhoneContacts — falha de um par não mata o lote', () => {
  let db: DeepMockProxy<PrismaClient>;

  const P = (id: string, phone: string) => ({
    id,
    phoneE164: phone,
    name: null,
    city: null,
    group: null,
    tags: [],
    whatsappValid: null,
    optedOut: false,
    createdAt: new Date('2026-07-08T10:00:00Z'),
  });

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.contact.findMany.mockResolvedValue([
      P('c9', '+5592986550101'),
      P('c8', '+559286550101'),
      P('d9', '+5592971112222'),
      P('d8', '+559271112222'),
    ] as never);
    db.message.count.mockResolvedValue(0 as never);
    db.importItem.count.mockResolvedValue(0 as never);
    db.conversation.findMany.mockResolvedValue([] as never);
    db.conversation.findFirst.mockResolvedValue(null as never);
    armaTransacaoEColisoes(db);
  });

  it('registra o par que estourou no relatório e SEGUE para o próximo', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`campaignId`,`contactId`)'), {
      code: 'P2002',
    });
    db.contact.update.mockImplementation(((args: { where: { id: string } }) =>
      args.where.id === 'c9' ? Promise.reject(p2002) : Promise.resolve({} as never)) as never);

    const r = await mergeDuplicatePhoneContacts(db, { apply: true });

    expect(r.pairs).toBe(2);
    expect(r.merged).toBe(1); // o par sadio foi fundido mesmo assim
    expect(r.failedPairs).toEqual([
      expect.objectContaining({ survivorId: 'c9', deletedId: 'c8', code: 'P2002' }),
    ]);
    // O par que falhou NÃO teve o contato apagado; o outro sim.
    expect(db.contact.delete).toHaveBeenCalledTimes(1);
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: 'd8' } });
  });
});

/**
 * O telefone do eleitor não vai inteiro para o log do deploy — o stdout do
 * contêiner `migrate` é o que a API do Dokploy expõe, e numa campanha eleitoral
 * isso é dado pessoal com finalidade político-partidária.
 */
describe('maskPhonesInLog', () => {
  it('mascara o miolo do E.164 nas DUAS grafias, preservando DDD e 4 últimos', () => {
    expect(maskPhonesInLog('FUNDIDO +5592986550101 (fica) ← +559286550101 (some)')).toBe(
      'FUNDIDO +5592*****0101 (fica) ← +5592*****0101 (some)',
    );
  });

  it('mascara TODAS as ocorrências da linha, inclusive as do `detail`', () => {
    const linha =
      'FUNDIDO +5592986550101 ← +559286550101 | entrega_confirmada: DELIVERED/READ +5592986550101=0 × +559286550101=3';
    expect(maskPhonesInLog(linha)).not.toMatch(/\+55\d{10}/);
  });

  it('não mexe no que não é telefone (ids, contadores)', () => {
    expect(maskPhonesInLog('pares encontrados 28 | id c9x1y2')).toBe(
      'pares encontrados 28 | id c9x1y2',
    );
  });
});
