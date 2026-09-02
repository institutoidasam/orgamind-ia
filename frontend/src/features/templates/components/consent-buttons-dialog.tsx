// ★ ZB — "O que estes botões significam?"
//
// O template foi criado FORA do orgamind (no painel do Zernio/Meta) e chegou pelo
// sync. O Zernio não transporta payload de quick_reply: o clique só chega como o
// RÓTULO, e o reconhecimento é uma lista fechada. Do rótulo sozinho é
// INDECIDÍVEL se "Bora, quero!" é um botão comum ou o "sim" de um opt-in — e a
// diferença entre os dois é 13.400 consentimentos documentados ou zero.
//
// Então quem decide é o operador, aqui. E o servidor CONFERE: declarar
// "Bora, quero!" como opt-in é RECUSADO — a declaração não faz o clique passar a
// ser lido. A única saída para um "sim" não reconhecido é recriar o template
// pelo orgamind, escolhendo o rótulo da lista.
import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { extractApiError } from '@/lib/api-error';
import { useDeclareConsentButtons } from '../api';
import type { Template, ZernioButtonRoleValue } from '../schemas';
import { ZERNIO_BUTTON_ROLE_LABEL } from '../zernio-schemas';

type Props = {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** O papel já declarado de um rótulo, ou NONE (o default seguro: não é consentimento). */
function initialRoles(t: Template): Record<string, ZernioButtonRoleValue> {
  const declared = new Map(
    (t.consentButtons?.declared ?? []).map((d) => [d.text, d.role]),
  );
  const out: Record<string, ZernioButtonRoleValue> = {};
  for (const label of t.consentButtons?.labels ?? []) {
    out[label] = declared.get(label) ?? 'NONE';
  }
  return out;
}

export function ConsentButtonsDialog({ template, open, onOpenChange }: Props) {
  const declare = useDeclareConsentButtons();
  const [roles, setRoles] = useState<Record<string, ZernioButtonRoleValue>>(() =>
    initialRoles(template),
  );
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRoles(initialRoles(template));
      setServerError(null);
    }
  }, [open, template]);

  const labels = template.consentButtons?.labels ?? [];

  async function onSubmit() {
    setServerError(null);
    try {
      await declare.mutateAsync({
        id: template.id,
        buttons: labels.map((text) => ({ text, role: roles[text] ?? 'NONE' })),
      });
      toast.success('Botões classificados — o template já pode ser usado.');
      onOpenChange(false);
    } catch (err) {
      const apiErr = await extractApiError(err);
      setServerError(apiErr.message);
      toast.error(apiErr.title, { description: apiErr.message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>O que estes botões significam?</DialogTitle>
          <DialogDescription>
            {template.metaName} — o template foi criado fora do orgamind, então
            ninguém disse ainda o que cada botão significa.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            O WhatsApp não devolve um identificador do botão — o sistema só
            reconhece o clique pelo <strong>rótulo</strong>, contra uma lista
            fechada. Um botão de aceite com rótulo não reconhecido faz o clique
            da pessoa <strong>ir para o lixo</strong>: ela acha que aceitou, e
            nenhum consentimento é gravado. Por isso a campanha só libera este
            template depois que os botões forem classificados — e um rótulo que o
            sistema não lê <strong>não pode</strong> ser marcado como aceite.
          </p>
        </div>

        <div className="space-y-3">
          {labels.map((label, i) => (
            <div key={label} className="space-y-1">
              <Label htmlFor={`consent-role-${i}`}>
                Botão {i + 1}: <span className="font-normal">“{label}”</span>
              </Label>
              <Select
                value={roles[label] ?? 'NONE'}
                onValueChange={(v) =>
                  setRoles((prev) => ({
                    ...prev,
                    [label]: v as ZernioButtonRoleValue,
                  }))
                }
              >
                <SelectTrigger id={`consent-role-${i}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">
                    {ZERNIO_BUTTON_ROLE_LABEL.NONE}
                  </SelectItem>
                  <SelectItem value="OPT_IN">
                    {ZERNIO_BUTTON_ROLE_LABEL.OPT_IN}
                  </SelectItem>
                  <SelectItem value="OPT_OUT">
                    {ZERNIO_BUTTON_ROLE_LABEL.OPT_OUT}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          Se o "sim" deste template tem um rótulo que o sistema não reconhece, não
          há como salvá-lo: crie um novo template pelo "Novo template Zernio",
          onde o rótulo do aceite é escolhido de uma lista.
        </p>

        {serverError && (
          <div
            role="alert"
            className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {serverError}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={declare.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void onSubmit()}
            disabled={declare.isPending}
          >
            {declare.isPending ? 'Salvando...' : 'Salvar classificação'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
