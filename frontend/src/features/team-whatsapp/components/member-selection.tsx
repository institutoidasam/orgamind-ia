import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EXCLUSION_LABEL } from '../labels';
import {
  leftOutByReason, markableIds, markedReceiving, receivingByArea, unselectedPeople, type AreaGroup,
} from '../member-filter';
import type { TeamAudiencePerson, TeamAudiencePreview, TeamExclusionReason } from '../schemas';
import { ExcludedGroups } from './excluded-groups';

type Props = {
  /** Prévia do servidor: de onde vêm as pessoas e os motivos. */
  preview: TeamAudiencePreview;
  /** A prévia é a do corpo atual; sem isso a lista fica na tela, mas os botões de enviar travam. */
  isFresh: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onSendAll: () => void;
  onSendSelected: () => void;
};

type RowProps = {
  /** `reason` só nas linhas de quem ficou de fora: o motivo entra no subtítulo. */
  person: TeamAudiencePerson & { phone?: string | null; reason?: TeamExclusionReason };
  /** Ausente = linha informativa, sem caixa de marcar. */
  check?: { checked: boolean; onToggle: () => void };
};

/** Setor, turno, nível, o telefone como o servidor o devolveu (mascarado ou não, sem reformatar) e, se há, o motivo. */
const subtitle = ({ sectorName, shiftName, levelName, phone, reason }: RowProps['person']): string =>
  [sectorName, shiftName, levelName, phone, reason && EXCLUSION_LABEL[reason]].filter(Boolean).join(' · ');

function PersonRow({ person, check }: RowProps) {
  return (
    <li aria-label={person.name} className="flex items-center gap-3 py-2">
      {check && <Checkbox aria-label={person.name} checked={check.checked} onCheckedChange={check.onToggle} />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{person.name}</p>
        <p className="text-sm text-muted-foreground">{subtitle(person)}</p>
      </div>
    </li>
  );
}

type ListProps = Pick<Props, 'selected' | 'onToggle'> & { label: string; people: readonly RowProps['person'][] };

function MarkableList({ label, people, selected, onToggle }: ListProps) {
  return (
    <ul aria-label={label} className="divide-y">
      {people.map((p) => (
        <PersonRow key={p.userId} person={p} check={{ checked: selected.has(p.userId), onToggle: () => onToggle(p.userId) }} />
      ))}
    </ul>
  );
}

type AreaProps = Pick<Props, 'selected' | 'onToggle'> & {
  group: AreaGroup;
  multi: boolean;
  /** Há "Não selecionado" nesta área: a lista está vazia só porque há seleção, não porque falta gente. */
  hasUnselected: boolean;
};

function AreaPeople({ group, multi, hasUnselected, selected, onToggle }: AreaProps) {
  return (
    <div className="space-y-2">
      {multi && <h3 className="text-sm font-semibold">{group.name}</h3>}
      {group.people.length === 0 ? (
        !hasUnselected && <p className="text-sm text-muted-foreground">Ninguém neste setor, data e turno.</p>
      ) : (
        <MarkableList
          label={multi ? `Vão receber · ${group.name}` : 'Vão receber'}
          people={group.people} selected={selected} onToggle={onToggle}
        />
      )}
    </div>
  );
}

/** Quem só ficou de fora porque há seleção: continua na tela para ser marcado (a lista não encolhe a cada clique). */
function Unselected({ people, selected, onToggle }: Pick<ListProps, 'people' | 'selected' | 'onToggle'>) {
  if (people.length === 0) return null;
  const title = `${EXCLUSION_LABEL.not_selected} (${people.length})`;
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <MarkableList label={EXCLUSION_LABEL.not_selected} people={people} selected={selected} onToggle={onToggle} />
    </div>
  );
}

/**
 * Quem foi marcado e depois ficou de fora (Férias, Folga...): a seleção ainda o guarda, então a caixa fica,
 * marcada, só para desmarcar. Nunca se marca quem está de fora (C3).
 */
function MarkedLeftOut({ people, selected, onToggle }: Pick<ListProps, 'people' | 'selected' | 'onToggle'>) {
  if (people.length === 0) return null;
  const title = 'Marcados que ficam de fora';
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{`${title} (${people.length})`}</h3>
      <MarkableList label={title} people={people} selected={selected} onToggle={onToggle} />
    </div>
  );
}

export function MemberSelection(props: Props) {
  const { preview, isFresh, selected, onToggle } = props;
  const { included } = preview;
  const groups = receivingByArea(preview);
  const unselected = unselectedPeople(preview);
  const leftOut = leftOutByReason(preview);
  const marked = markedReceiving(included, selected).length;
  const selecting = selected.size > 0;
  return (
    <section className="space-y-3 rounded-md border p-4" style={{ borderColor: 'var(--border)' }}>
      <h2 className="text-sm font-semibold">Vão receber ({included.length})</h2>
      {groups.map((g) => (
        <AreaPeople
          key={g.sectorId} group={g} multi={groups.length > 1} selected={selected} onToggle={onToggle}
          hasUnselected={unselected.some((p) => p.sectorId === g.sectorId)}
        />
      ))}
      <Unselected people={unselected} selected={selected} onToggle={onToggle} />
      <MarkedLeftOut people={leftOut.filter((p) => selected.has(p.userId))} selected={selected} onToggle={onToggle} />
      <ExcludedGroups excluded={leftOut} title="Ficam de fora" />
      {!isFresh && <p className="text-sm text-muted-foreground">Atualizando a lista…</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={props.onToggleAll} disabled={markableIds(preview).length === 0}>Marcar todos</Button>
        <Button
          disabled={!isFresh || selecting || included.length === 0} onClick={props.onSendAll}
          title={selecting ? 'Desmarque as pessoas para enviar a todos.' : undefined}
        >
          {selecting ? 'Enviar para todos' : `Enviar para todos (${included.length})`}
        </Button>
        <Button disabled={!isFresh || marked === 0} onClick={props.onSendSelected}>Enviar para selecionados ({marked})</Button>
      </div>
    </section>
  );
}
