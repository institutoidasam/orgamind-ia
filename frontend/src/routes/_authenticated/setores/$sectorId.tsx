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
import type { SectorDetail } from "@/features/internal-admin/schemas";
import { useSectorPeople } from "@/features/sector-people/api";
import { AddPeopleDialog } from "@/features/sector-people/components/add-people-dialog";
import { EditPersonDialog } from "@/features/sector-people/components/edit-person-dialog";
import { EmptySector } from "@/features/sector-people/components/empty-sector";
import { PeopleTable } from "@/features/sector-people/components/people-table";
import { isSectorForbidden, SECTOR_FORBIDDEN_MESSAGE } from "@/features/sector-people/error-messages";
import type { SectorPeopleResponse, SectorPerson } from "@/features/sector-people/schemas";

const route = createFileRoute("/_authenticated/setores/$sectorId")({
  component: SectorDetailPage,
});
export { route as Route };

function SectorDetailPage() {
  const { sectorId } = route.useParams();
  const isAdmin = useAuthStore((state) => state.user?.role === "ADMIN");
  const people = useSectorPeople(sectorId);
  if (people.isError) {
    return isSectorForbidden(people.error) ? (
      <p role="alert" className="rounded-lg border p-6 text-sm">{SECTOR_FORBIDDEN_MESSAGE}</p>
    ) : (
      <QueryErrorFallback error={people.error} onRetry={people.refetch} />
    );
  }
  if (!people.data) return <Skeleton className="h-64 w-full" />;
  return (
    <main className="mx-auto max-w-4xl space-y-6">
      <SectorHeader data={people.data} />
      <PeopleSection sectorId={sectorId} data={people.data} />
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
      </div>
      <Button asChild variant="outline">
        <Link to="/setores">Voltar</Link>
      </Button>
    </header>
  );
}

function PeopleSection({ sectorId, data }: { sectorId: string; data: SectorPeopleResponse }) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SectorPerson | null>(null);
  const openAdd = () => setAddOpen(true);
  const addDialog = <AddPeopleDialog sectorId={sectorId} options={data.options} open={addOpen} onOpenChange={setAddOpen} />;
  if (data.people.length === 0) {
    return (
      <>
        <EmptySector onAddPeople={openAdd} />
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
      <PeopleTable sectorId={sectorId} people={data.people} onEdit={setEditing} />
      {editing && (
        <EditPersonDialog
          sectorId={sectorId}
          person={editing}
          options={data.options}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </section>
  );
}

/** Só o ADMIN: estado, números vinculados e o formulário do setor. */
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
    <section className="grid gap-4 rounded-xl border p-4 md:grid-cols-2">
      <div className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">Estado</h2>
        <Badge variant={sector.isActive ? "secondary" : "outline"}>
          {sector.isActive ? "Ativo" : "Inativo"}
        </Badge>
        {sector.description ? <p className="text-sm text-muted-foreground">{sector.description}</p> : null}
      </div>
      <div className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">Números vinculados</h2>
        {sector.numbers.length ? (
          <ul className="flex flex-wrap gap-2">
            {sector.numbers.map((number) => (
              <li key={number.id}><Link className="rounded-md border px-2 py-1 text-sm underline" to="/connect">{number.name} · {number.phone}</Link></li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nenhum número vinculado.</p>}
      </div>
    </section>
  );
}
