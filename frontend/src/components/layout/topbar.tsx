import { useRouterState, Link } from '@tanstack/react-router';
import { ChevronLeft, Menu, Moon, Search, Sun } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/lib/theme';
import { initials } from '@/lib/initials';
import { WORKSPACE_SHORT_NAME } from '@/lib/brand';
import { canUseLegacyModules, navLabelFor, type NavRole } from '@/lib/nav';
import { ROLE_LABEL } from '@/features/users/role';
import { ProviderScopeSelector } from '@/features/whatsapp/provider-scope';
import { WhatsappStatusIndicator } from './whatsapp-status-indicator';
import { ReleaseNotesButton } from './release-notes-button';

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onMobileOpen: () => void;
  onCmdOpen: () => void;
  onLogout: () => void;
  user?: {
    email: string;
    name: string | null;
    role: string;
    sector?: { id: string; name: string; code: string; isActive: boolean } | null;
  } | null;
};

export function Topbar({
  collapsed,
  onToggleCollapsed,
  onMobileOpen,
  onCmdOpen,
  onLogout,
  user,
}: Props) {
  const router = useRouterState();
  const path = router.location.pathname;
  const pageName = navLabelFor(path);
  const { theme, set } = useTheme();
  const showLegacyControls = canUseLegacyModules(user?.role as NavRole | undefined);

  return (
    <div
      className="no-print sticky top-0 z-10 flex min-h-[61px] items-center gap-2 px-3 py-3 sm:gap-3 sm:px-5 lg:px-8"
      style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <NavigationToggle
        collapsed={collapsed}
        onMobileOpen={onMobileOpen}
        onToggleCollapsed={onToggleCollapsed}
      />
      <Breadcrumb pageName={pageName} />

      {showLegacyControls && <WhatsappStatusIndicator />}
      {showLegacyControls && <ProviderScopeSelector />}

      <CommandSearch onCmdOpen={onCmdOpen} />

      <ReleaseNotesButton />

      {/* Theme toggle — hidden on mobile to save space (also reachable via avatar menu) */}
      <ThemeToggle theme={theme} set={set} />

      <ProfileMenu onLogout={onLogout} setTheme={set} theme={theme} user={user} />
    </div>
  );
}

function NavigationToggle({
  collapsed,
  onMobileOpen,
  onToggleCollapsed,
}: Pick<Props, 'collapsed' | 'onMobileOpen' | 'onToggleCollapsed'>) {
  return (
    <>
      <button type="button" onClick={onMobileOpen} aria-label="Abrir menu" className="grid size-9 place-items-center rounded-md hover:bg-[var(--surface-hover)] lg:hidden">
        <Menu className="size-5" />
      </button>
      <button type="button" onClick={onToggleCollapsed} aria-label="Alternar barra lateral" className="hidden size-7 place-items-center rounded-md hover:bg-[var(--surface-hover)] lg:grid">
        <ChevronLeft className="size-4 transition-transform" style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
      </button>
    </>
  );
}

function Breadcrumb({ pageName }: { pageName: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm" style={{ color: 'var(--foreground-muted)' }}>
      <span className="hidden font-semibold tracking-tight sm:inline" style={{ color: 'var(--foreground)' }}>{WORKSPACE_SHORT_NAME}</span>
      <span className="hidden sm:inline" style={{ color: 'var(--foreground-subtle)' }}>/</span>
      <span className="hidden font-medium lg:inline">Comunicação entre Setores</span>
      <span className="hidden lg:inline" style={{ color: 'var(--foreground-subtle)' }}>/</span>
      <strong className="truncate font-medium" style={{ color: 'var(--foreground)' }}>{pageName}</strong>
    </div>
  );
}

function CommandSearch({ onCmdOpen }: Pick<Props, 'onCmdOpen'>) {
  return (
    <button type="button" onClick={onCmdOpen} aria-label="Buscar ou executar" className="ml-auto inline-flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm md:px-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}>
      <Search className="size-3.5" />
      <span className="hidden md:inline">Buscar ou executar...</span>
      <kbd className="ml-2 hidden rounded px-1.5 py-0.5 font-mono text-[11px] md:inline" style={{ background: 'var(--canvas)', border: '1px solid var(--border)' }}>⌘K</kbd>
    </button>
  );
}

function ProfileMenu({
  onLogout,
  setTheme,
  theme,
  user,
}: Pick<Props, 'onLogout' | 'user'> & { setTheme: (theme: 'light' | 'dark') => void; theme: 'light' | 'dark' }) {
  const displayName = profileDisplayName(user);
  const profileRole = profileRoleName(user?.role);
  const profileLabel = `Menu do perfil: ${displayName || 'perfil'} (${profileRole})`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={profileLabel} className="grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white transition-opacity hover:opacity-80" style={{ background: 'var(--brand-navy)' }}>
          {initials(displayName)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <ProfileDetails profileRole={profileRole} user={user} />
        <DropdownMenuSeparator />
        <MobileThemeItem setTheme={setTheme} theme={theme} />
        <DropdownMenuItem asChild><Link to="/change-password">Trocar senha</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={onLogout}>Sair</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function profileDisplayName(user: Props['user']) {
  return user?.name ?? user?.email ?? '';
}

function profileRoleName(role?: string) {
  return ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? '—';
}

function ProfileDetails({ profileRole, user }: { profileRole: string; user: Props['user'] }) {
  return <div className="px-3 py-2"><p className="truncate text-sm font-medium">{profileDisplayName(user) || '—'}</p><p className="truncate text-xs" style={{ color: 'var(--foreground-muted)' }}>{user?.email}</p><p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{profileRole} · {user?.sector?.name ?? 'Sem setor'}</p></div>;
}

function MobileThemeItem({ setTheme, theme }: { setTheme: (theme: 'light' | 'dark') => void; theme: 'light' | 'dark' }) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = theme === 'dark' ? 'Tema claro' : 'Tema escuro';
  return <DropdownMenuItem className="sm:hidden" onClick={() => setTheme(nextTheme)}>{label}</DropdownMenuItem>;
}

/**
 * Desktop-only segmented light/dark control. Extracted from {@link Topbar} so its
 * per-button "is this the active theme" branching (aria-pressed + style ternaries)
 * lives in one place. Renders identical DOM to the inline version it replaced.
 */
function ThemeToggle({
  theme,
  set,
}: {
  theme: 'light' | 'dark';
  set: (t: 'light' | 'dark') => void;
}) {
  return (
    <div
      className="hidden items-center gap-0.5 rounded-full p-0.5 sm:inline-flex"
      style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border)' }}
    >
      <button
        type="button"
        onClick={() => set('light')}
        aria-label="Tema claro"
        aria-pressed={theme === 'light'}
        className="grid size-7 place-items-center rounded-full transition-colors"
        style={{
          background: theme === 'light' ? 'var(--surface)' : 'transparent',
          color: theme === 'light' ? 'var(--foreground)' : 'var(--foreground-muted)',
          boxShadow: theme === 'light' ? 'var(--shadow-xs)' : undefined,
        }}
      >
        <Sun className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => set('dark')}
        aria-label="Tema escuro"
        aria-pressed={theme === 'dark'}
        className="grid size-7 place-items-center rounded-full transition-colors"
        style={{
          background: theme === 'dark' ? 'var(--surface)' : 'transparent',
          color: theme === 'dark' ? 'var(--foreground)' : 'var(--foreground-muted)',
          boxShadow: theme === 'dark' ? 'var(--shadow-xs)' : undefined,
        }}
      >
        <Moon className="size-3.5" />
      </button>
    </div>
  );
}
