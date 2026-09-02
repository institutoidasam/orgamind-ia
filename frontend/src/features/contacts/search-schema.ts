import { z } from 'zod';
import { FAILURE_REASONS } from '@/features/campaigns/schemas';
import { CONTACT_VALIDITIES } from '@/features/contacts/validity';

/**
 * Query params da lista de contatos.
 *
 * `search` é `coerce` de propósito. O parser de query do router entrega
 * `?search=995550101` já como **número** (ele desserializa JSON), e um
 * `z.string()` puro rejeitaria: o `validateSearch` lança e a página inteira
 * cai no "Something went wrong" em vez de simplesmente buscar. Aqui buscar
 * por telefone é o caso mais comum — o valor numérico é a regra, não a
 * exceção.
 */
export const contactsSearchSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.coerce.string().optional(),
  /**
   * F2 T9 — filtro por motivo da última falha (`Contact.lastFailureReason`),
   * linkável por URL para o filtro ser compartilhável. Enum fechado — espelha
   * `FAILURE_REASONS`/`listContactsQuerySchema.failureReason` do back
   * (`backend/src/schemas/contracts/contact.schema.ts`).
   */
  failureReason: z.enum(FAILURE_REASONS).optional(),
  /**
   * F3 — filtro "recebeu a campanha X", também linkável por URL. Além de
   * poder ser compartilhado, é daqui que `useContactSearchSync` relê o valor
   * para reinjetá-lo no debounce da busca; um param que não existisse no
   * schema seria descartado pelo router e digitar apagaria o filtro.
   *
   * O `preprocess('' -> undefined)` segue o idioma do back
   * (`listContactsQuerySchema.receivedCampaignId`): `?receivedCampaignId=`
   * — o <select> em "Todas as campanhas" — é AUSÊNCIA de filtro, não um id
   * vazio que não casa com nada. O `.optional()` externo é o mesmo detalhe
   * de zod já documentado lá: sem ele, a CHAVE AUSENTE lança.
   */
  receivedCampaignId: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional())
    .optional(),
  /**
   * B.3 — filtro "Validação", linkável por URL como os demais (fix round 1:
   * o enum fechado, sem preprocess, lançava em `?validity=all`/`?validity=`
   * colado/salvo — e como este schema é o `validateSearch` da rota, o lançar
   * derruba a tela INTEIRA para a "Something went wrong", não só o filtro).
   *
   * Mesmo idioma do `receivedCampaignId` acima (`'' -> undefined`), mas mais
   * tolerante: `receivedCampaignId` nunca lança para lixo porque seu tipo é
   * `z.string()` aberto (qualquer string cola); `validity` é um enum FECHADO
   * (espelha `CONTACT_VALIDITIES`/`listContactsQuerySchema.validity` do back,
   * `backend/src/schemas/contracts/contact.schema.ts`), então o preprocess
   * precisa neutralizar explicitamente qualquer valor que não seja um dos três
   * — não só `''` e `'all'` (a opção neutra do <select>) — para alcançar a
   * MESMA garantia de "nunca quebra a tela" que `receivedCampaignId` já tem
   * de graça. Um link velho apontando para uma classe removida deve virar
   * "Todos os números", não uma página em branco.
   */
  validity: z
    .preprocess(
      (v) =>
        typeof v === 'string' &&
        (CONTACT_VALIDITIES as readonly string[]).includes(v)
          ? v
          : undefined,
      z.enum(CONTACT_VALIDITIES).optional(),
    )
    .optional(),
});

export type ContactsSearch = z.infer<typeof contactsSearchSchema>;
