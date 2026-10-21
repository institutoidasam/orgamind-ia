import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatPhoneBR } from '@/lib/format-phone';
import { shiftLabel } from '@/lib/work-shift';
import {
  canReceive, memberName, selectedIdsIn, unassignedCount, visibleMembers, type ShiftChoice,
} from '../member-filter';
import type { TeamMember, TeamSector } from '../schemas';

type Props = {
  sector: TeamSector;
  choice: ShiftChoice;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onSendAll: () => void;
  onSendSelected: () => void;
};

function MemberRow({ member, checked, onToggle }: { member: TeamMember; checked: boolean; onToggle: () => void }) {
  const name = memberName(member);
  return (
    <li aria-label={name} className="flex items-center gap-3 py-2">
      <Checkbox aria-label={name} checked={checked} disabled={!canReceive(member)} onCheckedChange={onToggle} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-muted-foreground">
          {shiftLabel(member.shift)} · {member.phoneE164 ? formatPhoneBR(member.phoneE164) : 'sem telefone'}
        </p>
      </div>
    </li>
  );
}

function UnassignedNote({ count }: { count: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      {count} pessoa(s) deste setor estão sem turno definido — defina em Usuários
    </p>
  );
}

export function MemberSelection({ sector, choice, selected, onToggle, onToggleAll, onSendAll, onSendSelected }: Props) {
  const visible = visibleMembers(sector, choice);
  const unassigned = unassignedCount(sector);
  const receiving = visible.filter(canReceive).length;
  const marked = selectedIdsIn(visible, selected).length;
  return (
    <section className="space-y-3 rounded-md border p-4" style={{ borderColor: 'var(--border)' }}>
      {choice !== 'ALL' && unassigned > 0 && <UnassignedNote count={unassigned} />}
      {visible.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma pessoa ativa neste setor e turno.</p>}
      <ul className="divide-y">
        {visible.map((m) => (
          <MemberRow key={m.id} member={m} checked={selected.has(m.id)} onToggle={() => onToggle(m.id)} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onToggleAll} disabled={receiving === 0}>Marcar todos</Button>
        <Button disabled={receiving === 0} onClick={onSendAll}>Enviar para todos do turno ({receiving})</Button>
        <Button disabled={marked === 0} onClick={onSendSelected}>Enviar para selecionados ({marked})</Button>
      </div>
    </section>
  );
}
