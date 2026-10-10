import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { extractApiError } from "@/lib/api-error";
import { useCreateSector } from "@/features/internal-admin/api";
import { SectorForm } from "@/features/internal-admin/components/sector-form";

const route = createFileRoute("/_authenticated/setores/new")({
  component: NewSectorPage,
});
export { route as Route };

function NewSectorPage() {
  const navigate = useNavigate();
  const create = useCreateSector();
  return (
    <main className="mx-auto max-w-xl space-y-5">
      <header>
        <p className="ds-eyebrow">administração / setores</p>
        <h1 className="ds-display !text-3xl">Novo setor.</h1>
      </header>
      <SectorForm
        pending={create.isPending}
        onCancel={() => navigate({ to: "/setores" })}
        onSubmit={async (input) => {
          try {
            await create.mutateAsync(input);
            toast.success("Setor criado");
            await navigate({ to: "/setores" });
          } catch (error) {
            const apiError = await extractApiError(error);
            toast.error(apiError.title, { description: apiError.message });
          }
        }}
      />
    </main>
  );
}
