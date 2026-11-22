import { createFileRoute } from "@tanstack/react-router";
import { PendenciesPage } from "@/features/team-pendencies/components/pendencies-page";

export const Route = createFileRoute("/_authenticated/pendencias-equipe")({
  component: PendenciesPage,
});
