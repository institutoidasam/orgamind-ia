import type { ReactNode } from 'react';

type Props = {
  sidebar: ReactNode;
  topbar: ReactNode;
  children: ReactNode;
  /** Rodapé opcional, renderizado depois do conteúdo principal. */
  footer?: ReactNode;
  /** Desktop mini-rail vs full sidebar. Ignored on mobile (drawer is always full width). */
  collapsed?: boolean;
  /** Mobile drawer open state — only meaningful on viewports below the `lg` breakpoint. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export function AppShell({
  sidebar,
  topbar,
  children,
  footer,
  collapsed = false,
  mobileOpen = false,
  onMobileClose,
}: Props) {
  return (
    <div
      className="flex min-h-screen"
      style={{ background: 'var(--canvas)', color: 'var(--foreground)' }}
    >
      {mobileOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          onClick={onMobileClose}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}

      <aside
        aria-label="Navegação principal"
        data-collapsed={collapsed ? 'true' : undefined}
        data-mobile-open={mobileOpen ? 'true' : undefined}
        className={[
          // shared
          'no-print',
          'fixed inset-y-0 left-0 z-40 w-[210px] overflow-y-auto transition-transform duration-200',
          // desktop: sticky in flow, width driven by CSS variable below
          'lg:sticky lg:top-0 lg:z-0 lg:h-screen lg:!w-[var(--sidebar-w)] lg:translate-x-0 lg:transition-[width]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        style={{ ['--sidebar-w' as string]: collapsed ? '64px' : '210px' }}
      >
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {topbar}
        <main className="flex-1 px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-7">{children}</main>
        {footer}
      </div>
    </div>
  );
}
