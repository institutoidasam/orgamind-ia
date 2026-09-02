import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Props = {
  password: string;
  onClose: () => void;
};

export function TemporaryPasswordModal({ password, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending "copied" reset timer on unmount so it never fires a
  // setState on an unmounted component.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar', {
        description: 'Copie a senha manualmente.',
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Senha temporária criada</DialogTitle>
        </DialogHeader>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          Compartilhe esta senha com o usuário. Ele será forçado a alterá-la no primeiro acesso.
        </p>
        <div
          className="flex items-center justify-between rounded-md border px-4 py-3 font-mono text-lg"
          style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border)' }}
        >
          <span>{password}</span>
          <Button type="button" variant="ghost" size="icon" onClick={handleCopy} aria-label="Copiar senha">
            {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
