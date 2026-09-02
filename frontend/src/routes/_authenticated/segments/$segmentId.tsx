import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentEditor } from "@/features/segments/components/segment-editor";
import { SegmentPreviewPanel } from "@/features/segments/components/segment-preview-panel";
import { useSegment, useUpdateSegment } from "@/features/segments/api";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/segments/$segmentId")({
  component: SegmentDetailPage,
});

function SegmentDetailPage() {
  const { segmentId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useSegment(segmentId);
  const update = useUpdateSegment(segmentId);

  if (isError) {
    return <QueryErrorFallback error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {data?.name ?? "Segmento"}
        </h1>
        <Button variant="ghost" asChild>
          <Link to="/segments">Voltar</Link>
        </Button>
      </div>

      {isLoading || !data ? (
        <p>Carregando...</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Editar segmento</CardTitle>
            </CardHeader>
            <CardContent>
              <SegmentEditor
                submitting={update.isPending}
                initial={{
                  name: data.name,
                  description: data.description,
                  filters: data.filters,
                }}
                onSubmit={async (input) => {
                  try {
                    await update.mutateAsync(input);
                    toast.success("Segmento atualizado!");
                  } catch {
                    toast.error("Falha ao atualizar segmento");
                  }
                }}
              />
            </CardContent>
          </Card>

          <div>
            <Card>
              <CardHeader>
                <CardTitle>Audiência</CardTitle>
              </CardHeader>
              <CardContent>
                <SegmentPreviewPanel segmentId={segmentId} />
              </CardContent>
            </Card>
            <Button
              className="mt-3 w-full"
              variant="outline"
              onClick={() => navigate({ to: "/segments" })}
            >
              Concluir
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
