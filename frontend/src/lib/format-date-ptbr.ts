/**
 * Formatação de datas em PT-BR para o rodapé e o diálogo de "Novidades".
 * Funções puras — sem `Date.now()` implícito onde possa ser evitado (ver
 * `now` opcional em `formatRelativeToToday`), fáceis de testar.
 */

/** 'YYYY-MM-DD' → 'DD/MM/YYYY'. Reslice puro — sem `Date`, sem risco de fuso horário. */
export function formatDatePtBr(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * 'YYYY-MM-DD' → 'hoje' | 'há 1 dia' | 'há N dias', relativo a `now` (default:
 * agora). Compara à meia-noite LOCAL dos dois lados para não sofrer artefato
 * de fuso horário / horário de verão; qualquer diferença ≤ 0 dias vira 'hoje'.
 */
export function formatRelativeToToday(dateStr: string, now: Date = new Date()): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays <= 0) return 'hoje';
  if (diffDays === 1) return 'há 1 dia';
  return `há ${diffDays} dias`;
}
