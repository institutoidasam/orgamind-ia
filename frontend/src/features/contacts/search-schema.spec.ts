import { describe, it, expect } from 'vitest';
import { contactsSearchSchema } from './search-schema';

describe('contactsSearchSchema', () => {
  it('aceita search numérico — o router entrega ?search=995550101 como número', () => {
    // Sem o coerce isto lançava, e o validateSearch derrubava a página inteira
    // ("Something went wrong") ao buscar um contato por telefone.
    expect(contactsSearchSchema.parse({ search: 995550101 })).toEqual({
      page: 1,
      pageSize: 50,
      search: '995550101',
    });
  });

  it('preserva search textual', () => {
    expect(contactsSearchSchema.parse({ search: 'ana' }).search).toBe('ana');
  });

  it('search ausente continua ausente — não vira a string "undefined"', () => {
    expect(contactsSearchSchema.parse({})).toEqual({ page: 1, pageSize: 50 });
  });

  it('aplica os defaults de paginação', () => {
    const out = contactsSearchSchema.parse({ page: '3', pageSize: '25' });
    expect(out).toEqual({ page: 3, pageSize: 25 });
  });

  /**
   * F2 T9 — o filtro por motivo de falha precisa ser LINKÁVEL por URL, no
   * mesmo molde de `search`. Enum fechado (espelha `FAILURE_REASONS`): um
   * valor fora da lista não identifica motivo real nenhum.
   */
  it('aceita failureReason como um dos 11 valores do enum', () => {
    expect(
      contactsSearchSchema.parse({ failureReason: 'TELEFONE_INVALIDO' })
        .failureReason,
    ).toBe('TELEFONE_INVALIDO');
  });

  it('rejeita failureReason fora do enum', () => {
    expect(() =>
      contactsSearchSchema.parse({ failureReason: 'bogus' }),
    ).toThrow();
  });

  it('failureReason ausente continua ausente', () => {
    expect(contactsSearchSchema.parse({}).failureReason).toBeUndefined();
  });

  /**
   * F3 T2 — "recebeu a campanha X" também mora na URL. Não é só para poder
   * compartilhar o link: é este param que o `useContactSearchSync` reinjeta
   * quando o operador digita na busca — se ele não existisse no schema, o
   * router o descartaria e digitar apagaria o filtro. Espelha
   * `listContactsQuerySchema.receivedCampaignId` do back
   * (`backend/src/schemas/contracts/contact.schema.ts`).
   */
  it('aceita receivedCampaignId (o cuid da campanha)', () => {
    expect(
      contactsSearchSchema.parse({ receivedCampaignId: 'cmp_abc123' })
        .receivedCampaignId,
    ).toBe('cmp_abc123');
  });

  it('receivedCampaignId ausente continua ausente', () => {
    expect(contactsSearchSchema.parse({}).receivedCampaignId).toBeUndefined();
  });

  // Mesmo idioma do back: `?receivedCampaignId=` (o <select> em "Todas as
  // campanhas") é AUSÊNCIA de filtro, não um id vazio que não casa com nada.
  it('trata receivedCampaignId vazio como "sem filtro"', () => {
    expect(
      contactsSearchSchema.parse({ receivedCampaignId: '' }).receivedCampaignId,
    ).toBeUndefined();
  });

  /**
   * B.3 fix round 1 — `validity` é um enum FECHADO (ao contrário de
   * `receivedCampaignId`, que aceita qualquer string), então sem preprocess
   * `?validity=all` ou `?validity=` colado/salvo lançava dentro de
   * `contactsSearchSchema.parse` — e como este schema é o `validateSearch` da
   * rota, isso derrubava a TELA INTEIRA para "Something went wrong" em vez de
   * simplesmente mostrar "Todos os números".
   */
  describe('validity — nunca lança, um link velho não pode quebrar a tela', () => {
    it('aceita validity como um dos três valores do enum', () => {
      expect(
        contactsSearchSchema.parse({ validity: 'invalid' }).validity,
      ).toBe('invalid');
    });

    it('validity ausente continua ausente', () => {
      expect(contactsSearchSchema.parse({}).validity).toBeUndefined();
    });

    // O <select> do Radix não aceita value="" e usa "all" como opção neutra
    // — um link colado com `?validity=all` tem de significar "todos", nunca
    // derrubar a rota.
    it('trata validity="all" como "sem filtro" (não lança)', () => {
      expect(
        contactsSearchSchema.parse({ validity: 'all' }).validity,
      ).toBeUndefined();
    });

    it('trata validity vazio como "sem filtro" (não lança)', () => {
      expect(
        contactsSearchSchema.parse({ validity: '' }).validity,
      ).toBeUndefined();
    });

    // Ao contrário de `failureReason` (enum fechado que LANÇA para valor
    // desconhecido — ver "rejeita failureReason fora do enum" acima),
    // `validity` precisa se comportar como `receivedCampaignId`: um valor
    // que não identifica nenhuma das três classes vira "sem filtro", nunca
    // um crash. Cobre um link salvo apontando para uma classe removida no
    // futuro, não só os dois sentinelas conhecidos hoje ('' e 'all').
    it('trata validity desconhecido como "sem filtro" (não lança)', () => {
      expect(() =>
        contactsSearchSchema.parse({ validity: 'bogus' }),
      ).not.toThrow();
      expect(
        contactsSearchSchema.parse({ validity: 'bogus' }).validity,
      ).toBeUndefined();
    });
  });
});
