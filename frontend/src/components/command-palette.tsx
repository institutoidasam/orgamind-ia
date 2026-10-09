import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
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

type PaletteContentProps = {
  commands: Command[];
  query: string;
  active: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onActivate: (index: number) => void;
  onQueryChange: (query: string) => void;
  onMove: (direction: 1 | -1) => void;
  onSelect: (command: Command) => void;
};

const GROUPS: CommandGroup[] = ['navegar', 'criar', 'ações', 'sistema'];

function useCommands(router: ReturnType<typeof useRouter>, toggle: () => void): Command[] {
  return useMemo(() => [
    ...NAV.map((item) => ({
      id: `go-${item.to.replace(/\//g, '')}`,
      label: `Ir para ${item.label}`,
      group: 'navegar' as const,
      keywords: `${item.label} ${item.to.replace('/', '')}`.toLowerCase(),
      icon: item.icon,
      run: () => router.navigate({ to: item.to as never }),
    })),
    ...createCommands(router, toggle),
  ], [router, toggle]);
}

function createCommands(
  router: ReturnType<typeof useRouter>,
  toggle: () => void,
): Command[] {
  return [
    { id: 'new-campaign', label: 'Nova campanha', group: 'criar', keywords: 'nova campanha new campaign', icon: Send, run: () => router.navigate({ to: '/campaigns/new' }) },
    { id: 'new-contact', label: 'Novo contato', group: 'criar', keywords: 'novo contato new contact', icon: UserPlus, run: () => router.navigate({ to: '/contacts' }) },
    { id: 'import-sheet', label: 'Importar planilha', group: 'criar', keywords: 'importar planilha excel xlsx import', icon: FileSpreadsheet, run: () => router.navigate({ to: '/imports/new' as never }) },
    { id: 'theme-toggle', label: 'Mudar tema', group: 'ações', keywords: 'tema dark light theme', icon: SunMoon, run: toggle },
    { id: 'logout', label: 'Sair', group: 'sistema', keywords: 'sair logout', icon: LogOut, run: () => signOut(router) },
  ];
}

async function signOut(router: ReturnType<typeof useRouter>) {
  await logoutRemote();
  router.navigate({ to: '/login' });
}

function filterCommands(commands: Command[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return commands;
  return commands.filter((command) =>
    command.label.toLowerCase().includes(normalizedQuery)
    || command.keywords.toLowerCase().includes(normalizedQuery),
  );
}

function useFocusTrap(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const previousActive = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousActive?.focus();
    };
  }, [inputRef]);
}

export function CommandPalette({ open, onOpenChange }: Props) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
      if (event.key === 'Escape' && open) onOpenChange(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  return open ? <PaletteDialog onOpenChange={onOpenChange} /> : null;
}

function PaletteDialog({ onOpenChange }: Pick<Props, 'onOpenChange'>) {
  const router = useRouter();
  const { toggle } = useTheme();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commands = useCommands(router, toggle);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  useFocusTrap(inputRef);

  const onQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    setActive(0);
  };
  const onMove = (direction: 1 | -1) => {
    setActive((current) => Math.min(Math.max(current + direction, 0), filtered.length - 1));
  };
  const onSelect = (command: Command) => {
    void command.run();
    onOpenChange(false);
  };

  return (
    <PaletteContent
      active={active}
      commands={filtered}
      inputRef={inputRef}
      onActivate={setActive}
      onMove={onMove}
      onOpenChange={onOpenChange}
      onQueryChange={onQueryChange}
      onSelect={onSelect}
      query={query}
    />
  );
}

function PaletteContent({
  active,
  commands,
  inputRef,
  onActivate,
  onMove,
  onOpenChange,
  onQueryChange,
  onSelect,
  query,
}: PaletteContentProps & { onOpenChange: (open: boolean) => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      style={{ background: 'oklch(0 0 0 / 0.4)', backdropFilter: 'blur(8px)' }}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-xl"
        style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
      >
        <CommandSearch
          active={active}
          commands={commands}
          inputRef={inputRef}
          onMove={onMove}
          onQueryChange={onQueryChange}
          onSelect={onSelect}
          query={query}
        />
        <CommandList
          active={active}
          commands={commands}
          onActivate={onActivate}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

function CommandSearch({
  active,
  commands,
  inputRef,
  onMove,
  onQueryChange,
  onSelect,
  query,
}: Pick<PaletteContentProps, 'active' | 'commands' | 'inputRef' | 'onMove' | 'onQueryChange' | 'onSelect' | 'query'>) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      onMove(-1);
    } else if (event.key === 'Enter' && commands[active]) {
      onSelect(commands[active]);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
      <Search className="size-4" style={{ color: 'var(--foreground-muted)' }} />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Buscar ou executar..."
        className="w-full bg-transparent text-base outline-none"
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function CommandList({
  active,
  commands,
  onActivate,
  onSelect,
}: Pick<PaletteContentProps, 'active' | 'commands' | 'onActivate' | 'onSelect'>) {
  return (
    <ul className="max-h-[60vh] overflow-y-auto py-2" role="listbox">
      {GROUPS.map((group) => (
        <CommandGroupList
          key={group}
          active={active}
          commands={commands}
          group={group}
          onActivate={onActivate}
          onSelect={onSelect}
        />
      ))}
      {commands.length === 0 && <EmptyCommands />}
    </ul>
  );
}

function CommandGroupList({
  active,
  commands,
  group,
  onActivate,
  onSelect,
}: Pick<PaletteContentProps, 'active' | 'commands' | 'onActivate' | 'onSelect'> & { group: CommandGroup }) {
  const groupCommands = commands.filter((command) => command.group === group);
  if (groupCommands.length === 0) return null;

  return (
    <li className="px-2 py-1">
      <div className="ds-eyebrow px-2 py-1">{group}</div>
      {groupCommands.map((command) => {
        const index = commands.indexOf(command);
        return (
          <CommandOption
            key={command.id}
            active={index === active}
            command={command}
            onHover={() => onActivate(index)}
            onSelect={onSelect}
          />
        );
      })}
    </li>
  );
}

function CommandOption({
  active,
  command,
  onHover,
  onSelect,
}: {
  active: boolean;
  command: Command;
  onHover: () => void;
  onSelect: (command: Command) => void;
}) {
  const Icon = command.icon;
  return (
    <button
      id={`cmd-${command.id}`}
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={() => onSelect(command)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm"
      style={{ background: active ? 'var(--surface-hover)' : 'transparent', color: 'var(--foreground)' }}
    >
      <Icon className="size-3.5 shrink-0" style={{ color: 'var(--foreground-muted)' }} />
      <span>{command.label}</span>
    </button>
  );
}

function EmptyCommands() {
  return (
    <li className="px-4 py-6 text-center text-sm" style={{ color: 'var(--foreground-muted)' }}>
      Nenhum comando encontrado.
    </li>
  );
}
