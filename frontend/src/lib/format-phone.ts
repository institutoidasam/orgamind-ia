/** Formata um E.164 brasileiro como "(DD) 9XXXX-XXXX"; outros países ficam em E.164; vazio vira "—". */
export function formatPhoneBR(e164: string | null | undefined): string {
  if (!e164) return '—';
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
