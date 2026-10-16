import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPhoneBR } from '@/lib/format-phone';
import type { SendTarget, TeamMember, TeamSector } from '../schemas';

type Props = { sector: TeamSector; onSend: (target: SendTarget) => void };

const canReceive = (m: TeamMember) => m.isActive && !!m.phoneE164;
const memberName = (m: TeamMember) => m.name ?? m.email;

function MemberRow({ member, onSend }: { member: TeamMember; onSend: () => void }) {
  return (
    <li aria-label={memberName(member)} className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium">{memberName(member)}</p>
        <p className="text-sm text-muted-foreground">
          {member.phoneE164 ? formatPhoneBR(member.phoneE164) : 'sem telefone'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {!member.isActive && <Badge variant="outline">Inativo</Badge>}
        <Button size="sm" variant="outline" disabled={!canReceive(member)} onClick={onSend}>Enviar</Button>
      </div>
    </li>
  );
}

export function TeamSectorCard({ sector, onSend }: Props) {
  const recipientCount = sector.members.filter(canReceive).length;
  return (
    <section className="rounded-md border p-4" style={{ borderColor: 'var(--border)' }}>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{sector.name}</h2>
          <p className="text-xs text-muted-foreground">{sector.code}</p>
        </div>
        <Button
          disabled={recipientCount === 0}
          onClick={() => onSend({ type: 'sector', sectorId: sector.id, label: sector.name, recipientCount })}
        >
          Enviar ao setor
        </Button>
      </header>
      <ul className="mt-3 divide-y">
        {sector.members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            onSend={() => onSend({ type: 'user', userId: m.id, label: memberName(m) })}
          />
        ))}
      </ul>
    </section>
  );
}
