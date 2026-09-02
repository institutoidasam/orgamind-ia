import { describe, it, expect } from 'vitest';
import { updateOrganizationSchema } from './organization.schema';

describe('updateOrganizationSchema — PATCH /organization', () => {
  it('aceita um patch parcial', () => {
    const parsed = updateOrganizationSchema.parse({ name: 'CONTINUUM' });
    expect(parsed).toEqual({ name: 'CONTINUUM' });
  });

  it('apara espaços', () => {
    const parsed = updateOrganizationSchema.parse({
      name: '  CONTINUUM  ',
      legalName: ' Canal do Matheus Garcia - CONTINUUM ',
    });
    expect(parsed.name).toBe('CONTINUUM');
    expect(parsed.legalName).toBe('Canal do Matheus Garcia - CONTINUUM');
  });

  it('recusa nome vazio — um consentimento sem organização nomeada é inválido', () => {
    expect(() => updateOrganizationSchema.parse({ name: '   ' })).toThrow();
    expect(() => updateOrganizationSchema.parse({ legalName: '' })).toThrow();
  });

  it('recusa uma política de privacidade que não é URL', () => {
    expect(() =>
      updateOrganizationSchema.parse({ privacyPolicyUrl: 'privacidade' }),
    ).toThrow();
  });

  it('aceita limpar a política de privacidade e o contato (string vazia = ausente)', () => {
    const parsed = updateOrganizationSchema.parse({
      privacyPolicyUrl: '',
      supportContact: '',
    });
    expect(parsed.privacyPolicyUrl).toBeNull();
    expect(parsed.supportContact).toBeNull();
  });

  it('ignora campos que não são identidade (o id do singleton não se troca)', () => {
    const parsed = updateOrganizationSchema.parse({
      name: 'CONTINUUM',
      id: 'outro',
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('id');
  });
});
