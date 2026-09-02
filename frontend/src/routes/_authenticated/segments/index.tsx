import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useSegments, useDeleteSegment } from "@/features/segments/api";
import { SegmentList } from "@/features/segments/components/segment-list";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/segments/")({
  component: SegmentsPage,
});

function SegmentsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useSegments();
  const remove = useDeleteSegment();

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <header className="space-y-1">
          <div className="ds-eyebrow">segmentos · {data?.length ?? 0}</div>
          <h1 className="ds-display !text-3xl">Segmentos.</h1>
        </header>
        <Button asChild>
          <Link to="/segments/new">Novo segmento</Link>
        </Button>
      </div>
      {isLoading ? (
        <p>Carregando...</p>
      ) : (
        <SegmentList
          segments={data ?? []}
          onSelect={(id) =>
            navigate({ to: "/segments/$segmentId", params: { segmentId: id } })
          }
          onDelete={async (id) => {
            try {
              await remove.mutateAsync(id);
              toast.success("Segmento removido");
            } catch {
              toast.error("Falha ao remover segmento");
            }
          }}
        />
      )}
    </div>
  );
}
