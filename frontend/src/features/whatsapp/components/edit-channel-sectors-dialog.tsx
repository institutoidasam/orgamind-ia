import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { extractApiError } from '@/lib/api-error';
import { useUpdateChannelSectors } from '../api';
import type { ChannelSector } from '../schemas';
import { useAreaChoice } from '../use-area-choice';
import { MoveConfirmation, SectorPicker } from './sector-picker';

export type SectorsChannel = { id: string; name: string; sectors?: ChannelSector[] };

type Props = {
  channel: SectorsChannel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Edita as áreas que um número atende (GoZap e Evolution). Só o ADMIN abre. */
export function EditChannelSectorsDialog({ channel, open, onOpenChange }: Props) {
  return (
    <Dialog open={open && channel !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{channel ? `Áreas de ${channel.name}` : 'Áreas'}</DialogTitle>
        </DialogHeader>
        {channel && <EditBody key={channel.id} channel={channel} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditBody({ channel, onClose }: { channel: SectorsChannel; onClose: () => void }) {
  const areas = useAreaChoice(channel.id, channel.sectors?.map((s) => s.id));
  const update = useUpdateChannelSectors();
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await update.mutateAsync({ channelId: channel.id, sectorIds: areas.selected });
      toast.success('Áreas atualizadas');
      onClose();
    } catch (err) {
      areas.dismiss();
      setError((await extractApiError(err)).title);
    }
  };

  if (areas.confirming) {
    return (
      <MoveConfirmation
        moves={areas.moves}
        pending={update.isPending}
        onConfirm={() => void areas.proceed(save)}
        onCancel={areas.dismiss}
      />
    );
  }
  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Não foi possível salvar as áreas</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SectorPicker sectors={areas.sectors} value={areas.selected} loading={areas.loading} onChange={areas.setSelected} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button type="button" disabled={update.isPending} onClick={() => void areas.proceed(save)}>Salvar</Button>
      </DialogFooter>
    </div>
  );
}
