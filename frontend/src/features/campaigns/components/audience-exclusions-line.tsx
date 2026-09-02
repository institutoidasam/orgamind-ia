/**
 * POR QUE O NÚMERO DA PRÉVIA É MENOR DO QUE O FILTRO ENCONTROU — numa linha.
 *
 * O operador monta o filtro, lê "13.400", e a prévia mostra 13.100. Sem esta
 * linha ele não tem como saber onde foram parar os 300 — e foi exatamente esse
 * silêncio que custou a tarde de 2026-08-11.
 *
 * `items` é uma LISTA de propósito: a exclusão do mesmo template (Fase A) e a
 * dos inválidos confirmados (Fase B) são calculadas por caminhos diferentes e
 * chegam em momentos diferentes. Quem acrescenta uma exclusão nova acrescenta
 * um item — este componente não precisa saber quais existem.
 */
export type AudienceExclusionItem = {
  /** O texto em PT-BR, escrito para o operador. Ex.: "inválidos confirmados (excluídos)". */
  label: string;
  count: number;
};

export function AudienceExclusionsLine({
  total,
  items,
}: {
  /** O público ANTES das exclusões — a soma do que a prévia mostra com o que ela tirou. */
  total: number;
  items: AudienceExclusionItem[];
}) {
  const visiveis = items.filter((i) => i.count > 0);
  if (total <= 0 && visiveis.length === 0) return null;

  return (
    <p
      data-testid="audience-exclusions"
      className="text-xs text-muted-foreground"
    >
      <strong>{total.toLocaleString('pt-BR')}</strong> no público
      {visiveis.map((item) => (
        <span key={item.label}>
          {' · '}
          <strong>{item.count.toLocaleString('pt-BR')}</strong> {item.label}
        </span>
      ))}
    </p>
  );
}
