import { Button } from '@/components/ui/button';

/**
 * Aviso do compositor travado: outra pessoa atende a conversa (K1-6, DK17).
 * O nome já vem pronto ("{nome}" ou "{nome} (inativo)"); quem decide se o
 * envio sai é o servidor, a tela só desliga "Enviar" até assumir.
 */
export function AssigneeLockBanner({ name, onAssume, pending }: {
  name: string; onAssume: () => void; pending: boolean;
}) {
  return (
    <div data-testid="assignee-lock-banner" role="status" className="flex items-center justify-between gap-2 px-4 pt-2 text-xs" style={{ color: 'var(--foreground-muted)' }}>
      <span>{name} está atendendo esta conversa.</span>
      <Button type="button" size="sm" variant="outline" onClick={onAssume} disabled={pending}>
        Assumir conversa
      </Button>
    </div>
  );
}
