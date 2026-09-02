import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentEditor } from "@/features/segments/components/segment-editor";
import { useCreateSegment } from "@/features/segments/api";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/segments/new")({
  component: NewSegmentPage,
});

function NewSegmentPage() {
  const navigate = useNavigate();
  const create = useCreateSegment();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Novo segmento</h1>
        <Button variant="ghost" asChild>
          <Link to="/segments">Voltar</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Definir filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <SegmentEditor
            submitting={create.isPending}
            onSubmit={async (input) => {
              try {
                const s = await create.mutateAsync(input);
                toast.success("Segmento criado!");
                navigate({
                  to: "/segments/$segmentId",
                  params: { segmentId: s.id },
                });
              } catch {
                toast.error("Falha ao criar segmento (nome já existe?)");
              }
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
