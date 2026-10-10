import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { extractApiError } from "@/lib/api-error";
import { SectorForm } from "@/features/internal-admin/components/sector-form";
import { useSector, useUpdateSector } from "@/features/internal-admin/api";
import type { SectorDetail } from "@/features/internal-admin/schemas";
import { ROLE_LABEL } from "@/features/users/role";

const route = createFileRoute("/_authenticated/setores/$sectorId")({
  component: SectorDetailPage,
});
export { route as Route };

function SectorDetailPage() {
  const { sectorId } = route.useParams();
  const sector = useSector(sectorId);
  const update = useUpdateSector(sectorId);
  const navigate = useNavigate();
  if (sector.isError)
    return <QueryErrorFallback error={sector.error} onRetry={sector.refetch} />;
  if (!sector.data) return <Skeleton className="h-64 w-full" />;
  return (
    <main className="mx-auto max-w-xl space-y-6">
      <header className="flex justify-between gap-3">
        <div>
          <p className="ds-eyebrow">administração / setores</p>
          <h1 className="ds-display !text-3xl">{sector.data.name}.</h1>
          <p className="text-sm text-muted-foreground">
            {sector.data.members.length} pessoa(s) ·{" "}
            {sector.data.numbers.length} número(s) vinculado(s)
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/setores">Voltar</Link>
        </Button>
      </header>
      <SectorReadView sector={sector.data} />
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
    </main>
  );
}

function SectorReadView({ sector }: { sector: SectorDetail }) {
  return (
    <section className="grid gap-4 rounded-xl border p-4 md:grid-cols-2">
      <div className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">Responsável e estado</h2>
        <p className="text-sm">Gestor: {sector.manager?.name ?? sector.manager?.email ?? "A definir"}</p>
        <Badge variant={sector.isActive ? "secondary" : "outline"}>
          {sector.isActive ? "Ativo" : "Inativo"}
        </Badge>
        {sector.description ? <p className="text-sm text-muted-foreground">{sector.description}</p> : null}
      </div>
      <div className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">Pessoas</h2>
        {sector.members.length ? (
          <ul className="space-y-1 text-sm">
            {sector.members.map((member) => (
              <li key={member.id}>
                <Link className="underline" to="/users">{member.name ?? member.email}</Link>{" "}
                <span className="text-muted-foreground">· {ROLE_LABEL[member.role]} · {member.isActive ? "Ativo" : "Inativo"}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nenhuma pessoa vinculada.</p>}
      </div>
      <div className="space-y-2 md:col-span-2">
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
