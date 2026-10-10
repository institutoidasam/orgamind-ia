import { Link, useRouterState } from '@tanstack/react-router';
import { Brand } from '@/components/brand';
import { initials } from '@/lib/initials';
import { WORKSPACE_NAME } from '@/lib/brand';
import { useInternalUnreadCount } from '@/lib/internal-unread';
import { isNavActive, navSection, type NavItem, type NavRole } from '@/lib/nav';

type Props = {
  collapsed: boolean;
  user?: { email: string; name?: string | null; role?: string } | null;
  /** Called when a nav link is clicked — used by the mobile drawer to close itself. */
  onNavigate?: () => void;
};

type SectionProps = {
  eyebrow: string;
  items: NavItem[];
  badges?: Record<string, number>;
  collapsed: boolean;
  isActive: (to: string) => boolean;
  onNavigate?: () => void;
};

type NavigationItemProps = Pick<SectionProps, 'badges' | 'collapsed' | 'isActive' | 'onNavigate'> & {
  item: NavItem;
};

export function Sidebar({ collapsed, user, onNavigate }: Props) {
  const router = useRouterState();
  const path = router.location.pathname;
  const isActive = (to: string) => isNavActive(path, to);

  const role = user?.role as NavRole | undefined;
  const unread = useInternalUnreadCount({ role: user?.role, userKey: user?.email });
  const unreadTotal = unread.data?.count ?? 0;
  const work = navSection('ops', role);
  const followUp = navSection('sys', role);
  const administration = navSection('admin', role);

  return (
    <div
      className="flex h-full min-h-screen flex-col px-2 py-4 lg:min-h-0"
      style={{ background: 'var(--brand-navy)', color: '#fff' }}
    >
      <SidebarBrand collapsed={collapsed} />

      <Section eyebrow="Trabalho" items={work} badges={{ '/caixa-de-entrada': unreadTotal }} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />
      <Section eyebrow="Acompanhar" items={followUp} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />
      {administration.length > 0 && <Section eyebrow="Administração" items={administration} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />}

      <div className="flex-1" />

      <SidebarIdentity collapsed={collapsed} user={user} />
    </div>
  );
}

function Section({ eyebrow, items, badges, collapsed, isActive, onNavigate }: SectionProps) {
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {!collapsed && (
        <div
          className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.12em]"
          style={{ color: 'rgba(173, 189, 209, 0.85)' }}
        >
          {eyebrow}
        </div>
      )}
      {items.map((item) => (
        <NavigationItem
          key={item.to}
          item={item}
          badges={badges}
          collapsed={collapsed}
          isActive={isActive}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function SidebarBrand({ collapsed }: Pick<Props, 'collapsed'>) {
  return (
    <div className="px-1.5 pb-4">
      <Brand compact={collapsed} inverse subtitle={WORKSPACE_NAME} />
    </div>
  );
}

function NavigationItem({ item, badges, collapsed, isActive, onNavigate }: NavigationItemProps) {
  const active = isActive(item.to);
  const badge = badges?.[item.to];
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-orange)]"
      style={{
        background: active ? 'color-mix(in srgb, var(--brand-navy) 72%, white)' : 'transparent',
        color: active ? '#fff' : '#dbe4ef',
        boxShadow: active ? 'inset 3px 0 var(--brand-orange)' : undefined,
      }}
    >
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && <span>{item.label}</span>}
      {badge ? <UnreadBadge active={active}>{badge}</UnreadBadge> : null}
    </Link>
  );
}

function UnreadBadge({ active, children }: { active: boolean; children: number }) {
  return (
    <span
      className="ml-auto rounded-full px-1.5 text-[10px] font-bold"
      style={{
        background: active ? 'var(--brand-orange)' : 'rgba(219, 228, 239, 0.18)',
        color: active ? 'var(--brand-navy)' : '#dbe4ef',
      }}
    >
      {children}
    </span>
  );
}

function SidebarIdentity({ collapsed, user }: Pick<Props, 'collapsed' | 'user'>) {
  const displayName = identityDisplayName(user);

  return (
    <div
      className="flex items-center gap-2.5 border-t pt-2.5 text-xs"
      style={{ borderColor: 'rgba(219, 228, 239, 0.18)', color: 'rgba(219, 228, 239, 0.72)' }}
    >
      <span
        className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
        style={{ background: 'var(--brand-orange)', color: 'var(--brand-navy)' }}
      >
        {initials(displayName)}
      </span>
      <IdentityDetails collapsed={collapsed} user={user} />
    </div>
  );
}

function IdentityDetails({ collapsed, user }: Pick<Props, 'collapsed' | 'user'>) {
  if (collapsed) return null;
  return (
    <div className="min-w-0">
      <div className="truncate text-white">{identityDisplayName(user) || '—'}</div>
      <div className="text-[11px] uppercase tracking-wider">{roleLabel(user?.role)}</div>
    </div>
  );
}

function identityDisplayName(user: Props['user']) {
  return user?.name ?? user?.email ?? '';
}

function roleLabel(role?: string) {
  return ({ ADMIN: 'Administrador', SUPERVISOR: 'Supervisor', OPERATOR: 'Operador', VIEWER: 'Leitura' } as const)[role as NavRole] ?? '—';
}
