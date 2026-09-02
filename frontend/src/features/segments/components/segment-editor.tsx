import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FilterBuilder } from "@/features/campaigns/components/filter-builder";
import type { CreateSegment, FilterGroup } from "../schemas";

type Props = {
  onSubmit: (input: CreateSegment) => void;
  submitting: boolean;
  initial?: {
    name?: string;
    description?: string | null;
    filters?: FilterGroup;
  };
};

const EMPTY_FILTERS: FilterGroup = { combinator: "and", rules: [] };

export function SegmentEditor({ onSubmit, submitting, initial }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [filters, setFilters] = useState<FilterGroup>(
    initial?.filters ?? EMPTY_FILTERS,
  );

  // Did the segment start with a description? If so, an empty box means the
  // operator intentionally cleared it and we must send `null` to persist that.
  // For a brand-new segment with no description, send `undefined` (omit it).
  const hadInitialDescription = Boolean(initial?.description);

  const handleSubmit = () => {
    const trimmed = description.trim();
    // `null` clears an existing description on the PATCH; `undefined` is a no-op
    // the backend ignores (fine for a brand-new segment). The cast is needed
    // because CreateSegment.description is `string | undefined`, but the wire
    // contract (PATCH /segments/:id) must accept `null` to actually clear it.
    const descriptionToSend = trimmed
      ? trimmed
      : hadInitialDescription
        ? null
        : undefined;
    onSubmit({
      name,
      description: descriptionToSend,
      filters,
    } as CreateSegment);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="segment-name">Nome</Label>
        <Input
          id="segment-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: VIP de Manaus"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="segment-description">Descrição (opcional)</Label>
        <Textarea
          id="segment-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Para que serve este segmento?"
        />
      </div>

      <div className="space-y-2">
        <Label>Filtros</Label>
        <FilterBuilder value={filters} onChange={setFilters} />
      </div>

      <div className="flex justify-end border-t pt-4">
        <Button disabled={submitting || !name} onClick={handleSubmit}>
          {submitting ? "Salvando…" : "Salvar segmento"}
        </Button>
      </div>
    </div>
  );
}
