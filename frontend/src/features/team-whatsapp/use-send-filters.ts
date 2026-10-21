import { useState } from 'react';
import type { ShiftChoice } from './member-filter';
import type { TeamSector } from './schemas';

type Filters = { sectorId: string | null; choice: ShiftChoice | null; date: string; includeOff: boolean };

/**
 * Filtros da tela de envio (setor, data, turno, "incluir quem está de folga") e a seleção.
 * Qualquer mudança nos filtros limpa a seleção: o que vai no POST é a lista conferida (D4).
 * A data inicial é `today` do servidor (GC5), nunca o relógio do navegador.
 */
export function useSendFilters(today: string, sectors: readonly TeamSector[]) {
  const [filters, setFilters] = useState<Filters>({ sectorId: null, choice: null, date: today, includeOff: false });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const update = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setSelected(new Set());
  };
  return {
    ...filters,
    sectorId: filters.sectorId ?? (sectors.length === 1 ? sectors[0].id : null),
    selected,
    setSelected,
    pickSector: (sectorId: string) => update({ sectorId }),
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
