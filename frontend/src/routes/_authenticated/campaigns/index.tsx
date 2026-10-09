import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useCampaigns,
  useDeleteCampaign,
  useDependentSegments,
} from '@/features/campaigns/api';
import type { CampaignSummary } from '@/features/campaigns/schemas';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { extractApiError } from '@/lib/api-error';
import { statusDoOperador, textoDaLinha } from '@/features/campaigns/list-progress';
import { horaDoReset, quotaRestante } from '@/features/campaigns/channel-quota';
// A.6 — o canal da linha vem de `useProviders()` (GET /whatsapp/providers,
// TODO provedor), não de `useInstances()` (só EVOLUTION): a lista tem de
// mostrar "Aguardando teto"/"aguardando canal" também para GOZAP (produção),
// ZERNIO, TWILIO e META, não só para o provedor legado. Mesma regra de
// `resolveCampaignChannel` usada pelo cabeçalho de progresso (T15).
import { useProviders } from '@/features/whatsapp/api';
import { resolveCampaignChannel } from '@/features/campaigns/resolve-channel';

/**
 * Quantas linhas de Message a campanha tem — TODAS elas, não só as "de sucesso".
 *
 * É este o número do aviso de exclusão, porque é este o número de bolhas que
 * somem do inbox: `Message.campaignId -> Campaign` é `onDelete: Cascade`, e a
 * mesma Message é a bolha da conversa (`Message.conversationId`).
 *
 * Somar `statusCounts` inteiro (e não uma lista fixa de status) é de propósito:
 * um status novo no enum entraria na conta sozinho, em vez de ser silenciosamente
 * omitido do aviso — e um aviso que subconta é pior que não avisar.
 */
function messageCountOf(c: CampaignSummary): number {
  return (c.statusCounts ?? []).reduce((total, s) => total + s._count, 0);
}

/**
 * Campanha EM VOO não pode ser apagada: os jobs já enfileirados no BullMQ
 * ficariam apontando para Message que o Cascade acabou de remover. O backend
 * recusa (`campaign.in_flight`); a tela não oferece o botão. Cancele antes.
 */
function canDelete(c: CampaignSummary): boolean {
  return c.status !== 'RUNNING' && c.status !== 'QUEUED';
}

/**
 * O botão de apagar + a confirmação que DIZ O ESTRAGO.
 *
 * O aviso não é decoração: apagar uma campanha que enviou de verdade arranca as
 * bolhas dela das conversas do inbox — o contato responde a uma mensagem que o
 * operador não vê mais. Um "tem certeza?" genérico não informa isso. O diálogo
 * mostra o número de mensagens e diz, com todas as letras, o que NÃO é afetado
 * (os consentimentos), que é a dúvida que trava o operador na hora de limpar a
 * base de testes.
 *
 * F1 T9 — o mesmo CASCADE que apaga as Message apaga o REGISTRO de quem já
 * recebeu esta campanha, que é exatamente o que os filtros/Segmentos
 * "excluir quem já recebeu" (history, F1 T7) leem. O diálogo agora diz isso
 * também, e busca (só enquanto está aberto) os Segmentos que citam esta
 * campanha nesse filtro — se o backend achar algum, a lista aparece; sem
 * nenhum, não polui o diálogo.
 */
function DeleteCampaignButton({ campaign }: { campaign: CampaignSummary }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteCampaign();
  const messages = messageCountOf(campaign);
  const dependents = useDependentSegments(campaign.id, { enabled: open });
  const dependentSegments = dependents.data ?? [];

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault(); // mantém o diálogo aberto se der erro
    try {
      await del.mutateAsync(campaign.id);
      toast.success('Campanha apagada', {
        description:
          messages > 0
            ? `${messages} mensagem(ns) saíram das conversas. Os consentimentos continuam intactos.`
            : 'Os consentimentos continuam intactos.',
      });
      setOpen(false);
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Apagar campanha ${campaign.name}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar "{campaign.name}"?</AlertDialogTitle>
            <AlertDialogDescription data-testid="delete-warning">
              {messages > 0 ? (
                <>
                  Esta campanha tem <strong>{messages} mensagens</strong> que
                  aparecem no inbox. Apagá-la remove essas bolhas das conversas —
                  o contato pode responder a algo que você não verá mais. Os
                  consentimentos NÃO são afetados.
                </>
              ) : (
                <>
                  Esta campanha não chegou a enviar nenhuma mensagem, então nada
                  sai do inbox. Os consentimentos NÃO são afetados.
                </>
              )}{' '}
              Apagar também destrói o <strong>registro de quem já recebeu</strong>{' '}
              esta campanha: filtros e segmentos que usam "excluir quem já
              recebeu" param de enxergá-la, e essas pessoas podem voltar a ser
              selecionadas.{' '}
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dependentSegments.length > 0 && (
            <div
              data-testid="dependent-segments-warning"
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <p>
                {dependentSegments.length} segmento(s) usam esta campanha num
                filtro de "excluir quem já recebeu" e param de enxergá-la:
              </p>
              <ul className="ml-4 list-disc">
                {dependentSegments.map((s) => (
                  <li key={s.id}>{s.name}</li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={del.isPending}
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            >
              {del.isPending ? 'Apagando…' : 'Apagar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const Route = createFileRoute('/_authenticated/campaigns/')({
  component: CampaignsPage,
});

type CampaignProgress = {
  /**
   * Whether there is anything to render a percentage against. False only for
   * a campaign with no Message rows AND no recipients — surfacing "0%" there
   * reads as "0 of N sent" which is misleading because there is no N.
   */
  hasProgress: boolean;
  /** Completion percentage in [0, 100]. */
  pct: number;
};

/**
 * Derive the progress-bar state for a single campaign from its statusCounts.
 *
 * - `fulfilled` counts messages that have left our side (SENT/DELIVERED/READ).
 * - When the campaign has Message rows, the denominator is the total message
 *   count. When it has none yet (fresh campaign), we fall back to
 *   `totalRecipients` so a not-yet-dispatched campaign reads as "0 of N sent"
 *   (0%) rather than NaN.
 */
/** Message statuses that count toward "fulfilled" (the message left our side). */
const FULFILLED_STATUSES = ['SENT', 'DELIVERED', 'READ'] as const;
/** All terminal/in-flight statuses that make up the total Message-row count. */
const TOTAL_STATUSES = [
  'QUEUED',
  ...FULFILLED_STATUSES,
  'FAILED',
  'CANCELLED',
] as const;

function getCampaignProgress(c: CampaignSummary): CampaignProgress {
  const counts = (c.statusCounts ?? []).reduce(
    (acc, x) => ({ ...acc, [x.status]: x._count }),
    {} as Record<string, number>,
  );
  const sum = (statuses: readonly string[]) =>
    statuses.reduce((total, s) => total + (counts[s] ?? 0), 0);

  const totalMessages = sum(TOTAL_STATUSES);
  const fulfilled = sum(FULFILLED_STATUSES);
  const hasProgress = totalMessages > 0 || c.totalRecipients > 0;
  // Achado 2 (Importante, review final) — numa campanha em LOTES,
  // `totalMessages` só cobre quem já foi enfileirado (500 do 1º lote de
  // 13.400 no público inteiro). Caindo para `totalMessages` assim que ele
  // existisse, a barra pulava para 100% ao lado do texto "500 / 13.400 ·
  // restam 12.900" (textoDaLinha, list-progress.ts) — a MESMA linha se
  // contradizendo. O denominador é o MAIOR entre os dois: nunca menor que o
  // público inteiro enquanto ele for conhecido, e ainda cobre o caso legado
  // (`totalRecipients` zerado, `totalMessages` positivo).
  const denom = Math.max(c.totalRecipients, totalMessages);
  const pct = denom > 0 ? (fulfilled / denom) * 100 : 0;
  return { hasProgress, pct };
}

/**
 * "84% entregue · 69% lida" — as taxas que a página /disparos mostrava para as
 * campanhas do orgamind, agora aqui (a fusão que matou aquela página).
 *
 * O denominador é DESTINATÁRIOS — o mesmo do card "Campanhas recentes" do
 * Início (dashboard.tsx, RecentCampaignRow). Não é detalhe: a primeira versão
 * dividia pelas Messages de TOTAL_STATUSES, que deixa de fora SKIPPED_*
 * (gate de consentimento), WAITING_INSTANCE e SENDING — uma campanha com 40
 * pulados e 60 entregues lia "100% entregue" aqui e "60%" no Início, as duas
 * legendas idênticas a um clique uma da outra. Entrega é número de prestação
 * de contas: quem foi pulado NÃO recebeu, e a taxa tem de dizer isso.
 *
 * `null` enquanto não há nenhuma Message: taxa sem numerador possível não é
 * "0%" (a campanha nem começou).
 */
function deliveryCaption(c: CampaignSummary): string | null {
  if (messageCountOf(c) === 0) return null;
  const denom = c.totalRecipients || messageCountOf(c);
  if (denom === 0) return null;
  const counts = (c.statusCounts ?? []).reduce(
    (acc, x) => ({ ...acc, [x.status]: x._count }),
    {} as Record<string, number>,
  );
  const delivered = ((counts.DELIVERED ?? 0) + (counts.READ ?? 0)) / denom;
  const read = (counts.READ ?? 0) / denom;
  return `${(delivered * 100).toFixed(0)}% entregue · ${(read * 100).toFixed(0)}% lida`;
}

function CampaignProgressCell({ campaign }: { campaign: CampaignSummary }) {
  const { hasProgress, pct } = getCampaignProgress(campaign);
  if (!hasProgress) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="Sem destinatários"
      >
        — sem destinatários
      </span>
    );
  }
  const caption = deliveryCaption(campaign);
  return (
    <div>
      <div
        data-testid="campaign-progress-bar"
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            background: 'var(--brand-orange)',
            transition: 'width 240ms ease-out',
          }}
        />
      </div>
      {caption && (
        <div
          className="ds-mono mt-1 text-[11px]"
          style={{ color: 'var(--foreground-muted)' }}
          data-testid="delivery-caption"
        >
          {caption}
        </div>
      )}
      <div
        className="ds-mono mt-1 text-[11px]"
        data-testid="campaign-counts"
        style={{ color: 'var(--foreground-muted)' }}
      >
        {textoDaLinha(campaign)}
      </div>
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  // Uma consulta só para a página inteira: o TanStack Query dedupe pela chave
  // ['whatsapp','providers'] (staleTime: Infinity) — todas as linhas
  // compartilham a MESMA resposta em cache, então N linhas não viram N
  // requisições. Nenhuma consulta de AUDIÊNCIA por linha — é a restrição da
  // A.6.
  const providersQuery = useProviders();
  const resolution = campaign.defaultInstanceId
    ? resolveCampaignChannel(providersQuery, campaign.defaultInstanceId)
    : undefined;
  const canal = resolution?.state === 'found' ? resolution.canal : undefined;
  // Achado 4 (review final) — mesmo relógio para os dois, senão "quanto já
  // saiu" e "quando reinicia" poderiam discordar entre si na mesma linha.
  const now = new Date();
  const quota = canal ? quotaRestante(canal, now) : undefined;
  const reset = canal
    ? horaDoReset(canal.sentTodayResetAt, campaign.timezone ?? 'America/Manaus', now)
    : null;

  return (
    <TableRow>
      <TableCell>
        <Link to="/campaigns/$campaignId" params={{ campaignId: campaign.id }} className="underline" style={{ color: 'var(--brand-blue)' }}>
          {campaign.name}
        </Link>
      </TableCell>
      <TableCell className="ds-mono text-xs">
        {campaign.template?.metaName}
      </TableCell>
      <TableCell>{campaign.totalRecipients.toLocaleString('pt-BR')}</TableCell>
      <TableCell>
        <CampaignProgressCell campaign={campaign} />
      </TableCell>
      <TableCell>
        <Badge className={campaign.status === 'RUNNING' ? 'animate-pulse' : ''}>
          {statusDoOperador({ campaign, quotaRestante: quota, reset })}
        </Badge>
      </TableCell>
      <TableCell>
        {new Date(campaign.createdAt).toLocaleString('pt-BR')}
      </TableCell>
      <TableCell className="text-right">
        {canDelete(campaign) && <DeleteCampaignButton campaign={campaign} />}
      </TableCell>
    </TableRow>
  );
}

/**
 * "Apagar todas" — o pedido literal: limpar as campanhas de teste e começar do
 * zero, sem confirmar uma por uma.
 *
 * As campanhas EM VOO ficam de fora (o backend as recusaria), e o diálogo diz
 * QUANTAS serão apagadas em vez de "todas" — "todas" esconderia o fato de que as
 * em voo sobrevivem, e o operador sairia achando que a base está limpa.
 *
 * Apaga uma a uma (o backend não tem endpoint de lote). Se alguma falhar, as
 * outras já apagadas continuam apagadas — por isso o toast reporta o que
 * REALMENTE saiu, e não um "pronto!" otimista.
 */
function DeleteAllCampaignsButton({ campaigns }: { campaigns: CampaignSummary[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const del = useDeleteCampaign();

  const deletable = campaigns.filter(canDelete);
  const messages = deletable.reduce((total, c) => total + messageCountOf(c), 0);

  if (deletable.length === 0) return null;

  async function handleDeleteAll(e: React.MouseEvent) {
    e.preventDefault();
    setBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const c of deletable) {
      try {
        await del.mutateAsync(c.id);
        ok += 1;
      } catch {
        failures.push(c.name);
      }
    }
    setBusy(false);
    setOpen(false);

    if (failures.length > 0) {
      toast.error(`${ok} apagada(s), ${failures.length} falharam`, {
        description: `Não foi possível apagar: ${failures.join(', ')}.`,
      });
      return;
    }
    toast.success(`${ok} campanha(s) apagada(s)`, {
      description:
        messages > 0
          ? `${messages} mensagem(ns) saíram das conversas. Os consentimentos continuam intactos.`
          : 'Os consentimentos continuam intactos.',
    });
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="mr-1.5 h-4 w-4" />
        Apagar todas
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Apagar {deletable.length} campanha(s)?</AlertDialogTitle>
          <AlertDialogDescription data-testid="delete-all-warning">
            Isso apaga <strong>{deletable.length} campanhas</strong>, com{' '}
            <strong>{messages} mensagens</strong> que aparecem no inbox. Apagá-las
            remove essas bolhas das conversas. Os consentimentos NÃO são afetados.
            {deletable.length < campaigns.length && (
              <>
                {' '}
                As campanhas em disparo continuam — cancele-as antes se quiser
                apagá-las também.
              </>
            )}{' '}
            Esta ação não pode ser desfeita.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAll}
              disabled={busy}
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            >
              {busy ? 'Apagando…' : `Apagar ${deletable.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CampaignsPage() {
  const { data, isLoading, isError, error, refetch } = useCampaigns();

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border px-4 py-4 sm:px-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <header className="space-y-1">
          <div className="ds-eyebrow">campanhas · {data?.length ?? 0}</div>
          <h1 className="ds-display !text-3xl">Disparos.</h1>
        </header>
        <div className="flex items-center gap-2">
          {data && data.length > 0 && <DeleteAllCampaignsButton campaigns={data} />}
          <Button asChild>
            <Link to="/campaigns/new">Nova campanha</Link>
          </Button>
        </div>
      </div>
      {isLoading ? (
        <p>Carregando...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Destinatários</TableHead>
                <TableHead className="w-[160px]">Progresso</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criada em</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.map((c) => (
                <CampaignRow key={c.id} campaign={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
