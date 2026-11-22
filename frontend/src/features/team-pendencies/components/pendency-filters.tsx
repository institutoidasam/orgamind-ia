import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { PendencyFilters } from "../api";
import { SITUATION_LABEL } from "../labels";
import {
  PENDENCY_SITUATIONS,
  type PendencySituation,
  type TeamPendencyList,
} from "../schemas";

type Props = {
  filters: PendencyFilters;
  /** Setores da resposta da lista (o servidor os tira das linhas antes do filtro de setor). */
  sectors: TeamPendencyList["sectors"];
  onChange: (filters: PendencyFilters) => void;
};

const ALL_SECTORS = "";
const SELECT_CLASS = "h-9 rounded-lg border bg-card px-2 text-sm";

/** Toda mudança de filtro volta à página 1 (a página antiga pode nem existir no recorte novo). */
const withFirstPage = (filters: PendencyFilters): PendencyFilters => ({
  ...filters,
  page: 1,
});

function SituationBoxes({ filters, onChange }: Omit<Props, "sectors">) {
  const toggle = (situation: PendencySituation, on: boolean) => {
    const wanted = new Set(filters.situations);
    if (on) wanted.add(situation);
    else wanted.delete(situation);
    onChange(
      withFirstPage({
        ...filters,
        situations: PENDENCY_SITUATIONS.filter((s) => wanted.has(s)),
      }),
    );
  };
  const onlyOne = filters.situations.length === 1;
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="mb-1 text-sm font-medium">Situação</legend>
      {PENDENCY_SITUATIONS.map((situation) => {
        const checked = filters.situations.includes(situation);
        return (
          <div key={situation} className="flex items-center gap-2">
            <Checkbox
              id={`pendency-situation-${situation}`}
              checked={checked}
              // Sem nenhuma marcada o servidor assumiria as três abertas, e a tela mostraria caixas vazias.
              disabled={checked && onlyOne}
              onCheckedChange={(on) => toggle(situation, on === true)}
            />
            <Label htmlFor={`pendency-situation-${situation}`}>
              {SITUATION_LABEL[situation]}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

function PeriodSelect({ filters, onChange }: Omit<Props, "sectors">) {
  const closed = filters.situations.some(
    (s) => s === "ACKED" || s === "CLOSED",
  );
  if (!closed) return null;
  return (
    <div className="space-y-1">
      <Label htmlFor="pendency-period">Período</Label>
      <select
        id="pendency-period"
        className={SELECT_CLASS}
        value={String(filters.days)}
        onChange={(event) =>
          onChange(
            withFirstPage({
              ...filters,
              days: event.target.value === "30" ? 30 : 7,
            }),
          )
        }
      >
        <option value="7">Últimos 7 dias</option>
        <option value="30">Últimos 30 dias</option>
      </select>
    </div>
  );
}

function SectorSelect({ filters, sectors, onChange }: Props) {
  return (
    <div className="space-y-1">
      <Label htmlFor="pendency-sector">Setor</Label>
      <select
        id="pendency-sector"
        className={SELECT_CLASS}
        value={filters.sectorId ?? ALL_SECTORS}
        onChange={(event) =>
          onChange(
            withFirstPage({ ...filters, sectorId: event.target.value || null }),
          )
        }
      >
        <option value={ALL_SECTORS}>Todos os setores</option>
        {sectors.map((sector) => (
          <option key={sector.id} value={sector.id}>
            {sector.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Filtros da tela de pendências, em estado local (sem URL, como a caixa do K1): situação, período, setor, "Minhas". */
export function PendencyFiltersBar({ filters, sectors, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-md border p-3">
      <SituationBoxes filters={filters} onChange={onChange} />
      <PeriodSelect filters={filters} onChange={onChange} />
      <SectorSelect filters={filters} sectors={sectors} onChange={onChange} />
      <div className="flex items-center gap-2 pb-2">
        <Checkbox
          id="pendency-mine"
          checked={filters.mine}
          onCheckedChange={(on) =>
            onChange(withFirstPage({ ...filters, mine: on === true }))
          }
        />
        <Label htmlFor="pendency-mine">Minhas</Label>
      </div>
    </div>
  );
}
