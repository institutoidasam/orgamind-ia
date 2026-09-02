import { describe, it, expect } from 'vitest';
import { NAV, navLabelFor, navSection } from './nav';

// Every authenticated top-level route that the app exposes. The manifest is the
// single source of truth for sidebar / topbar / command-palette, so it must
// cover all of these — otherwise the topbar breadcrumb falls back to "—".
const KNOWN_ROUTES = [
  '/dashboard',
  '/inbox',
  '/contacts',
  '/segments',
  '/campaigns',
  '/templates',
  '/imports',
  '/connect',
  '/users',
];

describe('NAV manifest', () => {
  it('covers every known authenticated route exactly once', () => {
    const tos = NAV.map((n) => n.to);
    for (const route of KNOWN_ROUTES) {
      expect(tos).toContain(route);
    }
    // no duplicate `to` entries
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('every entry has a non-empty label and an icon', () => {
    for (const n of NAV) {
      expect(n.label.length).toBeGreaterThan(0);
      expect(n.icon).toBeTruthy();
    }
  });

  it('marks Usuários as ADMIN-only', () => {
    const users = NAV.find((n) => n.to === '/users');
    expect(users?.role).toBe('ADMIN');
  });

  it('does not gate non-admin routes', () => {
    const dashboard = NAV.find((n) => n.to === '/dashboard');
    expect(dashboard?.role).toBeUndefined();
  });
});

describe('NAV', () => {
  it('does not expose the removed /bots screen', () => {
    expect(NAV.some((n) => n.to === '/bots')).toBe(false);
  });
});

/**
 * As telas de opt-in saíram do MENU a pedido do operador — mas continuam VIVAS.
 * Ver `HIDDEN_FROM_SIDEBAR` em `nav.ts` para religá-las.
 *
 * O par de asserções abaixo é o contrato inteiro: sumiu da barra lateral E
 * continuou existindo. A segunda metade é a que importa — no dia em que uma
 * planilha nova entrar, todo contato entra com consentimento ZERO, o gate pula
 * todo mundo, e `/consentimento` é a ÚNICA tela que resolve. Um "cleanup" que
 * apague a rota deixaria a base inalcançável.
 */
describe('telas de opt-in: fora do menu, vivas na rota', () => {
  const OPTIN_ROUTES = ['/consentimento', '/opt-in-links'];

  it('não aparecem na barra lateral (nenhuma seção)', () => {
    const inSidebar = (['ops', 'sys', 'admin'] as const).flatMap((s) =>
      navSection(s).map((n) => n.to),
    );
    for (const route of OPTIN_ROUTES) {
      expect(inSidebar).not.toContain(route);
    }
  });

  it('continuam no manifesto — a rota existe e o breadcrumb resolve', () => {
    for (const route of OPTIN_ROUTES) {
      expect(NAV.some((n) => n.to === route)).toBe(true);
      expect(navLabelFor(route)).not.toBe('—');
    }
  });
});

describe('navLabelFor', () => {
  it('resolves a label for every known route (no "—")', () => {
    for (const route of KNOWN_ROUTES) {
      const label = navLabelFor(route);
      expect(label).not.toBe('—');
      expect(label).toBeTruthy();
    }
  });

  it('resolves nested paths to their parent route label', () => {
    expect(navLabelFor('/contacts/123')).toBe(navLabelFor('/contacts'));
    expect(navLabelFor('/segments/abc')).toBe(navLabelFor('/segments'));
    expect(navLabelFor('/inbox/conv-1')).toBe(navLabelFor('/inbox'));
  });

  it('returns the fallback for an unknown route', () => {
    expect(navLabelFor('/totally-unknown')).toBe('—');
  });
});
