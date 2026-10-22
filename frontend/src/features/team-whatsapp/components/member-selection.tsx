import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { formatPhoneBR } from '@/lib/format-phone';
import { OFF_REASON_LABEL } from '../error-messages';
import { ALL_SHIFTS, canReceive, memberName, selectedIdsIn, type ShiftChoice } from '../member-filter';
import type { RosterMember } from '../schemas';

type ShiftNames = ReadonlyMap<string, string>;

/** Um setor da lista conferida; `visible`, `off` e `noSchedule` já passaram pelo filtro de nível. */
export type SectorGroup = {
  sectorId: string;
  name: string;
  /** Setor sem ninguém ativo no cadastro. */
  empty: boolean;
  /** Escalados na lista (já filtrados por turno e `includeOff`). */
  visible: readonly RosterMember[];
  /** Grupo informativo "De folga". */
  off: readonly RosterMember[];
  noSchedule: number;
};

type Props = {
  choice: ShiftChoice;
  groups: readonly SectorGroup[];
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
        <p className="font-medium">{member.level ? `${name} · ${member.level.name}` : name}</p>
        <p className="text-sm text-muted-foreground">{subtitle(member, shiftNames)}</p>
      </div>
    </li>
  );
}

type InfoGroupProps = { title: string; label: string; people: readonly RosterMember[]; shiftNames: ShiftNames };

function InfoGroup({ title, label, people, shiftNames }: InfoGroupProps) {
  if (people.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <ul aria-label={label} className="divide-y">
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

type GroupProps = {
  group: SectorGroup;
  /** Com mais de um setor, cada grupo tem título e listas com o nome do setor. */
  multi: boolean;
  shiftNames: ShiftNames;
  includeOff: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
};

function EmptySector({ sectorId }: { sectorId: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      Ninguém neste setor ainda.{' '}
      <Link to="/setores/$sectorId" params={{ sectorId }} className="underline">Adicionar pessoas</Link>
    </p>
  );
}

function SectorMembers({ group, multi, shiftNames, includeOff, selected, onToggle }: GroupProps) {
  const { visible, off } = group;
  const named = (title: string) => (multi ? `${title} · ${group.name}` : title);
  return (
    <div className="space-y-3">
      {multi && <h3 className="text-sm font-semibold">{group.name}</h3>}
      {group.noSchedule > 0 && <NoScheduleNote count={group.noSchedule} />}
      {group.empty && <EmptySector sectorId={group.sectorId} />}
      {!group.empty && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">Ninguém escalado neste setor, data e turno.</p>
      )}
      <ul aria-label={named('Escalados')} className="divide-y">
        {visible.filter(canReceive).map((m) => (
          <PersonRow
            key={m.id} member={m} shiftNames={shiftNames}
            check={{ checked: selected.has(m.id), onToggle: () => onToggle(m.id) }}
          />
        ))}
      </ul>
      <InfoGroup title="Sem telefone" label={named('Sem telefone')} people={visible.filter((m) => !canReceive(m))} shiftNames={shiftNames} />
      {!includeOff && <InfoGroup title="De folga" label={named('De folga')} people={off} shiftNames={shiftNames} />}
    </div>
  );
}

export function MemberSelection(props: Props) {
  const { choice, groups, includeOff, shiftNames, selected, onToggle } = props;
  const visible = groups.flatMap((g) => g.visible);
  const receiving = visible.filter(canReceive);
  const marked = selectedIdsIn(visible, selected).length;
  return (
    <section className="space-y-3 rounded-md border p-4" style={{ borderColor: 'var(--border)' }}>
      {choice === ALL_SHIFTS && <IncludeOffToggle checked={includeOff} onChange={props.onToggleOff} />}
      {groups.map((g) => (
        <SectorMembers
          key={g.sectorId} group={g} multi={groups.length > 1} shiftNames={shiftNames}
          includeOff={includeOff} selected={selected} onToggle={onToggle}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={props.onToggleAll} disabled={receiving.length === 0}>Marcar todos</Button>
        <Button disabled={receiving.length === 0} onClick={props.onSendAll}>Enviar para todos ({receiving.length})</Button>
        <Button disabled={marked === 0} onClick={props.onSendSelected}>Enviar para selecionados ({marked})</Button>
      </div>
    </section>
  );
}
