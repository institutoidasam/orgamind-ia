import { Link } from '@tanstack/react-router';
import { AlertCircle, CircleCheck, Clock3, Inbox, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CommunicationDetail, DemandStatus, Priority } from '../schemas';
import { civilDate, personName } from '../utils';

export function StatusBadge({ status, priority }: { status?: DemandStatus | null; priority?: Priority | null }) {
  const text = status === 'OPEN' ? 'Aberta' : status === 'IN_PROGRESS' ? 'Em andamento' : status === 'WAITING' ? 'Aguardando' : status === 'COMPLETED' ? 'Concluída' : 'Publicado';
  const variant = status === 'COMPLETED' ? 'secondary' : priority === 'URGENT' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{text}</Badge>;
}

export function PageError({ title = 'Não foi possível carregar os dados.', retry }: { title?: string; retry: () => void }) {
  return <Card><CardContent className="flex items-center gap-3 pt-4"><AlertCircle className="text-destructive" /><div><p className="font-medium">{title}</p><Button className="mt-2" size="sm" variant="outline" onClick={retry}>Tentar novamente</Button></div></CardContent></Card>;
}

export function EmptyState({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <Card><CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 pt-4 text-center text-muted-foreground"><Inbox className="size-7" />{children}{action}</CardContent></Card>;
}

export function CommunicationRow({ item, to }: { item: CommunicationDetail; to: string }) {
  return <Link to={to as never} params={{ communicationId: item.id } as never} className="block rounded-lg border bg-card p-3 transition hover:border-[var(--brand-orange)]">
    <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{item.subject}</p><p className="text-xs text-muted-foreground">{item.originSector.name} → {item.destinationSector.name} · {item.reference}</p></div>{item.isUnread ? <span aria-label="Não lida" className="mt-1 size-2 rounded-full bg-[var(--brand-orange)]" /> : null}</div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={item.status} priority={item.priority} />{item.assignee ? <span className="text-xs text-muted-foreground">{personName(item.assignee)}</span> : null}{item.dueDate ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3" />{civilDate(item.dueDate)}</span> : null}</div>
  </Link>;
}

export function Header({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold tracking-widest text-[var(--brand-orange)] uppercase">{eyebrow}</p><h1 className="font-heading text-2xl text-foreground">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{action}</div>;
}

export function ReadOnlyNotice() { return <p className="rounded-md border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/10 p-3 text-sm">Seu perfil permite consulta e marcação de leitura.</p>; }

export function SaveButton({ saving, children = 'Salvar', onClick }: { saving: boolean; children?: React.ReactNode; onClick?: () => void }) { return <Button disabled={saving} type="button" onClick={onClick}>{saving ? <><Send className="size-4 animate-pulse" />Enviando…</> : <><CircleCheck className="size-4" />{children}</>}</Button>; }
