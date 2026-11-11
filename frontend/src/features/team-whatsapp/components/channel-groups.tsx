import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { liveBlock } from '../channel-availability';
import { channelNumber, type ChannelGroupsResult, type ChannelGroupView } from '../channel-groups';

export const UNVERIFIED_TEXT = 'Não foi possível conferir o número. Tente de novo';

const WARNING_CLASS = 'space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm';

const peopleText = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

/** Hora da conferência no relógio de quem está na tela. */
const checkedAtText = (iso: string) => `conferido às ${new Date(iso).toLocaleTimeString('pt-BR', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})}`;

function groupText({ channel, sectors }: ChannelGroupView): string {
  const parts = sectors.map((s) => `${s.name}, ${peopleText(s.count)}`).join('; ');
  return `${parts}, pelo ${channelNumber(channel)}`;
}

function MissingNotice({ names, isAdmin }: { names: string[]; isAdmin: boolean }) {
  return (
    <div role="status" className={WARNING_CLASS}>
      <p className="font-medium">Áreas sem número: {names.join(', ')}</p>
      <p>
        Associe um número a esta área em{' '}
        {isAdmin ? <Link to="/connect" className="underline">Conexões</Link> : 'Conexões'}
      </p>
    </div>
  );
}

/** Sem resposta do provedor (ou da consulta): trava o envio imediato até conferir de novo. */
export function UnverifiedNotice({ onRecheck }: { onRecheck: () => void }) {
  return (
    <div role="status" className={`${WARNING_CLASS} flex items-center justify-between gap-3`}>
      <p>{UNVERIFIED_TEXT}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRecheck}>Conferir de novo</Button>
    </div>
  );
}

export function NoSectorNotice() {
  return <p role="status" className={WARNING_CLASS}>Esta pessoa não tem área.</p>;
}

type Props = { view: ChannelGroupsResult; isAdmin: boolean; onRecheck: () => void };

/** Prévia da divisão do envio por número: quem sai por qual, e o que trava (áreas sem número, número fora do ar). */
export function ChannelGroups({ view, isAdmin, onRecheck }: Props) {
  const { groups, missing } = view;
  const disconnected = groups.filter((g) => liveBlock(g.channel.live.state) === 'disconnected');
  const unverified = groups.some((g) => liveBlock(g.channel.live.state) === 'unverified');
  return (
    <div className="space-y-2">
      {missing.length > 0 && <MissingNotice names={missing.map((m) => m.name)} isAdmin={isAdmin} />}
      {groups.length > 0 && (
        <ul aria-label="Números do envio" className="space-y-1 rounded-md border px-3 py-2 text-sm">
          {groups.map((g) => (
            <li key={g.channel.id} className="flex flex-wrap justify-between gap-2">
              <span>{groupText(g)}</span>
              <span className="text-xs text-muted-foreground">{checkedAtText(g.channel.live.checkedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {disconnected.map((g) => (
        <p key={g.channel.id} role="status" className={WARNING_CLASS}>
          O número {channelNumber(g.channel)} está desconectado. Áreas: {g.sectors.map((s) => s.name).join(', ')}.
        </p>
      ))}
      {unverified && <UnverifiedNotice onRecheck={onRecheck} />}
    </div>
  );
}
