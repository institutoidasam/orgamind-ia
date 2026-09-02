import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  FileSpreadsheet,
  LogOut,
  Search,
  Send,
  SunMoon,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { logoutRemote } from '@/lib/api-client';
import { NAV } from '@/lib/nav';

type CommandGroup = 'navegar' | 'criar' | 'ações' | 'sistema';

type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  keywords: string;
  icon: LucideIcon;
  run: () => void | Promise<void>;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, onOpenChange }: Props) {
  const router = useRouter();
  const { toggle } = useTheme();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands: Command[] = useMemo(
    () => [
      // "navegar" group is derived from the shared NAV manifest so it stays in
      // sync with the sidebar (Inbox/Segmentos/Imports included).
      ...NAV.map((n) => ({
        id: `go-${n.to.replace(/\//g, '')}`,
        label: `Ir para ${n.label}`,
        group: 'navegar' as const,
        keywords: `${n.label} ${n.to.replace('/', '')}`.toLowerCase(),
        icon: n.icon,
        run: () => router.navigate({ to: n.to as never }),
      })),
      { id: 'new-campaign', label: 'Nova campanha', group: 'criar', keywords: 'nova campanha new campaign', icon: Send, run: () => router.navigate({ to: '/campaigns/new' }) },
      { id: 'new-contact', label: 'Novo contato', group: 'criar', keywords: 'novo contato new contact', icon: UserPlus, run: () => router.navigate({ to: '/contacts' }) },
      { id: 'import-sheet', label: 'Importar planilha', group: 'criar', keywords: 'importar planilha excel xlsx import', icon: FileSpreadsheet, run: () => router.navigate({ to: '/imports/new' as never }) },
      { id: 'theme-toggle', label: 'Mudar tema', group: 'ações', keywords: 'tema dark light theme', icon: SunMoon, run: () => toggle() },
      { id: 'logout', label: 'Sair', group: 'sistema', keywords: 'sair logout', icon: LogOut, run: async () => { await logoutRemote(); router.navigate({ to: '/login' }); } },
    ],
    [router, toggle],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  // Focus trap + restore: while the palette is open, swallow Tab so focus
  // can't leak to elements behind the backdrop. When the palette closes,
  // restore focus to whatever element opened it.
  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // The palette only has an input + a vertical list; users navigate via
      // ArrowUp/ArrowDown. Prevent Tab from escaping the dialog at all.
      e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus();
      }
    };
  }, [open]);

  // Global ⌘K / Ctrl+K (open or close).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === 'Escape' && open) onOpenChange(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  const groups: CommandGroup[] = ['navegar', 'criar', 'ações', 'sistema'];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      style={{ background: 'oklch(0 0 0 / 0.4)', backdropFilter: 'blur(8px)' }}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-xl"
        style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
      >
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <Search className="size-4" style={{ color: 'var(--foreground-muted)' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar ou executar..."
            className="w-full bg-transparent text-base outline-none"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(filtered.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                const cmd = filtered[active];
                if (cmd) {
                  void cmd.run();
                  onOpenChange(false);
                }
              }
            }}
          />
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-2" role="listbox">
          {groups.map((g) => {
            const items = filtered.filter((c) => c.group === g);
            if (items.length === 0) return null;
            return (
              <li key={g} className="px-2 py-1">
                <div className="ds-eyebrow px-2 py-1">{g}</div>
                {items.map((c) => {
                  const idx = filtered.indexOf(c);
                  const isActive = idx === active;
                  return (
                    <button
                      key={c.id}
                      id={`cmd-${c.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => {
                        void c.run();
                        onOpenChange(false);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm"
                      style={{
                        background: isActive ? 'var(--surface-hover)' : 'transparent',
                        color: 'var(--foreground)',
                      }}
                    >
                      <c.icon className="size-3.5 shrink-0" style={{ color: 'var(--foreground-muted)' }} />
                      <span>{c.label}</span>
                    </button>
                  );
                })}
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li
              className="px-4 py-6 text-center text-sm"
              style={{ color: 'var(--foreground-muted)' }}
            >
              Nenhum comando encontrado.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
