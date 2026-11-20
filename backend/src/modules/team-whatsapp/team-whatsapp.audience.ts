import type { AudienceEntry } from './audience-classify';

/**
 * Público final do envio (CF6): cada pessoa uma vez. `included` recebe
 * (`reason` nulo); `excluded` fica de fora com o motivo (GF6). `unknownSelected`
 * são os ids da seleção nominal que não aparecem em nenhum setor; o chamador
 * decide o erro (GF7/GF9).
 */
export type Audience = {
  included: AudienceEntry[];
  excluded: AudienceEntry[];
  unknownSelected: string[];
};

/**
 * Uma entrada por pessoa, na ordem recebida (setores e, dentro deles, pessoas).
 * Quem entrou em algum setor conta como incluída no primeiro em que entrou
 * (o incluído tem prioridade sobre o excluído); senão, fica excluída com o
 * motivo do primeiro setor em que aparece.
 */
function onePerPerson(entries: readonly AudienceEntry[]): AudienceEntry[] {
  const entered = new Set(
    entries.filter((e) => e.reason === null).map((e) => e.member.id),
  );
  const kept = new Set<string>();
  return entries.filter(({ member, reason }) => {
    if (kept.has(member.id) || (reason !== null && entered.has(member.id)))
      return false;
    kept.add(member.id);
    return true;
  });
}

/**
 * Seleção nominal (GF7): só restringe. Quem entraria e não foi marcado vira
 * `not_selected`; quem foi marcado e já estava de fora mantém o motivo próprio
 * (GF6), nunca `not_selected`.
 */
function restrictTo(
  people: readonly AudienceEntry[],
  userIds: readonly string[],
): AudienceEntry[] {
  const wanted = new Set(userIds);
  return people.map((entry) =>
    entry.reason === null && !wanted.has(entry.member.id)
      ? { ...entry, reason: 'not_selected' }
      : entry,
  );
}

const split = (
  people: readonly AudienceEntry[],
  unknownSelected: string[],
): Audience => ({
  included: people.filter((e) => e.reason === null),
  excluded: people.filter((e) => e.reason !== null),
  unknownSelected,
});

/**
 * Junta o público dos setores pedidos (a classificação de cada um vem de
 * `classifySector`, T4a). `userIds` ausente ou vazio = sem seleção; com ids, só
 * eles recebem. Ids repetidos contam uma vez e id fora de todos os setores vai
 * para `unknownSelected` sem entrar nas listas.
 */
export function buildAudience(input: {
  sectors: readonly AudienceEntry[][];
  userIds: readonly string[] | undefined;
}): Audience {
  const { sectors, userIds } = input;
  const entries = sectors.flat();
  const people = onePerPerson(entries);
  if (!userIds || userIds.length === 0) return split(people, []);
  const known = new Set(entries.map((e) => e.member.id));
  const unknown = [...new Set(userIds)].filter((id) => !known.has(id));
  return split(restrictTo(people, userIds), unknown);
}
