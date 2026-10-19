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

function selectField(input: HTMLInputElement | null) {
  input?.focus();
  input?.select();
}

// 1st step: async Clipboard API (missing or denied in insecure contexts and
// embedded browsers).
async function copyWithClipboardApi(text: string) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 2nd step: select the field and use the legacy copy command.
function copyWithExecCommand(input: HTMLInputElement | null) {
  selectField(input);
  try {
    // execCommand is deprecated, but it is an intentional fallback for contexts
    // without clipboard permission.
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

// 3rd step: leave the password focused and selected for a manual Ctrl+C.
function selectForManualCopy(input: HTMLInputElement | null) {
  try {
    selectField(input);
    toast.info('Senha selecionada', { description: 'Pressione Ctrl+C para copiar.' });
  } catch {
    toast.error('Não foi possível copiar', {
      description: 'Copie a senha manualmente.',
    });
  }
}

function usePasswordCopy(password: string) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clear any pending "copied" reset timer on unmount so it never fires a
  // setState on an unmounted component.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!(await copyWithClipboardApi(password)) && !copyWithExecCommand(inputRef.current)) {
      selectForManualCopy(inputRef.current);
      return;
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return { copied, inputRef, handleCopy };
}

export function TemporaryPasswordModal({ password, onClose }: Props) {
  const { copied, inputRef, handleCopy } = usePasswordCopy(password);

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
          <input
            ref={inputRef}
            readOnly
            aria-label="Senha temporária"
            value={password}
            className="min-w-0 flex-1 bg-transparent font-mono outline-none"
          />
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
