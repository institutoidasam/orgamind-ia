import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { useSectors } from "@/features/internal-admin/api";
import type { Sector } from "@/features/internal-admin/schemas";

const route = createFileRoute("/_authenticated/setores/")({
  component: SectorsPage,
});
export { route as Route };

function SectorsPage() {
  const sectors = useSectors();
  if (sectors.isError)
    return (
      <QueryErrorFallback error={sectors.error} onRetry={sectors.refetch} />
    );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="ds-eyebrow">administração · estrutura</p>
          <h1 className="ds-display !text-3xl">Setores.</h1>
          <p className="text-sm text-muted-foreground">
            Origem, destino e responsáveis pelas comunicações internas.
          </p>
        </div>
        <Button asChild>
          <Link to="/setores/new">
            <Plus className="mr-2 size-4" />
            Novo setor
          </Link>
        </Button>
      </header>
      <SectorTable
        loading={sectors.isLoading}
        items={sectors.data?.items ?? []}
      />
    </div>
  );
}

function SectorTable({
  loading,
  items,
}: {
  loading: boolean;
  items: Sector[];
}) {
  if (loading)
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((n) => (
          <Skeleton key={n} className="h-12 w-full" />
        ))}
      </div>
    );
  if (!items.length)
    return (
      <p className="rounded-lg border p-6 text-sm text-muted-foreground">
        Nenhum setor cadastrado.
      </p>
    );
  return <SectorTableContent items={items} />;
}

function SectorTableContent({ items }: { items: Sector[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Setor</TableHead>
            <TableHead>Gestor</TableHead>
            <TableHead>Equipe</TableHead>
            <TableHead>Números</TableHead>
          </TableRow>
        </TableHeader>
        <SectorRows items={items} />
      </Table>
    </div>
  );
}

function SectorRows({ items }: { items: Sector[] }) {
  return <TableBody>{items.map((sector) => <SectorRow key={sector.id} sector={sector} />)}</TableBody>;
}

function SectorRow({ sector }: { sector: Sector }) {
  return (
    <TableRow>
      <TableCell>
        <Link className="font-medium underline" to="/setores/$sectorId" params={{ sectorId: sector.id }}>{sector.name}</Link>
        <p className="text-xs text-muted-foreground">{sector.code} · {sector.isActive ? "Ativo" : "Inativo"}</p>
      </TableCell>
      <TableCell>{sector.manager?.name ?? sector.manager?.email ?? "A definir"}</TableCell>
      <TableCell>{sector.memberCount}</TableCell>
      <TableCell><Badge variant="outline">{sector.numberCount}</Badge></TableCell>
    </TableRow>
  );
}
