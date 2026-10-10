import { useState } from 'react';
import { Gift } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useReleaseNotes } from '@/lib/use-release-notes';
import { ReleaseNotesDialog } from './release-notes-dialog';

/**
 * Controle global de "Novidades" no topbar: mostra o badge "Novo" enquanto
 * houver versão não vista e abre o diálogo somente por clique. Fechar o diálogo
 * marca a versão como vista.
 *
 * `open` começa fechado e só muda por ação local (clique, fechar), nunca por
 * `hasUnseen`. Isso permite manter o badge ao vivo mesmo quando `localStorage`
 * falha e garante que fechar o diálogo não o reabra.
 */
export function ReleaseNotesButton() {
  const { hasUnseen, markSeen } = useReleaseNotes();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Novidades"
        title="Novidades"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--foreground-muted)' }}
      >
        <Gift className="size-4 shrink-0" />
        <span className="hidden md:inline">Novidades</span>
        {hasUnseen && <Badge>Novo</Badge>}
      </button>
      <ReleaseNotesDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) markSeen();
        }}
      />
    </>
  );
}
