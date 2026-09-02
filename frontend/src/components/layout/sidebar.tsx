import { Link, useRouterState } from '@tanstack/react-router';
import logoSvg from '@/assets/logo.svg';
import { initials } from '@/lib/initials';
import { useConversations } from '@/features/chat/api';
import { isNavActive, navSection, type NavItem } from '@/lib/nav';

const NAV_OPS = navSection('ops');
const NAV_SYS = navSection('sys');
const NAV_ADMIN = navSection('admin');

type Props = {
  collapsed: boolean;
  user?: { email: string; name?: string | null; role?: string } | null;
  /** Called when a nav link is clicked — used by the mobile drawer to close itself. */
  onNavigate?: () => void;
};

export function Sidebar({ collapsed, user, onNavigate }: Props) {
  const router = useRouterState();
  const path = router.location.pathname;
  const isActive = (to: string) => isNavActive(path, to);

  const unread = useConversations('unread', '');
  // Total unread MESSAGES (sum of per-conversation unreadCount), not the count
  // of unread conversations. Bounded to the first page of unread conversations,
  // which is plenty for a sidebar badge.
  const unreadTotal = unread.data?.items.reduce((acc, c) => acc + c.unreadCount, 0) ?? 0;

  const displayName = user?.name ?? user?.email ?? '';

  return (
    <div
      className="flex h-full min-h-screen flex-col px-3 py-4 lg:min-h-0"
      style={{ background: 'var(--surface-sunken)', borderRight: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2.5 px-1.5 pb-4">
        <img src={logoSvg} alt="" className="size-6" aria-hidden />
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-[20px] font-bold tracking-tight">ORGAMIND</div>
            <div
              className="text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--foreground-muted)' }}
              title="Plataforma Inteligente de Comunicação Operacional Automática"
            >
              Comunicação operacional
            </div>
          </div>
        )}
      </div>

      <Section eyebrow="operação" items={NAV_OPS} badges={{ '/inbox': unreadTotal }} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />
      <Section eyebrow="sistema" items={NAV_SYS} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />
      {user?.role === 'ADMIN' && (
        <Section eyebrow="admin" items={NAV_ADMIN} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />
      )}

      <div className="flex-1" />

      <div
        className="flex items-center gap-2.5 border-t pt-2.5 text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
      >
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: 'var(--gradient-brand)' }}
        >
          {initials(displayName)}
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-foreground">{user?.name ?? user?.email ?? '—'}</div>
            <div className="text-[11px] uppercase tracking-wider">{user?.role ?? 'operador'}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  eyebrow,
  items,
  badges,
  collapsed,
  isActive,
  onNavigate,
}: {
  eyebrow: string;
  items: NavItem[];
  badges?: Record<string, number>;
  collapsed: boolean;
  isActive: (to: string) => boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {!collapsed && <div className="ds-eyebrow px-2 pb-1 pt-2">{eyebrow}</div>}
      {items.map(({ label, to, icon: Icon }) => {
        const active = isActive(to);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors"
            style={{
              background: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--foreground)' : 'var(--foreground-muted)',
              boxShadow: active ? 'var(--shadow-xs), var(--ring-soft)' : undefined,
            }}
          >
            <Icon className="size-[18px] shrink-0" />
            {!collapsed && <span>{label}</span>}
            {badges?.[to] ? (
              <span className="ml-auto rounded-full px-1.5 text-[10px] font-bold text-white" style={{ background: 'var(--brand-purple)' }}>
                {badges[to]}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
