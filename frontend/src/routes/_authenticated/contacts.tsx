import {
  createFileRoute,
  Link,
  useNavigate,
  type UseNavigateResult,
} from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  History,
  Pencil,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { extractApiError } from '@/lib/api-error';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth.store';
import {
  useBulkDeleteContacts,
  useContacts,
  useDeleteContact,
  useExportContacts,
} from '@/features/contacts/api';
import { ContactFormDialog } from '@/features/contacts/components/contact-form-dialog';
import { LabelsDialog } from '@/features/contacts/components/labels-dialog';
import { SyncContactsDialog } from '@/features/contacts/components/sync-contacts-dialog';
import type {
  CampaignsReceived,
  Contact,
  ContactListItem,
  ContactsListResponse,
} from '@/features/contacts/schemas';
import { CONTACT_EXPORT_ROW_CAP } from '@/features/contacts/schemas';
import { useInstances } from '@/features/whatsapp/api';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { contactsSearchSchema } from '@/features/contacts/search-schema';
import {
  FAILURE_REASONS,
  FAILURE_REASON_LABELS,
  type FailureReason,
} from '@/features/campaigns/schemas';
import { useCampaigns } from '@/features/campaigns/api';
import {
  CONTACT_VALIDITIES,
  CONTACT_VALIDITY_FILTER_LABELS,
  CONTACT_VALIDITY_HINTS,
  CONTACT_VALIDITY_LABELS,
  contactValidityOf,
  type ContactValidity,
} from '@/features/contacts/validity';

export const Route = createFileRoute('/_authenticated/contacts')({
  validateSearch: contactsSearchSchema,
  component: ContactsPage,
});

type CheckedState = boolean | 'indeterminate';

/**
 * Owns page-row selection. The selection auto-prunes to the ids currently on
 * the page whenever `data` changes (e.g. after a delete or page change), and
 * exposes the header-checkbox tri-state plus per-row/all toggles.
 */
function useContactSelection(data: ContactsListResponse | undefined) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop selection of items not in current page (after delete or page change)
  useEffect(() => {
    if (!data) return;
    const visibleIds = new Set(data.items.map((c) => c.id));
    setSelected((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visibleIds.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const allChecked = useMemo(() => {
    if (!data || data.items.length === 0) return false;
    return data.items.every((c) => selected.has(c.id));
  }, [data, selected]);

  const someChecked = selected.size > 0 && !allChecked;

  const toggleAll = useCallback(
    (checked: CheckedState) => {
      if (!data) return;
      if (checked === true) {
        setSelected(new Set(data.items.map((c) => c.id)));
      } else {
        setSelected(new Set());
      }
    },
    [data],
  );

  const toggleOne = useCallback((id: string, checked: CheckedState) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked === true) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  return {
    selected,
    allChecked,
    someChecked,
    toggleAll,
    toggleOne,
    clear,
  };
}

/**
 * Keeps a debounced text input in sync with the `search` URL param. Typing
 * resets to page 1 (via `replace`) once the 300ms debounce settles, and skips
 * navigation when the value is unchanged.
 */
function useContactSearchSync(
  search: string | undefined,
  pageSize: number,
  navigate: UseNavigateResult<'/contacts'>,
  // F2 T9 — o debounce de texto reconstrói o objeto de busca inteiro (não
  // faz merge com `prev`, ao contrário dos botões de paginação abaixo).
  // Sem preservar `failureReason` aqui, digitar no campo de busca apagaria
  // silenciosamente o filtro por motivo de falha selecionado.
  failureReason: FailureReason | undefined,
  // F3 — a MESMA armadilha, filtro novo: `receivedCampaignId` também tem de
  // ser reinjetado aqui. Todo filtro que entrar nesta tela daqui pra frente
  // precisa passar por este parâmetro, senão some ao digitar na busca.
  receivedCampaignId: string | undefined,
  // B.3 — a MESMA armadilha, filtro novo: sem reinjetar `validity` aqui,
  // digitar no campo de busca apaga o recorte de validação em silêncio.
  validity: ContactValidity | undefined,
) {
  const [searchInput, setSearchInput] = useState(search ?? '');

  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput || undefined;
      if (next === search) return;
      void navigate({
        search: () => ({
          page: 1,
          pageSize,
          search: next,
          failureReason,
          receivedCampaignId,
          validity,
        }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(t);
  }, [
    searchInput,
    navigate,
    pageSize,
    search,
    failureReason,
    receivedCampaignId,
    validity,
  ]);

  return { searchInput, setSearchInput };
}

/**
 * Wraps the single + bulk delete mutations with their toast/error handling and
 * confirmation-dialog state. `clearSelection` is invoked after a successful
 * bulk delete so the toolbar collapses.
 */
function useContactDeletion(clearSelection: () => void) {
  const deleteOne = useDeleteContact();
  const bulkDelete = useBulkDeleteContacts();

  const [confirmDeleteOne, setConfirmDeleteOne] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);

  const onDeleteOneConfirm = async () => {
    if (!confirmDeleteOne) return;
    try {
      await deleteOne.mutateAsync(confirmDeleteOne.id);
      toast.success('Contato excluído');
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setConfirmDeleteOne(null);
    }
  };

  const confirmBulkDelete = async (ids: string[]) => {
    try {
      const r = await bulkDelete.mutateAsync({ ids });
      toast.success(`${r.deleted} contato(s) excluído(s)`);
      clearSelection();
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      setConfirmBulkOpen(false);
    }
  };

  return {
    bulkDelete,
    confirmDeleteOne,
    setConfirmDeleteOne,
    confirmBulkOpen,
    setConfirmBulkOpen,
    onDeleteOneConfirm,
    confirmBulkDelete,
  };
}

/**
 * F2 T9 — chip do motivo da última falha DEFINITIVA (`Contact.lastFailureReason`).
 *
 * §2.5 da spec de design: Evolution não emite código nem mensagem no webhook
 * de falha, e Twilio só emite código sem texto — os dois casos (mais um
 * contato que falhou mas nunca teve a falha classificada como durável)
 * terminam com `lastFailureReason` em `INDETERMINADO` ou `null`. Mostrar
 * "motivo não informado pelo canal" nesses casos, e NUNCA um chip vazio,
 * é o que distingue "o canal não contou" de "isto quebrou".
 *
 * Um contato que nunca falhou (`failureCount === 0`) não mostra chip algum —
 * só o traço neutro que as outras colunas ausentes já usam.
 */
function FailureReasonCell({
  lastFailureReason,
  failureCount,
}: {
  lastFailureReason: FailureReason | null;
  failureCount: number;
}) {
  if (!failureCount) {
    return <span className="text-muted-foreground">—</span>;
  }
  const label =
    lastFailureReason && lastFailureReason !== 'INDETERMINADO'
      ? FAILURE_REASON_LABELS[lastFailureReason]
      : 'motivo não informado pelo canal';
  return (
    <Badge variant="outline" className="whitespace-nowrap">
      {label}
    </Badge>
  );
}

/**
 * F3 — "quais campanhas este contato RECEBEU". O back já entrega o resumo
 * pronto em `campaignsReceived` (sempre presente na listagem, mesmo para quem
 * não recebeu nada), usando o MESMO critério de "recebeu" que a exclusão do
 * wizard aplica (REACHED_STATUSES: SENT/DELIVERED/READ) — se divergisse, a
 * lista diria "recebeu" e o wizard não excluiria, na mesma tela.
 *
 * Zero campanhas mostra o traço neutro das outras colunas ausentes, nunca um
 * chip vazio: é a mesma regra do `FailureReasonCell` acima ("ausência" e
 * "algo que não sabemos nomear" não podem parecer a mesma coisa).
 *
 * Os nomes ficam no `title` nativo em vez de um Tooltip porque o design system
 * deste repo não tem Tooltip/Popover — o hover por `title` já é o padrão aqui
 * (ver `message-status-badge.tsx` e a coluna WA logo abaixo).
 *
 * ⚠️ O acesso é OPCIONAL de propósito, apesar do tipo dizer que o campo é
 * obrigatório: `contactsQueries.list` faz só `.json<ContactsListResponse>()` —
 * um cast de TypeScript, ZERO validação em runtime. Num redeploy em que o
 * bundle novo é servido antes do backend novo (imagens Docker SEPARADAS no
 * compose) a API responde sem o campo, e desestruturar `undefined` lançaria:
 * sem `errorComponent` em nenhuma rota, o throw sobe até o `Sentry.ErrorBoundary`
 * global e derruba o APP INTEIRO numa tela "Algo deu errado.", sem nav e sem
 * retry. Degradar para o traço é o precedente explícito do repo (ver
 * `features/chat/schemas.ts`, `chat-status.tsx`, `imports/index.tsx`).
 */
function CampaignsReceivedCell({
  campaignsReceived,
}: {
  campaignsReceived: CampaignsReceived;
}) {
  const count = campaignsReceived?.count;
  const names = campaignsReceived?.names ?? [];
  if (!count) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Badge
      variant="secondary"
      className="whitespace-nowrap"
      // Um nome por linha: o title nativo quebra em \n e a lista fica legível
      // mesmo com muitas campanhas.
      title={names.join('\n')}
    >
      {count} {count === 1 ? 'campanha' : 'campanhas'}
    </Badge>
  );
}

/**
 * A escada de 3 estados da coluna "WA" — agora com o MESMO vocabulário do
 * filtro, do export e do assistente (`features/contacts/validity.ts`). Antes,
 * a mesma linha podia dizer "Não validado" aqui e sair excluída pelo disparo
 * como inválida: a célula olhava só `whatsappValid` e ignorava o motivo da
 * última falha.
 */
function WhatsappValidityCell({ contact }: { contact: ContactListItem }) {
  const validity = contactValidityOf(contact);
  const title = CONTACT_VALIDITY_HINTS[validity];
  if (validity === 'valid') {
    return (
      <span
        className="text-emerald-600"
        title={title}
        aria-label={CONTACT_VALIDITY_LABELS.valid}
      >
        ✓
      </span>
    );
  }
  if (validity === 'invalid') {
    return (
      <span
        className="text-rose-600"
        title={title}
        aria-label={CONTACT_VALIDITY_LABELS.invalid}
      >
        ✗
      </span>
    );
  }
  return (
    <Badge variant="secondary" title={title}>
      {CONTACT_VALIDITY_LABELS.unvalidated}
    </Badge>
  );
}

type ContactRowProps = {
  contact: ContactListItem;
  selected: boolean;
  onToggle: (id: string, checked: CheckedState) => void;
  onLabels: (contact: Contact) => void;
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
};

function ContactRow({
  contact: c,
  selected,
  onToggle,
  onLabels,
  onEdit,
  onDelete,
}: ContactRowProps) {
  return (
    <TableRow data-state={selected ? 'selected' : undefined}>
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onToggle(c.id, v)}
          aria-label={`Selecionar ${c.name ?? c.phoneE164}`}
        />
      </TableCell>
      <TableCell className="font-mono text-sm">{c.phoneE164}</TableCell>
      <TableCell>{c.name ?? '—'}</TableCell>
      <TableCell>{c.city ?? '—'}</TableCell>
      <TableCell>{c.group ?? '—'}</TableCell>
      <TableCell className="space-x-1">
        {c.tags?.map((t) => (
          <Badge key={t} variant="secondary">
            {t}
          </Badge>
        ))}
      </TableCell>
      <TableCell>
        {c.optedOut ? (
          <Badge variant="destructive">Opt-out</Badge>
        ) : (
          <Badge>Ativo</Badge>
        )}
      </TableCell>
      <TableCell className="text-center">
        <WhatsappValidityCell contact={c} />
      </TableCell>
      <TableCell>
        <CampaignsReceivedCell campaignsReceived={c.campaignsReceived} />
      </TableCell>
      <TableCell>
        <FailureReasonCell
          lastFailureReason={c.lastFailureReason}
          failureCount={c.failureCount}
        />
      </TableCell>
      <TableCell
        className="whitespace-nowrap text-xs text-muted-foreground"
        title={new Date(c.createdAt).toISOString()}
      >
        {new Date(c.createdAt).toLocaleString('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
        })}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Etiquetas WhatsApp"
            title="Etiquetas WhatsApp"
            onClick={() => onLabels(c)}
          >
            <Tag className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Editar contato"
            onClick={() => onEdit(c)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Excluir contato"
            onClick={() => onDelete(c)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ContactsPage() {
  const navigate = useNavigate({ from: '/contacts' });
  const { page, pageSize, search, failureReason, receivedCampaignId, validity } =
    Route.useSearch();
  const { data, isLoading, isError, error, refetch } = useContacts({
    page,
    pageSize,
    search,
    failureReason,
    receivedCampaignId,
    validity,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [labelsFor, setLabelsFor] = useState<Contact | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);

  const { data: instances } = useInstances();
  // Quem alimenta o <select> do filtro é a LISTA de campanhas: a agregação da
  // célula não traz ids de propósito (ver `campaignsReceivedSchema` no back).
  const { data: campaigns } = useCampaigns();

  const { searchInput, setSearchInput } = useContactSearchSync(
    search,
    pageSize,
    navigate,
    failureReason,
    receivedCampaignId,
    validity,
  );

  // Há algum recorte aplicado? Lê os parâmetros da URL (o que a query de fato
  // usou), e não `searchInput`, que ainda está no debounce. Todo filtro novo
  // desta tela precisa entrar aqui — senão o estado vazio volta a mentir.
  const hasActiveFilter = Boolean(
    search || failureReason || receivedCampaignId || validity,
  );

  const isAdmin = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const [confirmInvalidOpen, setConfirmInvalidOpen] = useState(false);
  const [typedCount, setTypedCount] = useState('');
  // N é o `total` da PRÓPRIA lista — mas SÓ representa "todos os inválidos"
  // quando NENHUM outro filtro (busca, motivo, campanha) estreita a lista: o
  // back apaga por PREDICADO (`validity: 'invalid'`), sempre TODOS os
  // inválidos confirmados, não só os que bateram com um filtro extra. Com
  // outro filtro ligado, `data.total` é a contagem do RECORTE — mostrar esse
  // número aqui faria o operador confirmar um N que o servidor nunca vê bater
  // (ele apaga contra a contagem SEM o recorte, sempre maior), e a resposta
  // seria sempre 409. Por isso `canDeleteInvalid` abaixo também exige nenhum
  // outro filtro ativo; com o filtro extra ligado, a tela mostra uma nota em
  // vez do botão.
  const otherFilterActive = Boolean(search || failureReason || receivedCampaignId);
  const invalidCount = validity === 'invalid' ? (data?.total ?? 0) : 0;
  const invalidCountLabel = invalidCount.toLocaleString('pt-BR');
  const canDeleteInvalid =
    isAdmin && validity === 'invalid' && !otherFilterActive && invalidCount > 0;
  const invalidDeleteBlockedByOtherFilters =
    isAdmin && validity === 'invalid' && otherFilterActive;
  // Aceita tanto "1234" quanto "1.234" (o separador de milhar que a própria
  // tela usa para MOSTRAR N) — comparar só contra o número puro rejeitaria o
  // formato que o operador acabou de ver na tela e copiou.
  const typedCountMatches =
    typedCount.trim().replace(/\./g, '') === String(invalidCount);

  const exportContacts = useExportContacts();
  // Sem filtro E acima do teto, o clique só produziria um 400 depois de uma
  // espera longa. Recusar ANTES, dizendo por quê, é mais honesto.
  const exportBlocked =
    !hasActiveFilter && (data?.total ?? 0) > CONTACT_EXPORT_ROW_CAP;

  const onExport = async () => {
    // `url` mora fora do `try` para o `revokeObjectURL` do `finally` cobrir
    // qualquer saída — inclusive uma que hoje não existe mas poderia vir a
    // existir entre o `createObjectURL` e o `click` — sem vazar o Blob URL.
    let url: string | undefined;
    try {
      const blob = await exportContacts.mutateAsync({
        page,
        pageSize,
        search,
        failureReason,
        receivedCampaignId,
        validity,
      });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contatos-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  // Zera os três de uma vez. `setSearchInput('')` é obrigatório junto do
  // navigate: o campo de busca é estado LOCAL, e sem limpá-lo o debounce
  // reescreveria o `search` na URL 300ms depois de o operador ter limpado.
  const clearFilters = () => {
    setSearchInput('');
    void navigate({
      search: () => ({ page: 1, pageSize }),
    });
  };

  const { selected, allChecked, someChecked, toggleAll, toggleOne, clear } =
    useContactSelection(data);

  const {
    bulkDelete,
    confirmDeleteOne,
    setConfirmDeleteOne,
    confirmBulkOpen,
    setConfirmBulkOpen,
    onDeleteOneConfirm,
    confirmBulkDelete,
  } = useContactDeletion(clear);

  const onDeleteInvalidConfirm = async () => {
    try {
      // `r.deleted` pode ser MENOR que `invalidCount`: o back trava o delete
      // em `updatedAt <= snapshot` (o instante antes de contar), então uma
      // linha que virou inválida DEPOIS do snapshot não entra — o toast
      // mostra o que o servidor de fato apagou, nunca o N confirmado.
      const r = await bulkDelete.mutateAsync({
        validity: 'invalid',
        expectedCount: invalidCount,
      });
      toast.success(`${r.deleted} contato(s) inválido(s) excluído(s)`);
      // Sem refetch aqui: `useBulkDeleteContacts` já invalida a árvore de
      // queries de contatos no `onSuccess` (`invalidateContactTree`) — chamar
      // de novo seria um segundo fetch redundante.
    } catch (err) {
      const { title, message, status } = await extractApiError(err);
      // 409 = a lista mudou desde a confirmação
      // (ContactBulkDeleteCountMismatchError): nada foi apagado, e o N que o
      // operador confirmou já não vale. A frase com os dois números vem no
      // `title` (`domain-exception.filter.ts`: `title = exception.message`);
      // SEM description aqui — em produção `message` é o texto genérico do
      // ky (`error.message`, em inglês), não a explicação do servidor.
      // Busca a lista de novo para o operador ver a contagem atual — fechar
      // o diálogo e limpar o campo (no `finally` abaixo) já obrigam reabrir
      // e redigitar; a mutação nunca é reenviada sozinha.
      if (status === 409) {
        toast.error(title);
        void refetch();
      } else {
        toast.error(title, { description: message });
      }
    } finally {
      setConfirmInvalidOpen(false);
      setTypedCount('');
    }
  };

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <header className="space-y-1">
          <div className="ds-eyebrow">contatos · {data?.total ?? 0}</div>
          <h1 className="ds-display !text-3xl">Lista.</h1>
        </header>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Novo contato
          </Button>
          <Button variant="secondary" asChild>
            <Link to="/imports/new">
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              Importar planilha
            </Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/imports">
              <History className="mr-2 h-4 w-4" />
              Histórico
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!instances || instances.length === 0}
            title={
              !instances || instances.length === 0
                ? 'Nenhuma instância WhatsApp configurada'
                : 'Sincronizar status no WhatsApp'
            }
            onClick={() => setSyncOpen(true)}
          >
            <RefreshCw className="size-3.5" />
            Sincronizar status
          </Button>
          {/* Achado 3 (revisão) — o back só serve GET /contacts/export.xlsx
              para ADMIN (@Roles('ADMIN')); antes o botão aparecia para
              qualquer operador, que só descobria a recusa depois de clicar. */}
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              disabled={exportBlocked || exportContacts.isPending}
              title={
                exportBlocked
                  ? `A base tem mais de ${CONTACT_EXPORT_ROW_CAP.toLocaleString('pt-BR')} contatos. Aplique um filtro (cidade, grupo, validação) e exporte por partes.`
                  : 'Baixar a lista filtrada em .xlsx'
              }
              onClick={() => void onExport()}
            >
              <Download className="size-3.5" />
              {exportContacts.isPending ? 'Gerando…' : 'Exportar planilha'}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2"
            style={{ color: 'var(--foreground-muted)' }}
          />
          <Input
            className="pl-9"
            placeholder="Buscar por nome ou telefone..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        {/* F2 T9 — filtro por motivo da última falha, linkável por URL
            (`contactsSearchSchema.failureReason`) para poder ser
            compartilhado/marcado como favorito. */}
        <Select
          value={failureReason ?? 'all'}
          onValueChange={(v) => {
            void navigate({
              search: (prev) => ({
                ...prev,
                page: 1,
                failureReason:
                  v === 'all' ? undefined : (v as FailureReason),
              }),
            });
          }}
        >
          <SelectTrigger aria-label="Motivo da falha" className="h-9 w-full sm:w-64">
            <SelectValue placeholder="Motivo da falha" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {FAILURE_REASONS.map((r) => (
              <SelectItem key={r} value={r}>
                {FAILURE_REASON_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* F3 — filtro "recebeu a campanha X", também linkável por URL
            (`contactsSearchSchema.receivedCampaignId`). É a direção inversa da
            exclusão do wizard, com o mesmo critério de "recebeu". */}
        <Select
          value={receivedCampaignId ?? 'all'}
          onValueChange={(v) => {
            void navigate({
              search: (prev) => ({
                ...prev,
                page: 1,
                receivedCampaignId: v === 'all' ? undefined : v,
              }),
            });
          }}
        >
          <SelectTrigger
            aria-label="Recebeu a campanha"
            className="h-9 w-full sm:w-64"
          >
            <SelectValue placeholder="Recebeu a campanha:" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as campanhas</SelectItem>
            {(campaigns ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* B.3 — "Validação", linkável por URL como os outros dois. O
            vocabulário é o mesmo da coluna WA, da planilha e do assistente:
            uma definição só de "inválido" no produto inteiro. */}
        <Select
          value={validity ?? 'all'}
          onValueChange={(v) => {
            void navigate({
              search: (prev) => ({
                ...prev,
                page: 1,
                validity: v === 'all' ? undefined : (v as ContactValidity),
              }),
            });
          }}
        >
          <SelectTrigger aria-label="Validação" className="h-9 w-full sm:w-64">
            <SelectValue placeholder="Validação" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os números</SelectItem>
            {CONTACT_VALIDITIES.map((v) => (
              <SelectItem key={v} value={v} title={CONTACT_VALIDITY_HINTS[v]}>
                {CONTACT_VALIDITY_FILTER_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* B.3 T9 — a ação destrutiva mora ONDE o operador acabou de ver quem vai
          sumir: só aparece com o filtro "Inválidos confirmados" ligado, E sem
          NENHUM outro filtro junto (busca/motivo/campanha) — a exclusão apaga
          por predicado, sempre TODOS os inválidos confirmados. Com um filtro
          extra ligado, `data.total` seria só o recorte, e digitar essa
          contagem sempre bateria num 409 (o servidor conta TODOS os
          inválidos, sem o recorte). Nesse caso mostra uma nota em vez do
          botão. Num menu sempre visível, a ação seria um clique acidental a
          partir da lista inteira. */}
      {canDeleteInvalid && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm">
          <span>
            {invalidCountLabel} contato(s) com número inválido confirmado.
          </span>
          <Button
            variant="destructive"
            size="sm"
            disabled={bulkDelete.isPending}
            onClick={() => setConfirmInvalidOpen(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Apagar inválidos confirmados ({invalidCountLabel})
          </Button>
        </div>
      )}
      {invalidDeleteBlockedByOtherFilters && (
        <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Para apagar os inválidos, limpe os outros filtros — a exclusão vale
          para todos os inválidos confirmados, não só para esta busca.
        </div>
      )}

      {/* Selection toolbar — only shown when something is selected */}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
          style={{ background: 'var(--brand-blue-soft)' }}
        >
          <span className="font-medium">{selected.size} selecionado(s)</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmBulkOpen(true)}
            disabled={bulkDelete.isPending}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Excluir selecionados
          </Button>
          <Button variant="ghost" size="sm" onClick={clear}>
            Limpar seleção
          </Button>
        </div>
      )}

      {isLoading ? (
        <p>Carregando...</p>
      ) : data?.items.length === 0 ? (
        /* Zero linhas COM filtro ativo não é "base vazia" — é "nada casou". O
           <select> de campanhas é alimentado por `useCampaigns()`, que devolve
           TODAS as campanhas incluindo DRAFT/agendadas, então escolher uma que
           ainda não disparou é uso normal e zero é a resposta CORRETA. Dizer
           "Nenhum contato ainda. Clique em Novo contato" numa base de 13 mil
           contatos é mentir para o operador. */
        hasActiveFilter ? (
          <div
            data-testid="contacts-empty-filtered"
            className="flex flex-col items-center gap-3 rounded border border-dashed p-8 text-center text-sm text-muted-foreground"
          >
            <span>
              Nenhum contato corresponde aos filtros. A base pode ter contatos —
              esta combinação é que não retornou nenhum.
            </span>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Limpar filtros
            </Button>
          </div>
        ) : (
          <div
            data-testid="contacts-empty-base"
            className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground"
          >
            Nenhum contato ainda. Clique em <strong>Novo contato</strong> ou{' '}
            <strong>Importar planilha</strong> para começar.
          </div>
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      allChecked ? true : someChecked ? 'indeterminate' : false
                    }
                    onCheckedChange={toggleAll}
                    aria-label="Selecionar todos da página"
                  />
                </TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead>Grupo</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12 text-center">WA</TableHead>
                {/* "recebidas", não "Campanhas": a coluna conta REACHED_STATUSES
                    (SENT/DELIVERED/READ). Quem foi ALVO de 3 campanhas e falhou
                    nas 3 mostra "—", que ao lado de "Motivo da falha" se leria
                    como "nunca foi alvo". `whitespace-nowrap` para o cabeçalho
                    mais longo não quebrar a linha da tabela. */}
                <TableHead
                  className="whitespace-nowrap"
                  title="Quantas campanhas o contato de fato RECEBEU (enviada/entregue/lida). Campanhas que falharam ou foram puladas não contam."
                >
                  Campanhas recebidas
                </TableHead>
                <TableHead>Motivo da falha</TableHead>
                <TableHead>Criado em</TableHead>
                <TableHead className="w-24 text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((c) => (
                <ContactRow
                  key={c.id}
                  contact={c}
                  selected={selected.has(c.id)}
                  onToggle={toggleOne}
                  onLabels={setLabelsFor}
                  onEdit={setEditing}
                  onDelete={(contact) =>
                    setConfirmDeleteOne({
                      id: contact.id,
                      label: contact.name ?? contact.phoneE164,
                    })
                  }
                />
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between text-sm">
            <span>Total: {data?.total}</span>
            <div className="space-x-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 1}
                onClick={() =>
                  void navigate({
                    search: (prev) => ({ ...prev, page: Math.max(1, page - 1) }),
                  })
                }
              >
                Anterior
              </Button>
              <span>Página {page}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page * pageSize >= (data?.total ?? 0)}
                onClick={() =>
                  void navigate({
                    search: (prev) => ({ ...prev, page: page + 1 }),
                  })
                }
              >
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}

      <ContactFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ContactFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        contact={editing}
      />

      <LabelsDialog
        open={!!labelsFor}
        onOpenChange={(o) => !o && setLabelsFor(null)}
        contact={labelsFor}
      />

      {/* Single delete confirmation */}
      <AlertDialog
        open={!!confirmDeleteOne}
        onOpenChange={(o) => !o && setConfirmDeleteOne(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir contato?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. O contato{' '}
              <strong>{confirmDeleteOne?.label}</strong> e todas as mensagens
              relacionadas serão removidos permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeleteOneConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation */}
      <AlertDialog open={confirmBulkOpen} onOpenChange={setConfirmBulkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Excluir {selected.size} contato(s)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. Os contatos selecionados e todas
              as mensagens relacionadas serão removidos permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmBulkDelete([...selected])}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir {selected.size}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação da exclusão em massa por validade. O aviso é TRIPLO de
          propósito (spec B.3 + T9): apagar o contato apaga o histórico dele
          por cascata — inclusive as falhas que PROVAVAM a invalidez, as
          linhas de campanhas passadas E os registros de consentimento
          (`ContactConsent`, mesma cascata; o opt-out sobrevive por
          `phoneHash` na `SuppressionList`) —, e uma reimportação da planilha
          traz todo mundo de volta. Sem os três avisos, o operador acha que
          está "limpando" e está, na verdade, apagando prova. */}
      <AlertDialog
        open={confirmInvalidOpen}
        onOpenChange={(o) => {
          setConfirmInvalidOpen(o);
          if (!o) setTypedCount('');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apagar {invalidCountLabel} contato(s) inválido(s)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <strong>Exporte a planilha antes:</strong> apagar remove também
              o histórico de mensagens e os registros de consentimento desses
              contatos, e uma reimportação os traz de volta. As campanhas
              passadas perdem as linhas dessas pessoas — os números de "Já
              receberam" e "Falhas" delas vão cair. O opt-out continua
              valendo: fica na lista de supressão por telefone, e uma
              reimportação não volta a enviar para quem pediu PARAR.
              <br />
              Se o objetivo é só não enviar para eles, use "Excluir inválidos
              confirmados" no assistente de campanha: não apaga nada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="confirm-invalid-count">
              Digite {invalidCountLabel} para confirmar
            </Label>
            <Input
              id="confirm-invalid-count"
              inputMode="numeric"
              autoComplete="off"
              value={typedCount}
              onChange={(e) => setTypedCount(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDelete.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!typedCountMatches || bulkDelete.isPending}
              onClick={(e) => {
                e.preventDefault();
                void onDeleteInvalidConfirm();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Apagar {invalidCountLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SyncContactsDialog open={syncOpen} onOpenChange={setSyncOpen} />
    </div>
  );
}
