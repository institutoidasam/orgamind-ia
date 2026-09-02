import { describe, it, expect } from 'vitest';
import {
  FALLBACK_ORG_NAME,
  organizationFromEnv,
} from './organization-identity';

/**
 * A identidade da organização é CONFIGURAÇÃO, não constante de código. Este é o
 * ponto onde o env vira identidade — e o único lugar com um fallback.
 */
describe('organizationFromEnv', () => {
  it('lê nome e razão social do env', () => {
    const org = organizationFromEnv({
      ORG_NAME: 'CONTINUUM',
      ORG_LEGAL_NAME: 'Canal do Matheus Garcia - CONTINUUM',
      ORG_PRIVACY_POLICY_URL: 'https://continuum.exemplo.br/privacidade',
      ORG_SUPPORT_CONTACT: 'suporte@continuum.exemplo.br',
    });

    expect(org).toEqual({
      name: 'CONTINUUM',
      legalName: 'Canal do Matheus Garcia - CONTINUUM',
      privacyPolicyUrl: 'https://continuum.exemplo.br/privacidade',
      supportContact: 'suporte@continuum.exemplo.br',
    });
  });

  it('sem ORG_LEGAL_NAME, a razão social cai no nome curto (nunca vazia)', () => {
    const org = organizationFromEnv({ ORG_NAME: 'CONTINUUM' });

    expect(org.name).toBe('CONTINUUM');
    expect(org.legalName).toBe('CONTINUUM');
  });

  it('sem env nenhum, usa um fallback NEUTRO — nunca o nome de outra organização', () => {
    const org = organizationFromEnv({});

    expect(org.name).toBe(FALLBACK_ORG_NAME);
    expect(org.legalName).toBe(FALLBACK_ORG_NAME);
    expect(org.privacyPolicyUrl).toBeNull();
    expect(org.supportContact).toBeNull();
    // O bug que esta feature corrige: um deploy sem config NÃO pode herdar o
    // nome do primeiro cliente do sistema.
    expect(JSON.stringify(org)).not.toMatch(/idasam/i);
  });

  it('o compose repassa `${VAR:-}` como string vazia — vazio é AUSENTE', () => {
    const org = organizationFromEnv({
      ORG_NAME: '  ',
      ORG_LEGAL_NAME: '',
      ORG_PRIVACY_POLICY_URL: '',
      ORG_SUPPORT_CONTACT: '   ',
    });

    expect(org.name).toBe(FALLBACK_ORG_NAME);
    expect(org.privacyPolicyUrl).toBeNull();
    expect(org.supportContact).toBeNull();
  });

  it('apara espaços nas bordas', () => {
    const org = organizationFromEnv({
      ORG_NAME: ' CONTINUUM ',
      ORG_LEGAL_NAME: ' Canal do Matheus Garcia - CONTINUUM ',
    });

    expect(org.name).toBe('CONTINUUM');
    expect(org.legalName).toBe('Canal do Matheus Garcia - CONTINUUM');
  });
});
