import { useState } from 'react';
import { toast } from 'sonner';
import {
  useInstances,
  useDeleteInstance,
  useSetDefaultInstance,
  useRestartInstance,
} from '../api';
import { InstancesList } from './instances-list';
import { CreateInstanceDialog } from './create-instance-dialog';
import { ConnectInstanceDialog } from './connect-instance-dialog';
import { InstanceConfigDrawer } from './instance-config-drawer';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { extractApiError } from '@/lib/api-error';

/**
 * The EVOLUTION provider section of the Canais page — the per-instance QR
 * connection flow (list, create, connect, restart, config, remove). Unchanged
 * from the pre-multi-provider "Conectar" page; the multi-provider work simply
 * lifted it into its own section so cloud providers (Twilio/Zernio) can sit
 * alongside it. Cloud providers have no QR/restart concept, so those actions
 * live here and nowhere else.
 */
export function EvolutionSection({ role }: { role: 'ADMIN' | 'OPERATOR' }) {
  const instances = useInstances();
  const [createOpen, setCreateOpen] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);

  const del = useDeleteInstance();
  const setDefault = useSetDefaultInstance();
  const restart = useRestartInstance();

  if (instances.isError) {
    return <QueryErrorFallback error={instances.error} onRetry={() => instances.refetch()} />;
  }

  const configInstance = instances.data?.find((i) => i.id === configId);

  return (
    <div className="space-y-4">
      <InstancesList
        instances={instances.data ?? []}
        role={role}
        isInstanceOnline={(i) => i.lastConnectionState === 'open'}
        onAction={async (a) => {
          if (a.kind === 'create') setCreateOpen(true);
          if (a.kind === 'connect') setConnectId(a.id);
          if (a.kind === 'config') setConfigId(a.id);
          if (a.kind === 'remove') {
            try {
              await del.mutateAsync(a.id);
              toast.success('Conexão removida');
            } catch (err) {
              const { title, message } = await extractApiError(err);
              toast.error(title, { description: message });
            }
          }
          if (a.kind === 'setDefault') {
            try {
              await setDefault.mutateAsync(a.id);
              toast.success('Padrão atualizado');
            } catch (err) {
              const { title, message } = await extractApiError(err);
              toast.error(title, { description: message });
            }
          }
          if (a.kind === 'restart') {
            try {
              await restart.mutateAsync(a.id);
              toast.success('Reiniciando…');
            } catch {
              toast.error('Falha ao reiniciar');
            }
          }
        }}
      />

      <CreateInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { void instances.refetch(); }}
      />

      <ConnectInstanceDialog
        instanceId={connectId}
        instanceName={
          instances.data?.find((i) => i.id === connectId)?.name ?? 'conexão'
        }
        open={!!connectId}
        onOpenChange={(open) => { if (!open) setConnectId(null); }}
        onConnected={() => { void instances.refetch(); }}
      />

      {configInstance && (
        <InstanceConfigDrawer
          instance={configInstance}
          open={!!configId}
          onOpenChange={(open) => { if (!open) setConfigId(null); }}
        />
      )}
    </div>
  );
}
