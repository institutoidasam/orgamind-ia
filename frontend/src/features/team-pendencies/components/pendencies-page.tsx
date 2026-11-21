import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/features/internal-communications/components/pagination";
import { usePermission } from "@/features/permissions/use-permission";
import { useAuthStore } from "@/stores/auth.store";
import {
  DEFAULT_PENDENCY_FILTERS,
  PENDENCIES_KEY,
  usePendencyList,
  type PendencyFilters,
} from "../api";
import type { PendencyMe } from "../pendency-actions";
import type { TeamPendencyItem, TeamPendencyList } from "../schemas";
import { PendencyActionsBar } from "./pendency-actions-bar";
import { PendencyFiltersBar } from "./pendency-filters";
import {
  HandoverOwnButton,
  HandoverRowButton,
  PendencyHandoverProvider,
} from "./pendency-handover-dialog";
import { PendencyRow } from "./pendency-row";

const TITLE = "Pendências da equipe";
const LOADING_TEXT = "Carregando pendências…";
const ERROR_TEXT = "Não foi possível carregar as pendências";
const RETRY_TEXT = "Tentar de novo";
const EMPTY_TEXT = "Nenhuma pendência com estes filtros.";
const NOT_SENDER_TEXT = "Esta tela é para quem envia mensagens à equipe.";
const TRUNCATED_TEXT =
  "A lista passou de 2.000 pendências; use os filtros para ver as demais.";

/** O contador do menu só se atualiza por invalidação (DK21): a tela o relê ao abrir. */
const COUNT_KEY = [...PENDENCIES_KEY, "count"] as const;

/** Quem olha a tela: papel e chaves de envio (`equipe.enviar`) e de ciência manual (`equipe.urgencia`). */
function usePendencyMe(): PendencyMe | null {
  const user = useAuthStore((state) => state.user);
  const canWrite = usePermission("equipe.enviar");
  const canUrgency = usePermission("equipe.urgencia");
  return user ? { id: user.id, role: user.role, canWrite, canUrgency } : null;
}

/** Depois de uma ação a lista pode encolher e deixar a página atual vazia: volta à última que existe. */
function useBackToLastPage(
  data: TeamPendencyList | null | undefined,
  filters: PendencyFilters,
  setFilters: (filters: PendencyFilters) => void,
) {
  useEffect(() => {
    if (!data || data.items.length > 0 || data.total === 0) return;
    const lastPage = Math.ceil(data.total / data.pageSize);
    if (filters.page > lastPage) setFilters({ ...filters, page: lastPage });
  }, [data, filters, setFilters]);
}

/** Ações da tratativa e, só para o ADMIN, "Passar as pendências de {nome}" (K3-4). */
function RowActions({ item, me }: { item: TeamPendencyItem; me: PendencyMe }) {
  return (
    <>
      <PendencyActionsBar item={item} me={me} />
      <HandoverRowButton item={item} me={me} />
    </>
  );
}

type ListProps = {
  query: ReturnType<typeof usePendencyList>;
  me: PendencyMe;
  filters: PendencyFilters;
  onFilters: (filters: PendencyFilters) => void;
};

function PendencyListBody({ query, me, filters, onFilters }: ListProps) {
  const { data } = query;
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <p>{ERROR_TEXT}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          {RETRY_TEXT}
        </Button>
      </div>
    );
  }
  if (!data || query.isPlaceholderData) {
    return <p className="text-sm text-muted-foreground">{LOADING_TEXT}</p>;
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-muted-foreground">{EMPTY_TEXT}</p>;
  }
  return (
    <>
      <ul aria-label="Pendências" className="space-y-3">
        {data.items.map((item) => (
          <li key={item.id}>
            <PendencyRow
              item={item}
              me={me}
              renderActions={(row) => <RowActions item={row} me={me} />}
            />
          </li>
        ))}
      </ul>
      {data.total > data.pageSize && (
        <Pagination
          page={filters.page}
          pageSize={data.pageSize}
          total={data.total}
          onPageChange={(page) => onFilters({ ...filters, page })}
        />
      )}
    </>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <PendencyHandoverProvider>
      <main className="mx-auto max-w-5xl space-y-4">
        <h1 className="text-2xl font-bold">{TITLE}</h1>
        {children}
      </main>
    </PendencyHandoverProvider>
  );
}

/** Tela "Pendências da equipe" (K2-5, DK19): filtros em estado local; recarrega ao abrir, sem tempo real. */
export function PendenciesPage() {
  const me = usePendencyMe();
  const qc = useQueryClient();
  const [filters, setFilters] = useState(DEFAULT_PENDENCY_FILTERS);
  // VIEWER (e sessão sem usuário) não consulta.
  const enabled = me !== null && me.role !== "VIEWER";
  const query = usePendencyList(filters, enabled);
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: COUNT_KEY });
  }, [qc]);
  useBackToLastPage(query.data, filters, setFilters);
  // `null` = o servidor recusou: quem consulta não é remetente.
  if (!me || !enabled || query.data === null) {
    return (
      <PageShell>
        <p role="status" className="rounded-md border p-6 text-sm">
          {NOT_SENDER_TEXT}
        </p>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <HandoverOwnButton me={me} />
      <PendencyFiltersBar
        filters={filters}
        sectors={query.data?.sectors ?? []}
        onChange={setFilters}
      />
      {query.data?.truncated && (
        <p role="status" className="text-sm text-muted-foreground">
          {TRUNCATED_TEXT}
        </p>
      )}
      <PendencyListBody
        query={query}
        me={me}
        filters={filters}
        onFilters={setFilters}
      />
    </PageShell>
  );
}
