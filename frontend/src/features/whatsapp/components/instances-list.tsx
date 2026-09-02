import { useState } from 'react';
import { Plus } from 'lucide-react';
import { InstanceRow } from './instance-row';
import type { Instance } from '../schemas';
import { Button } from '@/components/ui/button';

export type Action =
  | { kind: 'create' }
  | { kind: 'connect'; id: string }
  | { kind: 'config'; id: string }
  | { kind: 'restart'; id: string }
  | { kind: 'setDefault'; id: string }
  | { kind: 'remove'; id: string };

type Props = {
  instances: Instance[];
  role: 'ADMIN' | 'OPERATOR';
  isInstanceOnline?: (i: Instance) => boolean;
  onAction: (a: Action) => void;
};

export function InstancesList({
  instances,
  role,
  isInstanceOnline,
  onAction,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(instances[0]?.id ?? null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="ds-display !text-3xl">Conexões</h2>
        {role === 'ADMIN' && (
          <Button onClick={() => onAction({ kind: 'create' })}>
            <Plus className="mr-2 size-4" /> Nova conexão
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {instances.map((i) => (
          <InstanceRow
            key={i.id}
            instance={i}
            isExpanded={expandedId === i.id}
            isOnline={isInstanceOnline?.(i) ?? false}
            isAdmin={role === 'ADMIN'}
            onToggle={() => setExpandedId((cur) => (cur === i.id ? null : i.id))}
            onConnect={() => onAction({ kind: 'connect', id: i.id })}
            onSetDefault={() => onAction({ kind: 'setDefault', id: i.id })}
            onRestart={() => onAction({ kind: 'restart', id: i.id })}
            onRemove={() => onAction({ kind: 'remove', id: i.id })}
            onOpenConfig={() => onAction({ kind: 'config', id: i.id })}
          />
        ))}
      </div>
    </div>
  );
}
