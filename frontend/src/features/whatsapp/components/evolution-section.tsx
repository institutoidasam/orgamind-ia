import { useState } from 'react';
import { toast } from 'sonner';
import {
  useInstances,
  useDeleteInstance,
  useSetDefaultInstance,
  useRestartInstance,
} from '../api';
import { InstancesList, type Action } from './instances-list';
import { CreateInstanceDialog } from './create-instance-dialog';
import { ConnectInstanceDialog } from './connect-instance-dialog';
import { InstanceConfigDrawer } from './instance-config-drawer';
import { EditChannelSectorsDialog } from './edit-channel-sectors-dialog';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { extractApiError } from '@/lib/api-error';
import type { Instance } from '../schemas';

/**
 * The EVOLUTION provider section of the Canais page — the per-instance QR
 * connection flow (list, create, connect, restart, config, remove). Unchanged
 * from the pre-multi-provider "Conectar" page; the multi-provider work simply
 * lifted it into its own section so cloud providers (Twilio/Zernio) can sit
 * alongside it. Cloud providers have no QR/restart concept, so those actions
 * live here and nowhere else.
 */
function useDialogTargets() {
  const [createOpen, setCreateOpen] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [sectorsId, setSectorsId] = useState<string | null>(null);
  /** Abre o diálogo da ação, se ela tem um; `false` para as ações que mutam. */
  const open = (a: Action) => {
    if (a.kind === 'create') setCreateOpen(true);
    else if (a.kind === 'connect') setConnectId(a.id);
    else if (a.kind === 'config') setConfigId(a.id);
    else if (a.kind === 'sectors') setSectorsId(a.id);
    else return false;
    return true;
  };
  return { createOpen, setCreateOpen, connectId, setConnectId, configId, setConfigId, sectorsId, setSectorsId, open };
}

async function attempt(task: () => Promise<unknown>, success: string) {
  try {
    await task();
    toast.success(success);
  } catch (err) {
    const { title, message } = await extractApiError(err);
    toast.error(title, { description: message });
  }
}

function useMutationActions() {
  const del = useDeleteInstance();
  const setDefault = useSetDefaultInstance();
  const restart = useRestartInstance();
  return async (a: Action) => {
    if (a.kind === 'remove') await attempt(() => del.mutateAsync(a.id), 'Conexão removida');
    else if (a.kind === 'setDefault') await attempt(() => setDefault.mutateAsync(a.id), 'Padrão atualizado');
    else if (a.kind === 'restart') {
      try {
        await restart.mutateAsync(a.id);
        toast.success('Reiniciando…');
      } catch {
        toast.error('Falha ao reiniciar');
      }
    }
  };
}

export function EvolutionSection({ role }: { role: 'ADMIN' | 'OPERATOR' }) {
  const instances = useInstances();
  const targets = useDialogTargets();
  const mutate = useMutationActions();

  if (instances.isError) {
    return <QueryErrorFallback error={instances.error} onRetry={() => instances.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <InstancesList
        instances={instances.data ?? []}
        role={role}
        isInstanceOnline={(i) => i.lastConnectionState === 'open'}
        onAction={async (a) => {
          if (!targets.open(a)) await mutate(a);
        }}
      />
      <EvolutionDialogs
        instances={instances.data ?? []}
        targets={targets}
        isAdmin={role === 'ADMIN'}
        onChanged={() => { void instances.refetch(); }}
      />
    </div>
  );
}

type DialogsProps = {
  instances: Instance[];
  targets: ReturnType<typeof useDialogTargets>;
  isAdmin: boolean;
  onChanged: () => void;
};

function EvolutionDialogs({ instances, targets, isAdmin, onChanged }: DialogsProps) {
  const find = (id: string | null) => instances.find((i) => i.id === id);
  const configInstance = find(targets.configId);
  const sectorsInstance = find(targets.sectorsId) ?? null;
  return (
    <>
      <CreateInstanceDialog open={targets.createOpen} onOpenChange={targets.setCreateOpen} onCreated={onChanged} />

      <ConnectInstanceDialog
        instanceId={targets.connectId}
        instanceName={find(targets.connectId)?.name ?? 'conexão'}
        open={!!targets.connectId}
        onOpenChange={(open) => { if (!open) targets.setConnectId(null); }}
        onConnected={onChanged}
      />

      {configInstance && (
        <InstanceConfigDrawer
          instance={configInstance}
          open={!!targets.configId}
          onOpenChange={(open) => { if (!open) targets.setConfigId(null); }}
        />
      )}

      {isAdmin && (
        <EditChannelSectorsDialog
          channel={sectorsInstance}
          open={sectorsInstance !== null}
          onOpenChange={(open) => { if (!open) targets.setSectorsId(null); }}
        />
      )}
    </>
  );
}
