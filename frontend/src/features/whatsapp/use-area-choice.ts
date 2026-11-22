import { useState } from 'react';
import { useSectors } from '@/features/internal-admin/api';
import { sectorMoves } from './sector-moves';

/**
 * A escolha de áreas de um número (campo `Áreas`): setores ativos, o que está
 * marcado e a confirmação de mover (D16). `channelId` é `null` na criação.
 * `proceed` só roda a ação quando não há o que mover ou depois de o operador
 * confirmar; senão abre a confirmação e a ação espera.
 */
export function useAreaChoice(channelId: string | null, initial: readonly string[] = []) {
  const query = useSectors(true);
  const sectors = query.data?.items ?? [];
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [confirming, setConfirming] = useState(false);
  const moves = sectorMoves(selected, sectors, channelId);

  return {
    sectors,
    loading: query.isLoading,
    selected,
    setSelected,
    moves,
    confirming,
    dismiss: () => setConfirming(false),
    reset: () => {
      setSelected([...initial]);
      setConfirming(false);
    },
    proceed: (run: () => Promise<void> | void) => {
      if (moves.length > 0 && !confirming) {
        setConfirming(true);
        return undefined;
      }
      return run();
    },
  };
}
