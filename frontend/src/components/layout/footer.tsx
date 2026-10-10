import { latestRelease } from '@/release-notes';
import { formatRelativeToToday } from '@/lib/format-date-ptbr';
import { PRODUCT_NAME, WORKSPACE_NAME } from '@/lib/brand';

/**
 * Rodapé do layout autenticado: versão publicada mais recente e há quanto
 * tempo ela saiu, lidas de `RELEASE_NOTES` (ver `release-notes.ts`). Sem
 * rede — o build já carrega a lista.
 */
export function Footer() {
  const latest = latestRelease();
  return (
    <footer
      className="mt-6 border-t px-3 py-4 text-xs sm:px-5 lg:px-8"
      style={{ borderColor: 'var(--border)', color: 'var(--foreground-subtle)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span>{WORKSPACE_NAME} · Ambiente interno</span>
        <span>{PRODUCT_NAME} · Versão {latest.version} · atualizado {formatRelativeToToday(latest.date)}</span>
      </div>
    </footer>
  );
}
