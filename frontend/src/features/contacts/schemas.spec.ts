import { describe, it, expect, expectTypeOf } from 'vitest';
import * as schemas from './schemas';
import {
  createContactSchema,
  listContactsQuerySchema,
  type Contact,
} from './schemas';

describe('contacts schemas', () => {
  // The API response is never parsed at the boundary (api.ts casts via
  // `.json<Contact>()`), so the previous `z.coerce.date()`-derived `Contact`
  // type claimed `createdAt: Date` while runtime hands back an ISO string.
  // Decision: downgrade `Contact` to a pure (honest) type and drop the
  // never-parsed runtime `contactSchema` that gave false safety.
  it('no longer exports a never-parsed runtime contactSchema', () => {
    expect('contactSchema' in schemas).toBe(false);
  });

  it('Contact treats serialized date fields as string | Date (no runtime lie)', () => {
    expectTypeOf<Contact['createdAt']>().toEqualTypeOf<string | Date>();
    expectTypeOf<Contact['updatedAt']>().toEqualTypeOf<string | Date>();
    expectTypeOf<Contact['whatsappCheckedAt']>().toEqualTypeOf<
      string | Date | null
    >();
  });

  it('accepts an API-shaped contact (ISO string dates) as a Contact', () => {
    const c: Contact = {
      id: 'c1',
      phoneE164: '+5592999',
      name: null,
      city: null,
      group: null,
      tags: [],
      customFields: null,
      optedOut: false,
      whatsappValid: null,
      whatsappCheckedAt: null,
      profilePictureUrl: null,
      waLabels: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      marketingUndeliverableAt: null,
      marketingUndeliverableCode: null,
      marketingUndeliverableReason: null,
      lastFailureReason: null,
      lastFailureCode: null,
      lastFailureAt: null,
      failureCount: 0,
    };
    expect(c.id).toBe('c1');
  });

  // The runtime form/query schemas that ARE parsed must keep working.
  it('still validates the create-contact form input at runtime', () => {
    const parsed = createContactSchema.parse({ phone: '5592999999999' });
    expect(parsed.phone).toBe('5592999999999');
    expect(() => createContactSchema.parse({ phone: '12' })).toThrow();
  });

  it('still parses the list query with defaults', () => {
    const q = listContactsQuerySchema.parse({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(50);
  });

  /**
   * F3 T2 — espelha a decisão de contrato do back
   * (`contactListItemSchema` em `backend/src/schemas/contracts/contact.schema.ts`):
   * só a LISTAGEM agrega campanhas recebidas. `create`/`update` devolvem a row
   * crua do Prisma e não têm o campo, então ele mora num tipo derivado em vez
   * de virar mais uma chave (mentirosa) do `Contact`.
   */
  it('ContactListItem = Contact + campaignsReceived, sempre presente na lista', () => {
    const item: schemas.ContactListItem = {
      id: 'c1',
      phoneE164: '+5592999',
      name: null,
      city: null,
      group: null,
      tags: [],
      customFields: null,
      optedOut: false,
      whatsappValid: null,
      whatsappCheckedAt: null,
      profilePictureUrl: null,
      waLabels: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      marketingUndeliverableAt: null,
      marketingUndeliverableCode: null,
      marketingUndeliverableReason: null,
      lastFailureReason: null,
      lastFailureCode: null,
      lastFailureAt: null,
      failureCount: 0,
      // Quem não recebeu nada vem `{count:0,names:[]}`, NUNCA ausente — por
      // isso a célula não precisa de guard de `undefined`.
      campaignsReceived: { count: 0, names: [] },
    };
    expect(item.campaignsReceived).toEqual({ count: 0, names: [] });
    expectTypeOf<
      schemas.ContactListItem['campaignsReceived']
    >().toEqualTypeOf<schemas.CampaignsReceived>();
  });

  it('a resposta da lista é ContactListItem[] (a agregação chega na tela)', () => {
    expectTypeOf<schemas.ContactsListResponse['items']>().toEqualTypeOf<
      schemas.ContactListItem[]
    >();
  });

  it('a query de listagem aceita receivedCampaignId', () => {
    expect(
      listContactsQuerySchema.parse({ receivedCampaignId: 'cmp_abc123' })
        .receivedCampaignId,
    ).toBe('cmp_abc123');
  });
});
