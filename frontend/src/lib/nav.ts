import {
  Home,
  MessageSquare,
  Users,
  FileText,
  Filter,
  Send,
  FileSpreadsheet,
  Wifi,
  UserCog,
  QrCode,
  ShieldCheck,
  Settings,
  type LucideIcon,
} from 'lucide-react';

/**
 * Single source of truth for the app's authenticated navigation.
 *
 * The sidebar, the topbar breadcrumb, and the command palette all derive their
 * entries from this manifest. Adding a route here makes it resolve a label in
 * the topbar (no more "—"), show up in the command palette, and — unless
 * `hideInSidebar` is set — appear in the sidebar under its `section`.
 */

/** Sidebar grouping. Order here is the order sections render in the sidebar. */
export type NavSection = 'ops' | 'sys' | 'admin';

export type NavRole = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER';

const ALL_INTERNAL_ROLES: readonly NavRole[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];
const WRITE_INTERNAL_ROLES: readonly NavRole[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];
const LEGACY_ROLES: readonly NavRole[] = ['ADMIN', 'OPERATOR'];

export type NavItem = {
  /** Route path, e.g. `/contacts`. Also the breadcrumb match key. */
  to: string;
  /** Human label shown in sidebar / topbar / palette. */
  label: string;
  icon: LucideIcon;
  /** Which sidebar group this belongs to. */
  section: NavSection;
  /** Papéis que podem usar o item; ausência mantém a rota só para breadcrumb. */
  roles?: readonly NavRole[];
  /**
   * Route exists and must resolve a breadcrumb label, but is intentionally not
   * listed in the sidebar (reachable from elsewhere). Still shown in the palette.
   */
  hideInSidebar?: boolean;
};

/**
 * Telas TIRADAS DO MENU, mas NÃO removidas do produto.
 *
 * ── COMO RELIGAR ────────────────────────────────────────────────────────────
 * Esvazie esta lista (`const HIDDEN_FROM_SIDEBAR: string[] = [];`). É só isso.
 * Cada entrada volta ao sidebar na `section` que já declara em NAV, abaixo.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * O operador pediu que o opt-in sumisse da barra lateral. Ele NÃO pediu — e isto
 * NÃO faz — o desligamento do consentimento. Continuam de pé:
 *   • as ROTAS, acessíveis por URL (/consentimento, /opt-in-links);
 *   • o GATE de consentimento do disparo (send-message.processor), 100% ligado;
 *   • os ConsentEvent já colhidos, intactos.
 *
 * Por que a rota NÃO pode ser apagada junto: no dia em que importarem uma
 * planilha nova, os contatos entram com consentimento ZERO — o gate pula todos e
 * nenhuma campanha sai. A tela de "Consentimento da base existente"
 * (/consentimento) é a ÚNICA forma de resolver isso pelo produto. Apagar a rota
 * transformaria um problema de 5 minutos numa migração manual no banco.
 */
const HIDDEN_FROM_SIDEBAR: string[] = ['/consentimento', '/opt-in-links'];

export const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Visão geral', icon: Home, section: 'ops', roles: ALL_INTERNAL_ROLES },
  { to: '/caixa-de-entrada', label: 'Caixa de entrada', icon: MessageSquare, section: 'ops', roles: ALL_INTERNAL_ROLES },
  { to: '/nova-comunicacao', label: 'Nova comunicação', icon: Send, section: 'ops', roles: WRITE_INTERNAL_ROLES },
  { to: '/demandas', label: 'Demandas', icon: FileText, section: 'sys', roles: ALL_INTERNAL_ROLES },
  { to: '/comunicados', label: 'Comunicados', icon: MessageSquare, section: 'sys', roles: ALL_INTERNAL_ROLES },
  { to: '/setores', label: 'Setores', icon: Users, section: 'admin', roles: ['ADMIN'] },
  { to: '/users', label: 'Usuários', icon: UserCog, section: 'admin', roles: ['ADMIN'] },
  { to: '/connect', label: 'Números e canais', icon: Wifi, section: 'admin', roles: ['ADMIN'] },

  // Telas legadas preservam URLs e breadcrumbs, mas não fazem parte do painel
  // interno. O backend legado só aceita ADMIN/OPERATOR; SUPERVISOR/VIEWER não
  // as veem na paleta para não receberem atalhos que terminariam em 403.
  { to: '/inbox', label: 'Inbox externo', icon: MessageSquare, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  { to: '/contacts', label: 'Contatos', icon: Users, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  { to: '/templates', label: 'Templates', icon: FileText, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  { to: '/segments', label: 'Segmentos', icon: Filter, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  { to: '/campaigns', label: 'Campanhas', icon: Send, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  {
    to: '/imports',
    label: 'Imports',
    icon: FileSpreadsheet,
    section: 'ops',
    roles: LEGACY_ROLES,
    hideInSidebar: true,
  },
  // C5 — o painel que troca a métrica de sucesso: "quantos podem receber campanha
  // hoje", e não "quantas mensagens saíram". Fica em `ops` porque é a tela que o
  // operador tem de olhar ANTES de montar uma campanha. Mora em `/consentimento`
  // porque `/opt-in` é a landing PÚBLICA (sem login) — ver consentimento.tsx.
  { to: '/consentimento', label: 'Opt-in', icon: ShieldCheck, section: 'ops', roles: LEGACY_ROLES, hideInSidebar: true },
  // C3 — gerar um ponto de coleta é decidir de onde virá consentimento, com que
  // finalidade e sob que texto; e o token acaba impresso num cartaz que ninguém
  // recolhe. Por isso vive em `admin`, ao lado de Usuários.
  {
    to: '/opt-in-links',
    label: 'Links & QR de opt-in',
    icon: QrCode,
    section: 'admin',
    roles: ['ADMIN'],
    hideInSidebar: true,
  },
  // A identidade da organização é o nome que aparece no consentimento de todos
  // os titulares. Editá-la é da mesma gravidade de escrever o texto de
  // consentimento — por isso ADMIN, ao lado de Usuários.
  {
    to: '/configuracoes',
    label: 'Configurações',
    icon: Settings,
    section: 'admin',
    roles: ['ADMIN'],
    hideInSidebar: true,
  },
];

/**
 * Items rendered in the sidebar for a given section, respecting `hideInSidebar`
 * and `HIDDEN_FROM_SIDEBAR`.
 *
 * Só o SIDEBAR filtra. `NAV`, `navLabelFor` e a paleta de comandos continuam
 * enxergando as entradas escondidas — é o que mantém a rota alcançável e o
 * breadcrumb resolvendo.
 */
export function navItemsForRole(role?: NavRole): NavItem[] {
  if (!role) return [];
  return NAV.filter((item) => item.roles?.includes(role));
}

export function canUseLegacyModules(role?: NavRole): boolean {
  return role === 'ADMIN' || role === 'OPERATOR';
}

export function navSection(section: NavSection, role?: NavRole): NavItem[] {
  return NAV.filter(
    (n) =>
      n.section === section
      && !n.hideInSidebar
      && !HIDDEN_FROM_SIDEBAR.includes(n.to)
      && Boolean(role && n.roles?.includes(role)),
  );
}

/** True when `path` is on (or under) `to`. `/` only matches exactly. */
export function isNavActive(path: string, to: string): boolean {
  if (to === '/') return path === '/';
  return path === to || path.startsWith(`${to}/`);
}

/**
 * Breadcrumb label for a path. Falls back to "—" when nothing matches.
 * A campaign detail page (`/campaigns/:id`) reads as "Campanha" (singular).
 */
export function navLabelFor(path: string): string {
  if (path.startsWith('/campaigns/')) return 'Campanha';
  // Longest `to` first so `/campaigns` beats `/` on nested paths.
  const match = [...NAV]
    .sort((a, b) => b.to.length - a.to.length)
    .find((n) => isNavActive(path, n.to));
  return match?.label ?? '—';
}
