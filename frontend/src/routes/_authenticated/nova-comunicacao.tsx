import { createFileRoute } from "@tanstack/react-router";
import { CommunicationWizard } from "@/features/internal-communications/components/communication-wizard";

const route = createFileRoute("/_authenticated/nova-comunicacao")({
  validateSearch: (search: Record<string, unknown>) => ({
    kind:
      search.kind === "ANNOUNCEMENT" ? ("ANNOUNCEMENT" as const) : undefined,
  }),
  component: NewCommunicationPage,
});
export { route as Route };

function NewCommunicationPage() {
  const { kind } = route.useSearch();
  return <CommunicationWizard initialKind={kind} />;
}
