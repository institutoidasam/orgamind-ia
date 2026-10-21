import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { formatPhoneBR } from '@/lib/format-phone';
import { OFF_REASON_LABEL } from '../error-messages';
import { ALL_SHIFTS, canReceive, memberName, selectedIdsIn, type ShiftChoice } from '../member-filter';
import type { RosterMember } from '../schemas';

type ShiftNames = ReadonlyMap<string, string>;

type Props = {
  choice: ShiftChoice;
  /** Escalados na lista (já filtrados por turno e `includeOff`). */
  visible: readonly RosterMember[];
  /** Grupo informativo "De folga". */
  off: readonly RosterMember[];
  noSchedule: number;
  includeOff: boolean;
  shiftNames: ShiftNames;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleOff: (on: boolean) => void;
  onToggleAll: () => void;
  onSendAll: () => void;
  onSendSelected: () => void;
};

function situationLabel({ situation }: RosterMember, shiftNames: ShiftNames): string {
  if (situation.kind === 'OFF') return OFF_REASON_LABEL[situation.reason];
  return situation.kind === 'WORK' ? (shiftNames.get(situation.shiftId) ?? '') : '';
}

function subtitle(member: RosterMember, shiftNames: ShiftNames): string {
  return [
    member.jobTitle,
    situationLabel(member, shiftNames),
    member.fromOtherSector ? 'de outro setor' : null,
    member.phoneE164 ? formatPhoneBR(member.phoneE164) : null,
  ].filter(Boolean).join(' · ');
}

type RowProps = {
  member: RosterMember;
  shiftNames: ShiftNames;
  /** Ausente = linha informativa, sem caixa de seleção. */
  check?: { checked: boolean; onToggle: () => void };
};

function PersonRow({ member, shiftNames, check }: RowProps) {
  const name = memberName(member);
  return (
    <li aria-label={name} className="flex items-center gap-3 py-2">
      {check && <Checkbox aria-label={name} checked={check.checked} onCheckedChange={check.onToggle} />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-muted-foreground">{subtitle(member, shiftNames)}</p>
      </div>
    </li>
  );
}

function InfoGroup({ title, people, shiftNames }: { title: string; people: readonly RosterMember[]; shiftNames: ShiftNames }) {
  if (people.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <ul aria-label={title} className="divide-y">
        {people.map((m) => <PersonRow key={m.id} member={m} shiftNames={shiftNames} />)}
      </ul>
    </div>
  );
}

function NoScheduleNote({ count }: { count: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      {count} pessoa(s) deste setor estão sem escala e sem turno no cadastro — defina em Escala
    </p>
  );
}

function IncludeOffToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id="team-whatsapp-include-off" checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor="team-whatsapp-include-off">incluir quem está de folga</Label>
    </div>
  );
}

export function MemberSelection(props: Props) {
  const { choice, visible, off, includeOff, shiftNames, selected, onToggle } = props;
  const receiving = visible.filter(canReceive);
  const marked = selectedIdsIn(visible, selected).length;
  return (
    <section className="space-y-3 rounded-md border p-4" style={{ borderColor: 'var(--border)' }}>
      {props.noSchedule > 0 && <NoScheduleNote count={props.noSchedule} />}
      {choice === ALL_SHIFTS && <IncludeOffToggle checked={includeOff} onChange={props.onToggleOff} />}
      {visible.length === 0 && <p className="text-sm text-muted-foreground">Ninguém escalado neste setor, data e turno.</p>}
      <ul aria-label="Escalados" className="divide-y">
        {receiving.map((m) => (
          <PersonRow
            key={m.id} member={m} shiftNames={shiftNames}
            check={{ checked: selected.has(m.id), onToggle: () => onToggle(m.id) }}
          />
        ))}
      </ul>
      <InfoGroup title="Sem telefone" people={visible.filter((m) => !canReceive(m))} shiftNames={shiftNames} />
      {!includeOff && <InfoGroup title="De folga" people={off} shiftNames={shiftNames} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={props.onToggleAll} disabled={receiving.length === 0}>Marcar todos</Button>
        <Button disabled={receiving.length === 0} onClick={props.onSendAll}>Enviar para todos ({receiving.length})</Button>
        <Button disabled={marked === 0} onClick={props.onSendSelected}>Enviar para selecionados ({marked})</Button>
      </div>
    </section>
  );
}
