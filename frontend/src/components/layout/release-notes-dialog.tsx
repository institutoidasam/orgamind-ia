import { Link } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RELEASE_NOTES } from '@/release-notes';
import { formatDatePtBr } from '@/lib/format-date-ptbr';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Lista as entradas de `RELEASE_NOTES` — data formatada em PT-BR e link "Ver"
 * para a rota (`where`) quando a novidade tem uma tela específica.
 * Puramente apresentacional: quem decide QUANDO abrir (sozinho ou pelo clique
 * no botão "Novidades") é `ReleaseNotesButton`.
 */
export function ReleaseNotesDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        showCloseButton={false}: o X do design system só anuncia "Close" (em
        inglês, pro leitor de tela) e o rodapé "Fechar" abaixo já cobre a
        mesma ação em PT-BR — evita duplicar o fechar em dois idiomas.
      */}
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Novidades</DialogTitle>
          <DialogDescription>O que mudou no ORGAMIND recentemente.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[420px] space-y-5 overflow-y-auto pr-1">
          {RELEASE_NOTES.map((release) => (
            <section key={release.version}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{release.title}</h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDatePtBr(release.date)}
                </span>
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {release.items.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-current" aria-hidden />
                    <span className="flex-1">
                      {item.text}
                      {item.where && (
                        <>
                          {' '}
                          <Link
                            to={item.where}
                            onClick={() => onOpenChange(false)}
                            className="font-medium text-foreground underline underline-offset-2"
                          >
                            Ver
                          </Link>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
