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

export type NavRole = 'ADMIN';

export type NavItem = {
  /** Route path, e.g. `/contacts`. Also the breadcrumb match key. */
  to: string;
  /** Human label shown in sidebar / topbar / palette. */
  label: string;
  icon: LucideIcon;
  /** Which sidebar group this belongs to. */
  section: NavSection;
  /** When set, only users with this role see the entry. */
  role?: NavRole;
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
  { to: '/dashboard', label: 'Início', icon: Home, section: 'ops' },
  { to: '/inbox', label: 'Inbox', icon: MessageSquare, section: 'ops' },
  { to: '/contacts', label: 'Contatos', icon: Users, section: 'ops' },
  { to: '/templates', label: 'Templates', icon: FileText, section: 'ops' },
  { to: '/segments', label: 'Segmentos', icon: Filter, section: 'ops' },
  // ZD → fusão (13/07): /disparos mostrava os mesmos números das mesmas
  // campanhas e morreu (a rota é só um redirect para cá). O que só existia
  // lá — os disparos feitos PELO PAINEL do Zernio, que não são campanhas do
  // orgamind — chegou a viver numa seção à parte desta página, mas essa seção
  // também foi removida a pedido do cliente (25/08, 5bf2d11): a tela de
  // campanhas hoje só mostra campanha do orgamind.
  { to: '/campaigns', label: 'Campanhas', icon: Send, section: 'ops' },
  {
    to: '/imports',
    label: 'Imports',
    icon: FileSpreadsheet,
    section: 'ops',
    hideInSidebar: true,
  },
  // C5 — o painel que troca a métrica de sucesso: "quantos podem receber campanha
  // hoje", e não "quantas mensagens saíram". Fica em `ops` porque é a tela que o
  // operador tem de olhar ANTES de montar uma campanha. Mora em `/consentimento`
  // porque `/opt-in` é a landing PÚBLICA (sem login) — ver consentimento.tsx.
  { to: '/consentimento', label: 'Opt-in', icon: ShieldCheck, section: 'ops' },
  { to: '/connect', label: 'Canais', icon: Wifi, section: 'sys' },
  // C3 — gerar um ponto de coleta é decidir de onde virá consentimento, com que
  // finalidade e sob que texto; e o token acaba impresso num cartaz que ninguém
  // recolhe. Por isso vive em `admin`, ao lado de Usuários.
  {
    to: '/opt-in-links',
    label: 'Links & QR de opt-in',
    icon: QrCode,
    section: 'admin',
    role: 'ADMIN',
  },
  { to: '/users', label: 'Usuários', icon: UserCog, section: 'admin', role: 'ADMIN' },
  // A identidade da organização é o nome que aparece no consentimento de todos
  // os titulares. Editá-la é da mesma gravidade de escrever o texto de
  // consentimento — por isso ADMIN, ao lado de Usuários.
  {
    to: '/configuracoes',
    label: 'Configurações',
    icon: Settings,
    section: 'admin',
    role: 'ADMIN',
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
export function navSection(section: NavSection): NavItem[] {
  return NAV.filter(
    (n) =>
      n.section === section && !n.hideInSidebar && !HIDDEN_FROM_SIDEBAR.includes(n.to),
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
