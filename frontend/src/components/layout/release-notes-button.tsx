import { useState } from 'react';
import { Gift } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useReleaseNotes } from '@/lib/use-release-notes';
import { ReleaseNotesDialog } from './release-notes-dialog';

/**
 * Controle global de "Novidades" no topbar: mostra o badge "Novo" enquanto
 * houver versão não vista e abre o diálogo sozinho na primeira renderização
 * com versão nova (via `hasUnseen`), ou ao clicar. Fechar o diálogo marca a
 * versão como vista — não volta a abrir sozinho até a próxima versão.
 *
 * `open` é semeado UMA vez a partir de `hasUnseen` (abertura automática) e
 * depois só muda por ação local (clique, fechar) — nunca mais é recalculado
 * ao vivo a partir de `hasUnseen`. Isso é proposital: `hasUnseen` reflete o
 * localStorage, que pode não convergir de imediato (ou nunca, se `setItem`
 * lançar — quota, modo privado do Safari...); se `open` continuasse
 * derivado dele, fechar o diálogo (Escape/overlay/X/"Fechar") podia reabrir
 * o próprio diálogo Radix no mesmo render (foco preso, ponteiro bloqueado —
 * achado #1 da revisão final de Fase C). O badge "Novo", por outro lado,
 * deve mesmo seguir `hasUnseen` ao vivo.
 */
export function ReleaseNotesButton() {
  const { hasUnseen, markSeen } = useReleaseNotes();
  const [open, setOpen] = useState(() => hasUnseen);

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
