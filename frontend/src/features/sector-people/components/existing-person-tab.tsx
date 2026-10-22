import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth.store';
import { useMoveSectorPeople, useSectorPersonCandidates } from '../api';
import { addedPeopleMessage, toastSectorPeopleError } from '../error-messages';
import type { SectorPersonCandidate } from '../schemas';
import { SearchFallback, SearchField } from './search-field';
import { toggleBy, useDebouncedSearch } from './search-state';

type Props = { sectorId: string; onDone: () => void };

function PersonRow({ person, checked, onToggle }: { person: SectorPersonCandidate; checked: boolean; onToggle: (checked: boolean) => void }) {
  const id = `candidate-${person.id}`;
  return (
    <li className="flex items-center gap-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onToggle(value === true)} />
      <Label htmlFor={id} className="flex-1">{person.name}</Label>
      {person.hasAccess && <span className="text-xs text-muted-foreground">Com acesso</span>}
      <span className="text-xs text-muted-foreground">{person.sector?.name ?? 'Sem setor'}</span>
    </li>
  );
}

/** Quem está em outro setor só muda depois do "<nome> sai de <setor>" confirmado. */
function Confirmation({ leaving, pending, onBack, onConfirm }: { leaving: SectorPersonCandidate[]; pending: boolean; onBack: () => void; onConfirm: () => void }) {
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <ul className="space-y-1">
        {leaving.map((person) => (
          <li key={person.id}>{`${person.name} sai de ${person.sector?.name}`}</li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>Voltar</Button>
        <Button disabled={pending} onClick={onConfirm}>Confirmar</Button>
      </div>
    </div>
  );
}

/** Seleção e mudança; quem sai de outro setor passa antes pela confirmação. */
function useMoveSelection(sectorId: string, onDone: () => void) {
  const move = useMoveSectorPeople(sectorId);
  const [selected, setSelected] = useState<SectorPersonCandidate[]>([]);
  const [confirming, setConfirming] = useState(false);
  const leaving = selected.filter((person) => person.sector !== null);

  const run = async () => {
    try {
      const { moved } = await move.mutateAsync(selected.map((person) => person.id));
      toast.success(addedPeopleMessage(moved.length));
      onDone();
    } catch (error) {
      setConfirming(false);
      await toastSectorPeopleError(error);
    }
  };
  const toggle = (person: SectorPersonCandidate, checked: boolean) => {
    setConfirming(false);
    setSelected((current) => toggleBy(current, person, (item) => item.id === person.id, checked));
  };
  const submit = () => (leaving.length > 0 ? setConfirming(true) : run());
  return { selected, leaving, confirming, setConfirming, run, toggle, submit, pending: move.isPending };
}

/** Pessoa que já existe (sem setor, ou de outro setor para o ADMIN) muda para este setor. */
export function ExistingPersonTab({ sectorId, onDone }: Props) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'ADMIN');
  const search = useDebouncedSearch();
  const candidates = useSectorPersonCandidates(sectorId, search.q);
  const move = useMoveSelection(sectorId, onDone);
  const items = candidates.data?.items ?? [];

  return (
    <div className="space-y-4">
      {!isAdmin && <p className="text-xs text-muted-foreground">Você vê só quem está sem setor.</p>}
      <SearchField label="Buscar pessoa por nome" value={search.text} onChange={search.setText} />
      <SearchFallback isError={candidates.isError} isPending={candidates.isPending} count={items.length} emptyText="Nenhuma pessoa encontrada." />
      {items.length > 0 && (
        <ul className="max-h-64 divide-y overflow-y-auto">
          {items.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              checked={move.selected.some((item) => item.id === person.id)}
              onToggle={(checked) => move.toggle(person, checked)}
            />
          ))}
        </ul>
      )}
      {move.confirming ? (
        <Confirmation leaving={move.leaving} pending={move.pending} onBack={() => move.setConfirming(false)} onConfirm={move.run} />
      ) : (
        <div className="flex justify-end">
          <Button disabled={move.selected.length === 0 || move.pending} onClick={move.submit}>
            Adicionar ({move.selected.length})
          </Button>
        </div>
      )}
    </div>
  );
}
