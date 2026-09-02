import { Checkbox } from '@/components/ui/checkbox';
import { useCampaigns } from '@/features/campaigns/api';
import { useTemplates } from '@/features/templates/api';
import type { HistoryExclusionSelection } from '../history-exclusion';

type Props = {
  campaignIds: string[];
  templateIds: string[];
  onChange: (next: HistoryExclusionSelection) => void;
};

/**
 * F1 T7 — "Excluir quem já recebeu". Two multi-selects (past campaigns and
 * templates) that let the operator narrow a NEW campaign's audience by
 * exclusion. Selecting/clearing here only updates the controlled selection —
 * `FilterStep` (routes/_authenticated/campaigns/new.tsx) is what materializes
 * it into a single `history` filter node via
 * `materializeHistoryExclusion` (history-exclusion.ts), ANDed with the rest of
 * the audience filter.
 *
 * Reuses the checkbox-list pattern already established by
 * `FacetFilters`/`FacetSection` (there's no generic MultiSelect/Combobox
 * component in this codebase yet) rather than introducing a new widget.
 */
export function HistoryExclusionBlock({ campaignIds, templateIds, onChange }: Props) {
  const { data: campaigns } = useCampaigns();
  const { data: templates } = useTemplates();

  const toggleCampaign = (id: string, checked: boolean) => {
    onChange({
      campaignIds: checked
        ? [...campaignIds, id]
        : campaignIds.filter((c) => c !== id),
      templateIds,
    });
  };

  const toggleTemplate = (id: string, checked: boolean) => {
    onChange({
      campaignIds,
      templateIds: checked
        ? [...templateIds, id]
        : templateIds.filter((t) => t !== id),
    });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-semibold">Excluir quem já recebeu</h3>
        <p className="text-xs text-muted-foreground">
          Contatos que já receberam alguma mensagem das campanhas ou templates
          marcados abaixo ficam de fora desta audiência.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ExclusionList
          title="Campanhas"
          items={(campaigns ?? []).map((c) => ({ id: c.id, label: c.name }))}
          selected={campaignIds}
          onToggle={toggleCampaign}
          emptyLabel="Nenhuma campanha anterior."
        />
        <ExclusionList
          title="Templates"
          items={(templates ?? []).map((t) => ({
            id: t.id,
            label: `${t.metaName} (${t.language})`,
          }))}
          selected={templateIds}
          onToggle={toggleTemplate}
          emptyLabel="Nenhum template anterior."
        />
      </div>
    </div>
  );
}

function ExclusionList({
  title,
  items,
  selected,
  onToggle,
  emptyLabel,
}: {
  title: string;
  items: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string, checked: boolean) => void;
  emptyLabel: string;
}) {
  const sel = new Set(selected);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const checked = sel.has(item.id);
            return (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => onToggle(item.id, v === true)}
                  aria-label={item.label}
                />
                <span className="truncate text-sm">{item.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
