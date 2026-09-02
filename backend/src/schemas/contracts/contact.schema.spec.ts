import { describe, it, expect } from 'vitest';

import {
  listContactsQuerySchema,
  contactSchema,
  contactListItemSchema,
  bulkDeleteContactsSchema,
} from './contact.schema';

describe('listContactsQuerySchema.optedOut', () => {
  it('parses the string "false" as boolean false (not truthy-coerced)', () => {
    // Regression: z.coerce.boolean() turns any non-empty string into `true`,
    // so `?optedOut=false` (meant to list active contacts) was returning only
    // opted-out contacts — a privacy/LGPD inversion.
    const parsed = listContactsQuerySchema.parse({ optedOut: 'false' });
    expect(parsed.optedOut).toBe(false);
  });

  it('parses the string "true" as boolean true', () => {
    const parsed = listContactsQuerySchema.parse({ optedOut: 'true' });
    expect(parsed.optedOut).toBe(true);
  });

  it('leaves optedOut undefined when the param is absent', () => {
    const parsed = listContactsQuerySchema.parse({});
    expect(parsed.optedOut).toBeUndefined();
  });

  it('treats an empty optedOut param as absent (no filter), not a 400', () => {
    // z.stringbool() throws on '' — an empty query value (?optedOut=) should
    // mean "no filter", not a validation error.
    const parsed = listContactsQuerySchema.parse({ optedOut: '' });
    expect(parsed.optedOut).toBeUndefined();
  });
});

/**
 * F2 T6 — o contrato de SAÍDA do Contact ficou para trás de dois lotes de
 * colunas que o backend já devolve na prática:
 *   1. O CACHE de marketing-reachability (marketingUndeliverableAt/Code/Reason)
 *      — já vinha na row do Prisma, só nunca foi DECLARADO aqui.
 *   2. As colunas novas do F2 (lastFailureReason/Code/At, failureCount).
 * Um campo que o backend devolve mas o schema não declara é invisível para
 * quem confia no contrato (validate/parse de resposta, geração de tipos) —
 * fica lá "por acidente", e o primeiro refactor que rodar strip/parse na
 * saída apagaria os quatro campos sem ninguém notar.
 */
/**
 * As datas do fixture são STRING ISO, não `new Date()`: o contrato descreve o
 * JSON que trafega na REDE — e em JSON data é sempre string (é nisso que a row
 * do Prisma se transforma ao ser serializada). Antes elas eram objetos `Date`
 * porque o `z.coerce.date()` os aceitava de brinde; o `dateFromIso()` que o
 * substituiu (ver date.schema.ts — `Date` na ENTRADA derruba o Swagger no boot)
 * só aceita a string, que é o que o cliente de fato recebe.
 */
describe('contactSchema — campos de falha/entregabilidade', () => {
  const base = {
    id: 'c1',
    phoneE164: '+5592991110001',
    name: null,
    city: null,
    group: null,
    tags: [],
    customFields: null,
    optedOut: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    whatsappValid: null,
    whatsappCheckedAt: null,
    profilePictureUrl: null,
    waLabels: [],
    // Os campos de falha/entregabilidade têm o caso comum (nunca falhou) como
    // default no `base` — cada teste só sobrescreve o que quer exercitar.
    marketingUndeliverableAt: null,
    marketingUndeliverableCode: null,
    marketingUndeliverableReason: null,
    lastFailureReason: null,
    lastFailureCode: null,
    lastFailureAt: null,
    failureCount: 0,
  };

  it('declara marketingUndeliverableAt/Code/Reason (o backend já os devolvia)', () => {
    const parsed = contactSchema.parse({
      ...base,
      marketingUndeliverableAt: new Date().toISOString(),
      marketingUndeliverableCode: '131026',
      marketingUndeliverableReason: 'O destinatário desligou marketing.',
    });
    expect(parsed.marketingUndeliverableCode).toBe('131026');
    expect(parsed.marketingUndeliverableReason).toBe(
      'O destinatário desligou marketing.',
    );
  });

  it('aceita marketingUndeliverableAt/Code/Reason nulos (o caso comum: nunca falhou)', () => {
    const parsed = contactSchema.parse(base);
    expect(parsed.marketingUndeliverableAt).toBeNull();
  });

  it('declara lastFailureReason/Code/At + failureCount (F2)', () => {
    const parsed = contactSchema.parse({
      ...base,
      lastFailureReason: 'OPT_OUT',
      lastFailureCode: '131050',
      lastFailureAt: new Date().toISOString(),
      failureCount: 3,
    });
    expect(parsed.lastFailureReason).toBe('OPT_OUT');
    expect(parsed.failureCount).toBe(3);
  });

  it('aceita lastFailureReason/Code/At nulos e failureCount:0 (nunca falhou)', () => {
    const parsed = contactSchema.parse(base);
    expect(parsed.lastFailureReason).toBeNull();
    expect(parsed.failureCount).toBe(0);
  });

  it('rejeita um lastFailureReason fora do enum FailureReason', () => {
    const result = contactSchema.safeParse({
      ...base,
      lastFailureReason: 'NOT_A_REAL_REASON',
    });
    expect(result.success).toBe(false);
  });
});

describe('listContactsQuerySchema.failureReason', () => {
  it('aceita failureReason como filtro (um valor do enum FailureReason)', () => {
    const parsed = listContactsQuerySchema.parse({
      failureReason: 'TELEFONE_INVALIDO',
    });
    expect(parsed.failureReason).toBe('TELEFONE_INVALIDO');
  });

  it('deixa failureReason undefined quando ausente (sem filtro)', () => {
    const parsed = listContactsQuerySchema.parse({});
    expect(parsed.failureReason).toBeUndefined();
  });

  it('rejeita um failureReason fora do enum', () => {
    const result = listContactsQuerySchema.safeParse({
      failureReason: 'not_a_reason',
    });
    expect(result.success).toBe(false);
  });
});

describe('listContactsQuerySchema.receivedCampaignId', () => {
  it('aceita receivedCampaignId como filtro (id de campanha)', () => {
    const parsed = listContactsQuerySchema.parse({
      receivedCampaignId: 'camp1',
    });
    expect(parsed.receivedCampaignId).toBe('camp1');
  });

  it('deixa receivedCampaignId undefined quando ausente (sem filtro)', () => {
    const parsed = listContactsQuerySchema.parse({});
    expect(parsed.receivedCampaignId).toBeUndefined();
  });

  it('trata receivedCampaignId vazio como ausente (sem filtro), não como 400', () => {
    // Mesmo motivo do optedOut acima: o <select> da tela manda `?…=` quando o
    // operador escolhe "todas as campanhas". Isso é "sem filtro", não erro.
    const parsed = listContactsQuerySchema.parse({ receivedCampaignId: '' });
    expect(parsed.receivedCampaignId).toBeUndefined();
  });
});

/**
 * O contrato da LINHA DA LISTA é maior que o do Contact cru: só a listagem
 * agrega `campaignsReceived`. Um `create`/`update` devolve a row do Prisma e
 * NÃO tem esse campo — declará-lo como obrigatório no `contactSchema` faria o
 * contrato mentir sobre aqueles dois endpoints. Daí o schema derivado.
 */
describe('contactListItemSchema — campanhas recebidas', () => {
  const base = {
    id: 'c1',
    phoneE164: '+5592991110001',
    name: null,
    city: null,
    group: null,
    tags: [],
    customFields: null,
    optedOut: false,
    // Datas em ISO string pelo mesmo motivo do fixture acima.
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    whatsappValid: null,
    whatsappCheckedAt: null,
    profilePictureUrl: null,
    waLabels: [],
    marketingUndeliverableAt: null,
    marketingUndeliverableCode: null,
    marketingUndeliverableReason: null,
    lastFailureReason: null,
    lastFailureCode: null,
    lastFailureAt: null,
    failureCount: 0,
    // B.6, review (achado 1) — a validade JÁ CLASSIFICADA no servidor.
    validity: 'unvalidated' as const,
  };

  it('declara campaignsReceived como { count, names }', () => {
    const parsed = contactListItemSchema.parse({
      ...base,
      campaignsReceived: { count: 2, names: ['Boas-vindas', 'Convite'] },
    });
    expect(parsed.campaignsReceived).toEqual({
      count: 2,
      names: ['Boas-vindas', 'Convite'],
    });
  });

  it('aceita o caso comum: não recebeu campanha nenhuma', () => {
    const parsed = contactListItemSchema.parse({
      ...base,
      campaignsReceived: { count: 0, names: [] },
    });
    expect(parsed.campaignsReceived.count).toBe(0);
    expect(parsed.campaignsReceived.names).toEqual([]);
  });

  it('exige campaignsReceived (a lista SEMPRE agrega — ausente é bug do backend)', () => {
    const result = contactListItemSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('o contactSchema cru NÃO exige campaignsReceived (create/update não agregam)', () => {
    const result = contactSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});

describe('listContactsQuerySchema — validity (B.3)', () => {
  it('aceita os três valores', () => {
    for (const v of ['valid', 'invalid', 'unvalidated']) {
      expect(listContactsQuerySchema.parse({ validity: v }).validity).toBe(v);
    }
  });

  // O <select> manda `all` quando o operador escolhe "Todos"; string vazia é o
  // que um link antigo/limpo entrega. Nenhum dos dois pode virar 400.
  it('`all` e string vazia significam AUSÊNCIA de filtro', () => {
    expect(listContactsQuerySchema.parse({ validity: 'all' }).validity).toBeUndefined();
    expect(listContactsQuerySchema.parse({ validity: '' }).validity).toBeUndefined();
  });

  it('chave ausente não lança (a armadilha do optional em zod 4.4)', () => {
    expect(listContactsQuerySchema.parse({}).validity).toBeUndefined();
  });

  it('valor inventado é recusado', () => {
    expect(listContactsQuerySchema.safeParse({ validity: 'talvez' }).success).toBe(
      false,
    );
  });
});

describe('bulkDeleteContactsSchema — validity (B.3)', () => {
  it('aceita { validity: "invalid" } sem ids nem all', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({ validity: 'invalid' }).success,
    ).toBe(true);
  });

  // Apagar "válidos" ou "não validados" em massa não é uma ação de produto —
  // é um jeito de perder a base inteira por um clique. Só `invalid` existe.
  it('recusa outras classes de validade', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({ validity: 'unvalidated' }).success,
    ).toBe(false);
    expect(
      bulkDeleteContactsSchema.safeParse({ validity: 'valid' }).success,
    ).toBe(false);
  });

  it('corpo vazio continua sendo recusado', () => {
    expect(bulkDeleteContactsSchema.safeParse({}).success).toBe(false);
  });
});

describe('bulkDeleteContactsSchema — expectedCount (Round 2)', () => {
  it('aceita { validity: "invalid", expectedCount: 120 }', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({
        validity: 'invalid',
        expectedCount: 120,
      }).success,
    ).toBe(true);
  });

  // expectedCount só faz sentido junto de `validity`: é a contagem viva do
  // MESMO predicado que o serviço confere antes de apagar. Nos caminhos
  // `ids`/`all` não existe "contagem viva do filtro" para comparar — aceitar
  // o campo ali seria uma confirmação que o servidor lê e ignora em silêncio.
  it('recusa expectedCount sem validity (all=true)', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({ all: true, expectedCount: 5 })
        .success,
    ).toBe(false);
  });

  it('recusa expectedCount sem validity (ids)', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({ ids: ['a'], expectedCount: 5 })
        .success,
    ).toBe(false);
  });

  it('recusa expectedCount negativo', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({
        validity: 'invalid',
        expectedCount: -1,
      }).success,
    ).toBe(false);
  });

  it('recusa expectedCount não inteiro', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({
        validity: 'invalid',
        expectedCount: 1.5,
      }).success,
    ).toBe(false);
  });

  it('recusa expectedCount como string', () => {
    expect(
      bulkDeleteContactsSchema.safeParse({
        validity: 'invalid',
        expectedCount: '120',
      }).success,
    ).toBe(false);
  });
});
