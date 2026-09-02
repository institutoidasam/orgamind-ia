import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { extractApiError } from '@/lib/api-error';
import { useDeleteGozapChannel } from '../api';

type Props = {
  channel: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Confirmação DIGITADA antes de remover um canal GOZAP — pedida
 * explicitamente pelo cliente (a conta de produção tem 1 instância só, e
 * remover a errada derruba o único canal que funciona).
 *
 * A remoção é DEFINITIVA: `DELETE /whatsapp/channels/:id` chama `DELETE
 * /instance` no GoZap (desliga a sessão de verdade, do lado do provedor) e
 * soft-deleta a row — sem caminho de reativação (ver GozapInstancesService.
 * remove). Digitar o NOME do canal, e não um botão de "tem certeza?", é o
 * que impede um clique duplo/apressado numa lista de várias conexões de
 * acertar a errada.
 */
export function RemoveGozapChannelDialog({ channel, open, onOpenChange }: Props) {
  const [typed, setTyped] = useState('');
  const del = useDeleteGozapChannel();

  const handleOpenChange = (next: boolean) => {
    if (!next) setTyped('');
    onOpenChange(next);
  };

  if (!channel) return null;
  const matches = typed.trim() === channel.name;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remover conexão "{channel.name}"?</DialogTitle>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTitle>Isso é definitivo</AlertTitle>
          <AlertDescription>
            O orgamind desliga esta instância no GoZap e apaga a conexão daqui — não
            é possível desfazer. Para voltar a usar este número será preciso criar
            uma conexão nova e escanear o QR de novo.
          </AlertDescription>
        </Alert>

        <div className="space-y-1">
          <Label htmlFor="remove-gozap-confirm">
            Para confirmar, digite o nome do canal: <strong>{channel.name}</strong>
          </Label>
          <Input
            id="remove-gozap-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!matches || del.isPending}
            onClick={async () => {
              try {
                await del.mutateAsync(channel.id);
                toast.success('Canal removido');
                handleOpenChange(false);
              } catch (err) {
                const { title, message } = await extractApiError(err);
                toast.error(title, { description: message });
              }
            }}
          >
            {del.isPending ? 'Removendo…' : 'Remover definitivamente'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
