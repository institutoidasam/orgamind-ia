import { useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useInstanceQr } from '../api';
import { QrPane } from './create-instance-dialog';

type Props = {
  instanceId: string | null;
  instanceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
};

/**
 * Pairs an EXISTING instance. Polling the QR endpoint also lazily provisions
 * the instance on the Evolution side if it was never created (e.g. the
 * seed-created default), so this is the single "Conectar" entry point for any
 * offline instance. Mirrors the QR step of CreateInstanceDialog.
 */
export function ConnectInstanceDialog({
  instanceId,
  instanceName,
  open,
  onOpenChange,
  onConnected,
}: Props) {
  // Only poll while the dialog is open so we don't keep provisioning/QR-fetching
  // in the background.
  const qr = useInstanceQr(open ? (instanceId ?? undefined) : undefined);

  // React Query caches the QR result by instance id and keeps it fresh under the
  // global staleTime, so reopening this dialog can synchronously serve a stale
  // { state: 'open' } left over from a *previous* connect — with no refetch. Auto-
  // closing on that would falsely report an offline number as reconnected. Capture
  // the cached `dataUpdatedAt` when this session opens and only trust an 'open'
  // state that was fetched *after* (i.e. the timestamp advanced past the baseline).
  const baselineUpdatedAtRef = useRef(0);
  useEffect(() => {
    if (open) baselineUpdatedAtRef.current = qr.dataUpdatedAt;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const freshlyFetched = qr.dataUpdatedAt > baselineUpdatedAtRef.current;
    if (open && freshlyFetched && qr.data?.state === 'open') {
      const t = setTimeout(() => {
        onConnected?.();
        onOpenChange(false);
      }, 800);
      return () => clearTimeout(t);
    }
  }, [open, qr.dataUpdatedAt, qr.data?.state, onConnected, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar {instanceName}</DialogTitle>
        </DialogHeader>
        <QrPane
          qr={qr.data}
          state={qr.data?.state}
          instanceName={instanceName}
          onRetry={() => void qr.refetch()}
          isFetching={qr.isFetching}
          isError={qr.isError}
        />
      </DialogContent>
    </Dialog>
  );
}
