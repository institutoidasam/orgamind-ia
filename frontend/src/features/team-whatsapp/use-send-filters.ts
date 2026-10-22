import { useState } from 'react';
import type { ShiftChoice } from './member-filter';
import type { TeamSector } from './schemas';

type Filters = {
  /** null = ainda não mexeu: vazio, ou o único setor possível (já escolhido). */
  sectorIds: string[] | null;
  levelIds: string[];
  withoutLevel: boolean;
  choice: ShiftChoice | null;
  date: string;
  includeOff: boolean;
};

/**
 * Filtros da tela de envio (setores, níveis, data, turno, "incluir quem está de folga") e a seleção.
 * Qualquer mudança nos filtros limpa a seleção: o que vai no POST é a lista conferida (D4).
 * A data inicial é `today` do servidor (GC5), nunca o relógio do navegador.
 */
export function useSendFilters(today: string, sectors: readonly TeamSector[]) {
  const [filters, setFilters] = useState<Filters>({
    sectorIds: null, levelIds: [], withoutLevel: false, choice: null, date: today, includeOff: false,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const update = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setSelected(new Set());
  };
  return {
    ...filters,
    sectorIds: filters.sectorIds ?? (sectors.length === 1 ? [sectors[0].id] : []),
    selected,
    setSelected,
    pickSectors: (sectorIds: string[]) => update({ sectorIds }),
    pickLevels: (levelIds: string[], withoutLevel: boolean) => update({ levelIds, withoutLevel }),
    pickDate: (date: string) => update({ date }),
    pickChoice: (choice: ShiftChoice) => update({ choice, includeOff: false }),
    toggleOff: (includeOff: boolean) => update({ includeOff }),
    viewShift: (date: string, shiftId: string) => update({ date, choice: shiftId, includeOff: false }),
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
  };
}
