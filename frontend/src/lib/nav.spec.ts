import { describe, it, expect } from 'vitest';
import { NAV, canAccessPath, navItemsForRole, navLabelFor, navSection } from './nav';

// Every authenticated top-level route that the app exposes. The manifest is the
// single source of truth for sidebar / topbar / command-palette, so it must
// cover all of these — otherwise the topbar breadcrumb falls back to "—".
const KNOWN_ROUTES = [
  '/dashboard',
  '/caixa-de-entrada',
  '/nova-comunicacao',
  '/whatsapp-equipe',
  '/escala',
  '/demandas',
  '/comunicados',
  '/setores',
  '/turnos',
  '/niveis',
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

  it('organiza exatamente os oito módulos internos nos três grupos do painel', () => {
    expect(navSection('ops', 'ADMIN').map((item) => item.label)).toEqual([
      'Visão geral', 'Caixa de entrada', 'Nova comunicação', 'WhatsApp da equipe', 'Escala',
    ]);
    expect(navSection('sys', 'ADMIN').map((item) => item.label)).toEqual([
      'Demandas', 'Comunicados',
    ]);
    expect(navSection('admin', 'ADMIN').map((item) => item.label)).toEqual([
      'Setores', 'Turnos', 'Níveis', 'Usuários', 'Números e canais',
    ]);
  });

  it('aplica o acesso da navegação por papel sem expor módulos legados a SUPERVISOR ou VIEWER', () => {
    expect(navItemsForRole('ADMIN').map((item) => item.to)).toContain('/connect');
    expect(navItemsForRole('OPERATOR').map((item) => item.to)).toContain('/campaigns');
    expect(navItemsForRole('SUPERVISOR').map((item) => item.to)).not.toContain('/campaigns');
    expect(navItemsForRole('VIEWER').map((item) => item.to)).not.toContain('/nova-comunicacao');
    expect(navSection('admin', 'SUPERVISOR').map((item) => item.label)).toEqual(['Setores']);
    expect(navSection('admin', 'VIEWER')).toEqual([]);
  });

  it('marks Usuários as ADMIN-only', () => {
    const users = NAV.find((n) => n.to === '/users');
    expect(users?.roles).toEqual(['ADMIN']);
  });

  it('does not gate the shared internal overview', () => {
    const dashboard = NAV.find((n) => n.to === '/dashboard');
    expect(dashboard?.roles).toContain('VIEWER');
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
      navSection(s, 'ADMIN').map((n) => n.to),
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
    expect(navLabelFor('/demandas/dm-123')).toBe(navLabelFor('/demandas'));
    expect(navLabelFor('/comunicados/cm-1')).toBe(navLabelFor('/comunicados'));
    expect(navLabelFor('/caixa-de-entrada/item-1')).toBe(navLabelFor('/caixa-de-entrada'));
  });

  it('returns the fallback for an unknown route', () => {
    expect(navLabelFor('/totally-unknown')).toBe('—');
  });
});

describe('canAccessPath', () => {
  it.each([
    ['/contacts', 'VIEWER', false],
    ['/dashboard', 'VIEWER', true],
    ['/contacts', 'ADMIN', true],
    ['/setores', 'ADMIN', true],
    ['/setores', 'OPERATOR', true],
    ['/setores', 'VIEWER', false],
    ['/setores/abc', 'ADMIN', true],
    ['/rota-inexistente', 'ADMIN', false],
  ] as const)('%s para %s → %s', (path, role, expected) => {
    expect(canAccessPath(path, role)).toBe(expected);
  });

  it('sem papel nunca acessa', () => {
    expect(canAccessPath('/dashboard', undefined)).toBe(false);
  });
});

describe('NAV WhatsApp da equipe', () => {
  it('mostra WhatsApp da equipe para ADMIN, SUPERVISOR e OPERATOR, não para VIEWER', () => {
    expect(navSection('ops', 'SUPERVISOR').map((item) => item.to)).toContain('/whatsapp-equipe');
    expect(navSection('ops', 'VIEWER').map((item) => item.to)).not.toContain('/whatsapp-equipe');
    expect(canAccessPath('/whatsapp-equipe', 'OPERATOR')).toBe(true);
    expect(canAccessPath('/whatsapp-equipe', 'VIEWER')).toBe(false);
    expect(navLabelFor('/whatsapp-equipe')).toBe('WhatsApp da equipe');
  });
});

describe('NAV Turnos', () => {
  it('Turnos só para ADMIN, na seção admin logo após Setores', () => {
    const admin = navSection('admin', 'ADMIN').map((item) => item.label);
    expect(admin.indexOf('Turnos')).toBe(admin.indexOf('Setores') + 1);
    expect(NAV.find((n) => n.to === '/turnos')?.roles).toEqual(['ADMIN']);
    expect(navSection('admin', 'SUPERVISOR').map((item) => item.label)).toEqual(['Setores']);
    expect(canAccessPath('/turnos', 'OPERATOR')).toBe(false);
    expect(navLabelFor('/turnos')).toBe('Turnos');
  });
});

describe('NAV Níveis', () => {
  it('Níveis só para ADMIN, na seção admin logo após Turnos', () => {
    const admin = navSection('admin', 'ADMIN').map((item) => item.label);
    expect(admin.indexOf('Níveis')).toBe(admin.indexOf('Turnos') + 1);
    expect(NAV.find((n) => n.to === '/niveis')?.roles).toEqual(['ADMIN']);
    expect(canAccessPath('/niveis', 'SUPERVISOR')).toBe(false);
    expect(navLabelFor('/niveis')).toBe('Níveis');
  });
});

describe('NAV Escala', () => {
  it('Escala na seção ops logo após WhatsApp da equipe, para quem escreve no painel', () => {
    const ops = navSection('ops', 'ADMIN').map((item) => item.label);
    expect(ops.indexOf('Escala')).toBe(ops.indexOf('WhatsApp da equipe') + 1);
    expect(NAV.find((n) => n.to === '/escala')?.roles).toEqual(['ADMIN', 'SUPERVISOR', 'OPERATOR']);
    expect(navSection('ops', 'VIEWER').map((item) => item.label)).not.toContain('Escala');
    expect(navLabelFor('/escala')).toBe('Escala');
  });
});

describe('NAV Setores', () => {
  it('/setores para ADMIN, SUPERVISOR e OPERATOR, não para VIEWER', () => {
    expect(NAV.find((n) => n.to === '/setores')?.roles).toEqual(['ADMIN', 'SUPERVISOR', 'OPERATOR']);
    for (const role of ['ADMIN', 'SUPERVISOR', 'OPERATOR'] as const) expect(canAccessPath('/setores', role)).toBe(true);
    expect(canAccessPath('/setores', 'VIEWER')).toBe(false);
  });
});
