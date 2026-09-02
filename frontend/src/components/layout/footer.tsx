import { latestRelease } from '@/release-notes';
import { formatRelativeToToday } from '@/lib/format-date-ptbr';

/**
 * Rodapé do layout autenticado: versão publicada mais recente e há quanto
 * tempo ela saiu, lidas de `RELEASE_NOTES` (ver `release-notes.ts`). Sem
 * rede — o build já carrega a lista.
 */
export function Footer() {
  const latest = latestRelease();
  return (
    <footer
      className="mt-6 border-t px-3 py-3 text-xs sm:px-4 lg:px-6"
      style={{ borderColor: 'var(--border)', color: 'var(--foreground-subtle)' }}
    >
      Versão {latest.version} · atualizado {formatRelativeToToday(latest.date)}
    </footer>
  );
}
