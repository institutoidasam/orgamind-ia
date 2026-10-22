import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { LevelSelect } from '@/features/users/components/level-select';
import { formatPhoneBR } from '@/lib/format-phone';
import { useAddPeopleFromContacts, useSectorContactCandidates } from '../api';
import { addedPeopleMessage, FAILURE_REASON_MESSAGES, toastSectorPeopleError } from '../error-messages';
import type { SectorContactCandidate, SectorPeopleFailureReason } from '../schemas';
import { SearchFallback, SearchField } from './search-field';
import { toggleBy, useDebouncedSearch } from './search-state';
import { RequiredShiftSelect } from './shift-field';
import type { AddTabProps } from './new-person-tab';

type Failure = { contactId: string; reason: SectorPeopleFailureReason };

/** D11: contato sem nome aparece pelo número. */
const contactTitle = (contact: SectorContactCandidate) => contact.name ?? formatPhoneBR(contact.phoneE164);

function ContactRow({ contact, checked, onToggle }: { contact: SectorContactCandidate; checked: boolean; onToggle: (checked: boolean) => void }) {
  const id = `contact-${contact.contactId}`;
  const { person } = contact;
  return (
    <li className="flex items-center gap-3 py-2">
      <Checkbox id={id} checked={checked} disabled={person !== null} onCheckedChange={(value) => onToggle(value === true)} />
      <div className="min-w-0 flex-1">
        <Label htmlFor={id}>{contactTitle(contact)}</Label>
        {contact.name && <p className="text-xs text-muted-foreground">{formatPhoneBR(contact.phoneE164)}</p>}
      </div>
      {person && <span className="text-xs text-muted-foreground">já é {person.name} · {person.sectorName ?? 'Sem setor'}</span>}
    </li>
  );
}

/** Só quem continua selecionado: ao desmarcar o contato o aviso dele some. */
function FailureList({ failures, selected }: { failures: Failure[]; selected: SectorContactCandidate[] }) {
  const rows = selected.flatMap((contact) => {
    const failure = failures.find((item) => item.contactId === contact.contactId);
    return failure ? [{ contact, reason: failure.reason }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div role="alert" className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm">
      <p className="font-medium">Não foi possível adicionar:</p>
      <ul className="space-y-1">
        {rows.map(({ contact, reason }) => (
          <li key={contact.contactId} className="flex justify-between gap-3">
            <span>{contactTitle(contact)}</span>
            <span className="text-destructive">{FAILURE_REASON_MESSAGES[reason]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Seleção e envio do lote; o que falhou fica selecionado, com o motivo (D10). */
function useContactsBatch(sectorId: string, onDone: () => void) {
  const add = useAddPeopleFromContacts(sectorId);
  const [selected, setSelected] = useState<SectorContactCandidate[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [levelId, setLevelId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState('');

  const submit = async () => {
    try {
      const result = await add.mutateAsync({ contactIds: selected.map((contact) => contact.contactId), levelId, shiftId });
      if (result.created.length > 0) toast.success(addedPeopleMessage(result.created.length));
      if (result.failed.length === 0) return onDone();
      const failedIds = new Set(result.failed.map((item) => item.contactId));
      setSelected((current) => current.filter((contact) => failedIds.has(contact.contactId)));
      setFailures(result.failed);
    } catch (error) {
      await toastSectorPeopleError(error);
    }
  };
  const toggle = (contact: SectorContactCandidate, checked: boolean) =>
    setSelected((current) => toggleBy(current, contact, (item) => item.contactId === contact.contactId, checked));
  const canSubmit = selected.length > 0 && shiftId !== '' && !add.isPending;
  return { selected, failures, levelId, setLevelId, shiftId, setShiftId, submit, toggle, canSubmit };
}

/** Vários contatos viram pessoas deste setor; nível e turno valem para todos (D8). */
export function ContactsTab({ sectorId, options, onDone }: AddTabProps) {
  const search = useDebouncedSearch();
  const candidates = useSectorContactCandidates(sectorId, search.q);
  const batch = useContactsBatch(sectorId, onDone);
  const items = candidates.data?.items ?? [];

  return (
    <div className="space-y-4">
      <SearchField label="Buscar contato por nome ou número" value={search.text} onChange={search.setText} />
      <SearchFallback isError={candidates.isError} isPending={candidates.isPending} count={items.length} emptyText="Nenhum contato encontrado." />
      {items.length > 0 && (
        <ul className="max-h-64 divide-y overflow-y-auto">
          {items.map((contact) => (
            <ContactRow
              key={contact.contactId}
              contact={contact}
              checked={batch.selected.some((item) => item.contactId === contact.contactId)}
              onToggle={(checked) => batch.toggle(contact, checked)}
            />
          ))}
        </ul>
      )}
      <FailureList failures={batch.failures} selected={batch.selected} />
      <div className="grid gap-4 sm:grid-cols-2">
        <LevelSelect value={batch.levelId} onChange={batch.setLevelId} levels={options.levels} />
        <RequiredShiftSelect value={batch.shiftId} onChange={batch.setShiftId} shifts={options.shifts} />
      </div>
      <div className="flex justify-end">
        <Button disabled={!batch.canSubmit} onClick={batch.submit}>
          Adicionar ({batch.selected.length})
        </Button>
      </div>
    </div>
  );
}
