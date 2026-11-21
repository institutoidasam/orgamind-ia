import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/stores/auth.store";
import { usePermission } from "@/features/permissions/use-permission";
import { ExportPeopleButton } from "@/features/people-export/components/export-people-button";
import { SectorForm } from "@/features/internal-admin/components/sector-form";
import { useSector, useUpdateSector } from "@/features/internal-admin/api";
import { SectorInactivateDialog } from "@/features/internal-admin/components/sector-inactivate-dialog";
import { SectorNumber } from "@/features/internal-admin/components/sector-number";
import { useSectorSave } from "@/features/internal-admin/use-sector-save";
import type { SectorChannel, SectorDetail } from "@/features/internal-admin/schemas";
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
  const canManageStructure = usePermission("estrutura.manter");
  const [includeInactive, setIncludeInactive] = useState(false);
  const people = useSectorPeople(sectorId, { includeInactive });
  const data = useLatestData(people.data);
  if (people.isError) {
    if (!isSectorForbidden(people.error)) return <QueryErrorFallback error={people.error} onRetry={people.refetch} />;
    return canManageStructure ? <StructureOnly sectorId={sectorId} showNumber={isAdmin} /> : <SectorForbiddenNotice />;
  }
  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <main className="mx-auto max-w-4xl space-y-6">
      <SectorHeader sector={data.sector} exportSectorId={sectorId} />
      <PeopleSection sectorId={sectorId} data={data} includeInactive={includeInactive} onIncludeInactive={setIncludeInactive} />
      {canManageStructure && <AdminPanel sectorId={sectorId} />}
    </main>
  );
}

function SectorForbiddenNotice() {
  return <p role="alert" className="rounded-lg border p-6 text-sm">{SECTOR_FORBIDDEN_MESSAGE}</p>;
}

/**
 * `estrutura.manter` em setor que o ator não gerencia: a estrutura (cabeçalho e painel) vem de
 * `useSector`; o aviso de setor não gerenciado fica no lugar da lista de pessoas.
 */
function StructureOnly({ sectorId, showNumber }: { sectorId: string; showNumber: boolean }) {
  const sector = useSector(sectorId);
  return (
    <main className="mx-auto max-w-4xl space-y-6">
      {sector.data && <SectorHeader sector={sector.data} showNumber={showNumber} />}
      <SectorForbiddenNotice />
      <AdminPanel sectorId={sectorId} />
    </main>
  );
}

type HeaderSector = {
  code: string;
  isActive: boolean;
  name: string;
  manager: { name: string | null } | null;
  channel: SectorChannel | null;
};

/**
 * `showNumber` falso: o número do setor (GB5) continua só do ADMIN onde a página não vem da lista de pessoas.
 * `exportSectorId` só vem onde a lista de pessoas carregou: no `StructureOnly` o setor não é do ator e a exportação daria 403.
 */
function SectorHeader({ sector, showNumber = true, exportSectorId }: { sector: HeaderSector; showNumber?: boolean; exportSectorId?: string }) {
  return (
    <header className="flex justify-between gap-3">
      <div>
        <p className="ds-eyebrow">{sector.code} · {sector.isActive ? "Ativo" : "Inativo"}</p>
        <h1 className="ds-display !text-3xl">{sector.name}.</h1>
        <p className="text-sm text-muted-foreground">Gestor: {sector.manager?.name ?? "A definir"}</p>
        {showNumber && <p className="flex items-center gap-2 text-sm text-muted-foreground">Número: <SectorNumber channel={sector.channel} /></p>}
      </div>
      <div className="flex items-start gap-2">
        {exportSectorId && <ExportPeopleButton defaultSectorId={exportSectorId} />}
        <Button asChild variant="outline">
          <Link to="/setores">Voltar</Link>
        </Button>
      </div>
    </header>
  );
}

type SectionProps = {
  sectorId: string;
  data: SectorPeopleResponse;
  includeInactive: boolean;
  onIncludeInactive: (include: boolean) => void;
};

/** Sem `pessoas.editar` o setor vazio mostra só o aviso; o botão de adicionar é do `EmptySector`. */
function EmptyPeople({ canEdit, onAddPeople }: { canEdit: boolean; onAddPeople: () => void }) {
  if (canEdit) return <EmptySector onAddPeople={onAddPeople} />;
  return <p className="rounded-lg border p-6 text-sm text-muted-foreground">Ninguém neste setor ainda.</p>;
}

function PeopleSection({ sectorId, data, includeInactive, onIncludeInactive }: SectionProps) {
  const canEdit = usePermission("pessoas.editar");
  const [addOpen, setAddOpen] = useState(false);
  const refreshTrail = useRefreshAuditTrail();
  const openAdd = () => setAddOpen(true);
  // Mover pessoa para o setor acontece dentro deste diálogo: ao fechar, a trilha é relida.
  const changeAdd = (open: boolean) => {
    setAddOpen(open);
    if (!open) void refreshTrail();
  };
  const addDialog = canEdit && <AddPeopleDialog sectorId={sectorId} options={data.options} open={addOpen} onOpenChange={changeAdd} />;
  if (data.people.length === 0) {
    return (
      <>
        <EmptyPeople canEdit={canEdit} onAddPeople={openAdd} />
        <InactiveToggle checked={includeInactive} onChange={onIncludeInactive} />
        {addDialog}
      </>
    );
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">Pessoas ({data.people.length})</h2>
        {canEdit && <Button aria-haspopup="dialog" aria-expanded={addOpen} onClick={openAdd}>Adicionar pessoas</Button>}
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

/** Quem tem `estrutura.manter`: estado e o formulário do setor. */
function AdminPanel({ sectorId }: { sectorId: string }) {
  const sector = useSector(sectorId);
  const update = useUpdateSector(sectorId);
  const navigate = useNavigate();
  const save = useSectorSave(sectorId, sector.data, update.mutateAsync);
  if (!sector.data) return null;
  return (
    <>
      <SectorReadView sector={sector.data} />
      <section className="max-w-xl space-y-3">
        <h2 className="font-heading text-lg font-semibold">Editar setor</h2>
        <SectorForm
          sector={sector.data}
          usage={sector.data.usage}
          pending={update.isPending}
          onCancel={() => navigate({ to: "/setores" })}
          onSubmit={save.submit}
        />
      </section>
      <SectorInactivateDialog
        open={save.inactivating !== null}
        name={save.inactivating?.name ?? sector.data.name}
        hasAreaNumber={sector.data.channel !== null}
        pending={update.isPending}
        onConfirm={save.confirm}
        onCancel={save.cancel}
      />
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
