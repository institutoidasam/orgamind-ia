import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PersonHistoryDialog } from '@/features/audit-trail/components/person-history-dialog';
import { AuthorizationBadge } from '@/features/people-record/components/authorization-badge';
import { PersonStatusDialog } from '@/features/people-record/components/person-status-dialog';
import { canChangePersonStatusUi, canViewPersonHistoryUi } from '@/features/people-record/ui-policy';
import { NO_SHIFT_LABEL } from '@/features/shifts/labels';
import type { UserRole } from '@/features/users/role';
import { useAuthStore } from '@/stores/auth.store';
import { useRemoveSectorPerson, useSetSectorPersonStatus } from '../api';
import { toastSectorPeopleError } from '../error-messages';
import type { SectorPerson } from '../schemas';
import { useRefreshAuditTrail } from './audit-trail-refresh';

type Props = {
  sectorId: string;
  people: SectorPerson[];
  onEdit: (person: SectorPerson) => void;
};

type RowDialog = { kind: 'status' | 'history'; person: SectorPerson };

type RowActions = {
  onEdit: (person: SectorPerson) => void;
  onRemove: (person: SectorPerson) => void;
  onStatus: (person: SectorPerson) => void;
  onHistory: (person: SectorPerson) => void;
};

function useRemovePerson(sectorId: string) {
  const remove = useRemoveSectorPerson(sectorId);
  const refreshTrail = useRefreshAuditTrail();
  return async (person: SectorPerson) => {
    try {
      await remove.mutateAsync(person.id);
      void refreshTrail();
      toast.success(`${person.name} saiu do setor.`);
    } catch (error) {
      await toastSectorPeopleError(error);
    }
  };
}

/** Os botões vêm de `ui-policy.ts` (GC5), só para esconder; a API decide de verdade. */
function PersonActions({ person, role, actions }: { person: SectorPerson; role: UserRole | undefined; actions: RowActions }) {
  const canStatus = role !== undefined && canChangePersonStatusUi(role, person);
  const canHistory = role !== undefined && canViewPersonHistoryUi(role);
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => actions.onEdit(person)}>Editar</Button>
      {canHistory && <Button size="sm" variant="ghost" onClick={() => actions.onHistory(person)}>Histórico</Button>}
      {canStatus && (
        <Button size="sm" variant="ghost" onClick={() => actions.onStatus(person)}>{person.isActive ? 'Inativar' : 'Reativar'}</Button>
      )}
      {!person.hasAccess && <Button size="sm" variant="ghost" onClick={() => actions.onRemove(person)}>Tirar do setor</Button>}
    </div>
  );
}

type RowProps = { person: SectorPerson; role: UserRole | undefined; actions: RowActions };

function NameCell({ person }: { person: SectorPerson }) {
  return (
    <TableCell className="font-medium">
      <div>{person.name}</div>
      <div className="mt-1 flex flex-wrap gap-1 font-normal">
        {!person.isActive && <Badge variant="outline">Inativo</Badge>}
        <AuthorizationBadge authorization={person.contactAuthorization} />
      </div>
    </TableCell>
  );
}

function AccessCell({ hasAccess }: { hasAccess: boolean }) {
  return (
    <TableCell>
      <Badge variant={hasAccess ? 'secondary' : 'outline'}>{hasAccess ? 'Com acesso' : 'Sem acesso'}</Badge>
    </TableCell>
  );
}

function PersonRow({ person, role, actions }: RowProps) {
  return (
    <TableRow className={person.isActive ? undefined : 'text-muted-foreground'}>
      <NameCell person={person} />
      <TableCell>{person.registration ?? '—'}</TableCell>
      <TableCell>{person.level?.name ?? 'Sem nível'}</TableCell>
      <TableCell>{person.jobTitle ?? '—'}</TableCell>
      <TableCell>{person.shift?.name ?? NO_SHIFT_LABEL}</TableCell>
      <AccessCell hasAccess={person.hasAccess} />
      <TableCell>
        <PersonActions person={person} role={role} actions={actions} />
      </TableCell>
    </TableRow>
  );
}

type DialogsProps = { sectorId: string; dialog: RowDialog | null; onClose: () => void };

/** Histórico ou confirmação com motivo; falha da API aparece dentro do diálogo de motivo (spec A3). */
function PersonDialogs({ sectorId, dialog, onClose }: DialogsProps) {
  const setStatus = useSetSectorPersonStatus(sectorId);
  const refreshTrail = useRefreshAuditTrail();
  if (!dialog) return null;
  const { person } = dialog;
  const onOpenChange = (open: boolean) => !open && onClose();
  if (dialog.kind === 'history') {
    return <PersonHistoryDialog person={{ id: person.id, name: person.name }} open onOpenChange={onOpenChange} />;
  }
  const confirm = async (reason: string) => {
    await setStatus.mutateAsync({ userId: person.id, isActive: !person.isActive, reason });
    void refreshTrail();
    toast.success(`Cadastro de ${person.name} ${person.isActive ? 'inativado' : 'reativado'}.`);
  };
  return <PersonStatusDialog person={person} open onOpenChange={onOpenChange} onConfirm={confirm} />;
}

export function PeopleTable({ sectorId, people, onEdit }: Props) {
  const role = useAuthStore((state) => state.user?.role);
  const onRemove = useRemovePerson(sectorId);
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const actions: RowActions = {
    onEdit,
    onRemove,
    onStatus: (person) => setDialog({ kind: 'status', person }),
    onHistory: (person) => setDialog({ kind: 'history', person }),
  };
  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Matrícula</TableHead>
              <TableHead>Nível</TableHead>
              <TableHead>Função</TableHead>
              <TableHead>Turno</TableHead>
              <TableHead>Acesso ao sistema</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((person) => (
              <PersonRow key={person.id} person={person} role={role} actions={actions} />
            ))}
          </TableBody>
        </Table>
      </div>
      <PersonDialogs sectorId={sectorId} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
