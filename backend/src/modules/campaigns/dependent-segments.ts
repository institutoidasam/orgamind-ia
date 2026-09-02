import type { FilterGroup } from '../../schemas/contracts/filter.schema';
import {
  isGroup,
  isHistoryRule,
  type FilterNode,
} from './history-filter.resolver';

export type SegmentFilterRow = {
  id: string;
  name: string;
  /** Coluna JSON crua (`Segment.filters`); a forma esperada é `FilterGroup`. */
  filters: unknown;
};

/** Recursivamente procura um nó history cujo campaignIds contenha `campaignId`. */
function referencesCampaign(node: FilterNode, campaignId: string): boolean {
  if (isGroup(node)) {
    return node.rules.some((child) => referencesCampaign(child, campaignId));
  }
  if (isHistoryRule(node)) {
    return (node.campaignIds ?? []).includes(campaignId);
  }
  return false;
}

/**
 * F1 T9 — quais Segmentos ficam com um filtro "furado" se `campaignId` for
 * apagada: `Message.campaignId` é `onDelete: Cascade`, e um Segment com um nó
 * `{kind:'history', campaignIds:[campaignId]}` (em qualquer profundidade da
 * árvore, inclusive dentro de grupos aninhados) silenciosamente para de
 * excluir quem já recebeu dela assim que o registro some.
 *
 * Varre em memória sobre a lista já carregada — não há WHERE do Postgres
 * simples para "existe um nó history aninhado com este campaignId" dentro de
 * um JSON de forma arbitrária, e um índice GIN dedicado seria overkill para
 * uma tela de aviso.
 */
export function findSegmentsReferencingCampaign(
  segments: SegmentFilterRow[],
  campaignId: string,
): { id: string; name: string }[] {
  return segments
    .filter((s) => {
      const filters = s.filters;
      if (!filters || typeof filters !== 'object' || !('combinator' in filters)) {
        return false;
      }
      return referencesCampaign(filters as FilterGroup, campaignId);
    })
    .map((s) => ({ id: s.id, name: s.name }));
}
