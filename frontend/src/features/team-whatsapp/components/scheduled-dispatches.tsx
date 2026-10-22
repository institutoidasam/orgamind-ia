import { useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatDayMonth } from '@/lib/civil-date';
import { useCancelDispatch } from '../api';
import { apiErrorCode, cancelErrorMessage } from '../error-messages';
import type { ScheduledDispatch } from '../schemas';

/** Data da escala + hora gravada no turno: não passa por conta de fuso (GC5). */
function whenText(item: ScheduledDispatch): string {
  return `${formatDayMonth(item.rosterDate)} ${item.shift.startTime}`;
}

function useCancelFlow() {
  const cancel = useCancelDispatch();
  const [asking, setAsking] = useState<ScheduledDispatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!asking) return;
    setError(null);
    try {
      await cancel.mutateAsync(asking.id);
    } catch (err) {
      setError(cancelErrorMessage(await apiErrorCode(err)));
    } finally {
      setAsking(null);
    }
  }
  return { asking, setAsking, error, confirm, pending: cancel.isPending };
}

function ScheduledRow({ item, onCancel, disabled }: { item: ScheduledDispatch; onCancel: () => void; disabled: boolean }) {
  return (
    <TableRow>
      <TableCell>{whenText(item)}</TableCell>
      <TableCell>{item.label}</TableCell>
      <TableCell>{`${item.recipientCount} pessoa(s)`}</TableCell>
      <TableCell>{item.channel?.name ?? 'canal removido'}</TableCell>
      <TableCell className="text-right">
        <Button variant="outline" size="sm" disabled={disabled} onClick={onCancel}>Cancelar</Button>
      </TableCell>
    </TableRow>
  );
}

/** Envios agendados para o início do turno, com Cancelar até o disparo. */
export function ScheduledDispatches({ items }: { items: ScheduledDispatch[] }) {
  const flow = useCancelFlow();
  if (items.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Agendados</h2>
      {flow.error && <p role="alert" className="text-sm text-destructive">{flow.error}</p>}
      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sai em</TableHead><TableHead>Destino</TableHead><TableHead>Pessoas</TableHead>
              <TableHead>Canal</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <ScheduledRow key={i.id} item={i} disabled={flow.pending} onCancel={() => flow.setAsking(i)} />
            ))}
          </TableBody>
        </Table>
      </div>
      <AlertDialog open={flow.asking !== null} onOpenChange={(open) => { if (!open) flow.setAsking(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar este envio?</AlertDialogTitle>
            <AlertDialogDescription>
              {flow.asking ? `${flow.asking.label} · ${whenText(flow.asking)}. Ninguém vai receber esta mensagem.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={flow.confirm}>Cancelar envio</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
