import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { extractApiError } from "@/lib/api-error";
import { useAuthStore } from "@/stores/auth.store";
import { SectorForm } from "@/features/internal-admin/components/sector-form";
import { useSector, useUpdateSector } from "@/features/internal-admin/api";
import { SectorNumber } from "@/features/internal-admin/components/sector-number";
import type { SectorDetail } from "@/features/internal-admin/schemas";
import { useSectorPeople } from "@/features/sector-people/api";
import { AddPeopleDialog } from "@/features/sector-people/components/add-people-dialog";
import { EditPersonDialog } from "@/features/sector-people/components/edit-person-dialog";
import { EmptySector } from "@/features/sector-people/components/empty-sector";
import { useRefreshAuditTrail } from "@/features/sector-people/components/audit-trail-refresh";
import { countFlags, filterPeople, type FlagFilter } from "@/features/sector-people/components/people-filter";
import { PeopleTable } from "@/features/sector-people/components/people-table";
import { InactiveToggle, PeopleToolbar } from "@/features/sector-people/components/people-toolbar";
import { isSectorForbidden, SECTOR_FORBIDDEN_MESSAGE } from "@/features/sector-people/error-messages";
import type { SectorPeopleResponse, SectorPerson } from "@/features/sector-people/schemas";

const route = createFileRoute("/_authenticated/setores/$sectorId")({
  component: SectorDetailPage,
});
export { route as Route };

function SectorDetailPage() {
  const { sectorId } = route.useParams();
  return <SectorDetail key={sectorId} sectorId={sectorId} />;
}

/** Mantém a última lista enquanto a consulta com outra opção carrega: a tela não pisca nem perde a busca. */
function useLatestData<T>(data: T | undefined): T | undefined {
  const [latest, setLatest] = useState(data);
  if (data !== undefined && data !== latest) setLatest(data);
  return data ?? latest;
}

function SectorDetail({ sectorId }: { sectorId: string }) {
  const isAdmin = useAuthStore((state) => state.user?.role === "ADMIN");
  const [includeInactive, setIncludeInactive] = useState(false);
  const people = useSectorPeople(sectorId, { includeInactive });
  const data = useLatestData(people.data);
  if (people.isError) {
    return isSectorForbidden(people.error) ? (
      <p role="alert" className="rounded-lg border p-6 text-sm">{SECTOR_FORBIDDEN_MESSAGE}</p>
    ) : (
      <QueryErrorFallback error={people.error} onRetry={people.refetch} />
    );
  }
  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <main className="mx-auto max-w-4xl space-y-6">
      <SectorHeader data={data} />
      <PeopleSection sectorId={sectorId} data={data} includeInactive={includeInactive} onIncludeInactive={setIncludeInactive} />
      {isAdmin && <AdminPanel sectorId={sectorId} />}
    </main>
  );
}

function SectorHeader({ data }: { data: SectorPeopleResponse }) {
  const { sector } = data;
  return (
    <header className="flex justify-between gap-3">
      <div>
        <p className="ds-eyebrow">{sector.code} · {sector.isActive ? "Ativo" : "Inativo"}</p>
        <h1 className="ds-display !text-3xl">{sector.name}.</h1>
        <p className="text-sm text-muted-foreground">Gestor: {sector.manager?.name ?? "A definir"}</p>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">Número: <SectorNumber channel={sector.channel} /></p>
      </div>
      <Button asChild variant="outline">
        <Link to="/setores">Voltar</Link>
      </Button>
    </header>
  );
}

type SectionProps = {
  sectorId: string;
  data: SectorPeopleResponse;
  includeInactive: boolean;
  onIncludeInactive: (include: boolean) => void;
};

function PeopleSection({ sectorId, data, includeInactive, onIncludeInactive }: SectionProps) {
  const [addOpen, setAddOpen] = useState(false);
  const refreshTrail = useRefreshAuditTrail();
  const openAdd = () => setAddOpen(true);
  // Mover pessoa para o setor acontece dentro deste diálogo: ao fechar, a trilha é relida.
  const changeAdd = (open: boolean) => {
    setAddOpen(open);
    if (!open) void refreshTrail();
  };
  const addDialog = <AddPeopleDialog sectorId={sectorId} options={data.options} open={addOpen} onOpenChange={changeAdd} />;
  if (data.people.length === 0) {
    return (
      <>
        <EmptySector onAddPeople={openAdd} />
        <InactiveToggle checked={includeInactive} onChange={onIncludeInactive} />
        {addDialog}
      </>
    );
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">Pessoas ({data.people.length})</h2>
        <Button aria-haspopup="dialog" aria-expanded={addOpen} onClick={openAdd}>Adicionar pessoas</Button>
      </div>
      {addDialog}
      <PeopleList sectorId={sectorId} data={data} includeInactive={includeInactive} onIncludeInactive={onIncludeInactive} />
    </section>
  );
}

/** Busca e filtro são locais, sobre as pessoas carregadas (spec A1 e A2); o contador não segue a busca. */
function PeopleList({ sectorId, data, includeInactive, onIncludeInactive }: SectionProps) {
  const [query, setQuery] = useState("");
  const [flag, setFlag] = useState<FlagFilter | null>(null);
  const [editing, setEditing] = useState<SectorPerson | null>(null);
  const refreshTrail = useRefreshAuditTrail();
  const visible = filterPeople(data.people, { query, flag });
  const closeEdit = (open: boolean) => {
    if (open) return;
    setEditing(null);
    void refreshTrail();
  };
  return (
    <>
      <PeopleToolbar
        query={query}
        onQuery={setQuery}
        counts={countFlags(data.people)}
        value={flag}
        onChange={setFlag}
        includeInactive={includeInactive}
        onIncludeInactive={onIncludeInactive}
      />
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma pessoa encontrada.</p>
      ) : (
        <PeopleTable sectorId={sectorId} people={visible} onEdit={setEditing} />
      )}
      {editing && (
        <EditPersonDialog sectorId={sectorId} person={editing} options={data.options} open onOpenChange={closeEdit} />
      )}
    </>
  );
}

/** Só o ADMIN: estado e o formulário do setor. */
function AdminPanel({ sectorId }: { sectorId: string }) {
  const sector = useSector(sectorId);
  const update = useUpdateSector(sectorId);
  const navigate = useNavigate();
  if (!sector.data) return null;
  return (
    <>
      <SectorReadView sector={sector.data} />
      <section className="max-w-xl space-y-3">
        <h2 className="font-heading text-lg font-semibold">Editar setor</h2>
        <SectorForm
          sector={sector.data}
          pending={update.isPending}
          onCancel={() => navigate({ to: "/setores" })}
          onSubmit={async (input) => {
            try {
              await update.mutateAsync(input);
              toast.success("Setor atualizado");
            } catch (error) {
              const apiError = await extractApiError(error);
              toast.error(apiError.title, { description: apiError.message });
            }
          }}
        />
      </section>
    </>
  );
}

function SectorReadView({ sector }: { sector: SectorDetail }) {
  return (
    <section className="rounded-xl border p-4">
      <div className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">Estado</h2>
        <Badge variant={sector.isActive ? "secondary" : "outline"}>
          {sector.isActive ? "Ativo" : "Inativo"}
        </Badge>
        {sector.description ? <p className="text-sm text-muted-foreground">{sector.description}</p> : null}
      </div>
    </section>
  );
}
