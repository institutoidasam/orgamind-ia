import type { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  FilterGroup,
  HistoryRule,
  Rule,
} from '../../schemas/contracts/filter.schema';

// Exportados para reuso por outros varredores da árvore de filtro (F1 T9 —
// dependent-segments.ts varre history nodes sem precisar redefinir os mesmos
// type guards).
export type FilterNode = Rule | HistoryRule | FilterGroup;

export function isGroup(node: FilterNode): node is FilterGroup {
  return 'combinator' in node;
}

export function isHistoryRule(node: FilterNode): node is HistoryRule {
  return 'kind' in node && node.kind === 'history';
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Recursivamente coleta todos os templateIds de qualquer nó history da árvore. */
function collectTemplateIds(node: FilterNode, acc: Set<string>): void {
  if (isGroup(node)) {
    for (const child of node.rules) collectTemplateIds(child, acc);
    return;
  }
  if (isHistoryRule(node)) {
    for (const t of node.templateIds ?? []) acc.add(t);
  }
}

function resolveNode(
  node: FilterNode,
  campaignIdsByTemplate: Map<string, string[]>,
): FilterNode {
  if (isGroup(node)) return resolveGroup(node, campaignIdsByTemplate);
  if (!isHistoryRule(node)) return node;

  const templateIds = node.templateIds ?? [];
  if (!templateIds.length) return node;

  const expanded = templateIds.flatMap(
    (t) => campaignIdsByTemplate.get(t) ?? [],
  );
  const campaignIds = uniq([...(node.campaignIds ?? []), ...expanded]);

  // Zera templateIds no nó devolvido: toPrismaWhere/historyRuleToPrisma (T2)
  // são puros e só leem `campaignIds` — já resolvidos aqui.
  return { ...node, templateIds: undefined, campaignIds };
}

function resolveGroup(
  group: FilterGroup,
  campaignIdsByTemplate: Map<string, string[]>,
): FilterGroup {
  return {
    combinator: group.combinator,
    rules: group.rules.map((child) =>
      resolveNode(child, campaignIdsByTemplate),
    ),
  };
}

/**
 * Percorre a árvore do FilterGroup e, para cada nó history com templateIds,
 * expande em campaignIds (as campanhas daquele template) numa ÚNICA query,
 * unindo aos campaignIds já presentes. Devolve uma árvore NOVA (imutável) com
 * templateIds resolvidos, para o toPrismaWhere (T2) seguir puro/síncrono.
 *
 * Por que este passo é separado e assíncrono: `toPrismaWhere`/`ruleToPrisma`
 * são funções puras e síncronas por design (nenhuma I/O, testáveis sem mock de
 * banco). Resolver template→campanhas exige 1 SELECT — por isso esse SELECT
 * roda AQUI, ANTES do conversor, e nunca dentro dele. F2/F3 reusam este
 * resolver do mesmo jeito, mantendo o conversor puro.
 *
 * Confiável porque a campanha é imutável no domínio (o controller só expõe
 * @Get/@Post/@Delete, nunca @Patch — §1.2): o mapa templateId→campaignIds
 * resolvido aqui não fica obsoleto entre a resolução e o uso da query.
 */
export async function resolveHistoryTargets(
  filter: FilterGroup,
  prisma: Pick<PrismaService, 'campaign'>,
): Promise<FilterGroup> {
  const templateIds = new Set<string>();
  collectTemplateIds(filter, templateIds);

  if (templateIds.size === 0) {
    // Nada para resolver: clone raso evita expor a mesma referência sem
    // precisar de uma query (e sem custo de deep-clone da árvore inteira).
    return { ...filter };
  }

  const campaigns = await prisma.campaign.findMany({
    where: { templateId: { in: [...templateIds] } },
    select: { id: true, templateId: true },
  });

  const campaignIdsByTemplate = new Map<string, string[]>();
  for (const c of campaigns) {
    const list = campaignIdsByTemplate.get(c.templateId);
    if (list) list.push(c.id);
    else campaignIdsByTemplate.set(c.templateId, [c.id]);
  }

  return resolveGroup(filter, campaignIdsByTemplate);
}
