import { useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/features/internal-communications/components/pagination';
import { usePermission } from '@/features/permissions/use-permission';
import { formatDayMonth } from '@/lib/civil-date';
import { useCancelDispatch } from '../api';
import { apiErrorText, cancelErrorMessage } from '../error-messages';
import { DISPATCH_STATE_LABEL, isLapsed, manausDateTime } from '../labels';
import type { Paging, ScheduledDispatch } from '../schemas';

/**
 * Com turno: data da escala + hora gravada no turno, sem conta de fuso (GC5). Sem turno (data e hora livres
 * com vários ou todos os turnos): dia/mês e hora de `scheduledFor` em Manaus.
 */
function whenText(item: ScheduledDispatch): string {
  if (item.shift) return `${formatDayMonth(item.rosterDate)} ${item.shift.startTime}`;
  const { dayMonth, time } = manausDateTime(item.scheduledFor);
  return `${dayMonth} ${time}`;
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
      setError(await apiErrorText(err, cancelErrorMessage));
    } finally {
      setAsking(null);
    }
  }
  return { asking, setAsking, error, confirm, pending: cancel.isPending };
}

type RowProps = { item: ScheduledDispatch; onCancel: () => void; disabled: boolean };

/** Cancelar é ação de envio (DB6): sem `equipe.enviar` a linha só informa. */
function ScheduledRow({ item, onCancel, disabled }: RowProps) {
  const canCancel = usePermission('equipe.enviar');
  return (
    <TableRow>
      <TableCell>
        {whenText(item)}
        {/* DG16: o worker parado deixa o item `SCHEDULED` vencido; aqui só há `scheduledFor`, então só rótulo. */}
        {isLapsed(item.scheduledFor, new Date()) && <p className="font-medium">{DISPATCH_STATE_LABEL.EXPIRED}</p>}
      </TableCell>
      <TableCell>{item.label}</TableCell>
      <TableCell>{`${item.recipientCount} pessoa(s)`}</TableCell>
      <TableCell>{item.channel?.name ?? '—'}</TableCell>
      <TableCell className="text-right">
        {canCancel && <Button variant="outline" size="sm" disabled={disabled} onClick={onCancel}>Cancelar</Button>}
      </TableCell>
    </TableRow>
  );
}

/** Uma página dos envios agendados para o início do turno, com Cancelar até o disparo. */
export function ScheduledDispatches({ items, paging }: { items: ScheduledDispatch[]; paging: Paging }) {
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
              <TableHead>Número</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <ScheduledRow key={i.id} item={i} disabled={flow.pending} onCancel={() => flow.setAsking(i)} />
            ))}
          </TableBody>
        </Table>
      </div>
      {paging.total > paging.pageSize && <Pagination {...paging} />}
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
