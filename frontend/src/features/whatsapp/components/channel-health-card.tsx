import type { ChannelHealth } from '../api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * O quality rating da Meta é calculado a partir de BLOQUEIOS e DENÚNCIAS dos
 * destinatários nos últimos 7 dias. `UNKNOWN` é "sem dados" (número novo ou de
 * baixo volume), NÃO "ruim" — chamá-lo de ruim faria o operador tratar um número
 * saudável como queimado.
 */
const QUALITY: Record<string, { label: string; className: string }> = {
  GREEN: {
    label: 'Boa',
    className:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  YELLOW: {
    label: 'Média',
    className:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  },
  RED: {
    label: 'Ruim',
    className:
      'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  },
  FLAGGED: {
    label: 'Sinalizada',
    className:
      'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  },
  UNKNOWN: {
    label: 'Sem dados',
    className:
      'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
  },
};

const NEUTRAL =
  'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300';

/**
 * O veredito da Meta sobre ENVIAR. `LIMITED` ≠ `BLOCKED`: o número envia, mas
 * capado — e o teto efetivo fica menor do que o tier nominal sugere.
 */
const CAN_SEND: Record<string, { label: string; className: string }> = {
  AVAILABLE: { label: 'Liberado', className: QUALITY.GREEN.className },
  LIMITED: { label: 'Limitado', className: QUALITY.YELLOW.className },
  BLOCKED: { label: 'Bloqueado', className: QUALITY.RED.className },
};

function Badge({
  children,
  className,
  ...rest
}: {
  children: React.ReactNode;
  className: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/** "sincronizado há X" — sem lib, mesmo padrão da página Templates. */
function syncLabel(syncedAt: Date, stale: boolean): string {
  const mins = Math.floor(Math.max(0, Date.now() - syncedAt.getTime()) / 60_000);
  const rel =
    mins < 1
      ? 'agora'
      : mins < 60
        ? `há ${mins} min`
        : `há ${Math.floor(mins / 60)} h`;
  // `stale` = a leitura rica falhou e o que está na tela veio do cache/banco.
  // Dizer isso em voz alta é o ponto: dado velho disfarçado de fresco é o que
  // faz alguém disparar confiante em cima de um número queimado.
  return stale
    ? `sincronizado ${rel} · dados em cache (Zernio não respondeu)`
    : `sincronizado ${rel}`;
}

/**
 * ZB — a saúde de UM canal cloud, na página Canais. É o que o operador precisa
 * ver ANTES de disparar; hoje ele não vê nada.
 *
 * Três coisas, nesta ordem de gravidade:
 *  1. **Nome de exibição DECLINED** — o caso real do cliente. O destinatário vê
 *     o NÚMERO, não o nome do negócio: a confiança cai, o bloqueio/denúncia
 *     sobe, e é exatamente isso que despenca o quality rating.
 *  2. **Teto do tier** — usuários ÚNICOS em 24h ROLANTES. Estourar → rejeição em
 *     massa da Meta → o tier CAI. O alerta chega a 80%, com folga para parar.
 *  3. **Quality rating** — o termômetro dos 7 dias anteriores.
 */
export function ChannelHealthCard({ health }: { health: ChannelHealth }) {
  const quality = health.qualityRating
    ? (QUALITY[health.qualityRating.toUpperCase()] ?? {
        label: health.qualityRating,
        className: NEUTRAL,
      })
    : { label: 'Sem dados', className: NEUTRAL };

  const canSend = health.canSendMessage
    ? (CAN_SEND[health.canSendMessage.toUpperCase()] ?? {
        label: health.canSendMessage,
        className: NEUTRAL,
      })
    : null;

  const declined = health.nameStatus?.toUpperCase() === 'DECLINED';
  // A barra pode passar de 100% (a guarda do worker só impede um destinatário
  // NOVO; quem já está na janela continua passando) — travar em 100 evita uma
  // barra que vaza do card.
  const barPct = Math.min(100, health.tierUsagePct);

  return (
    <div className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{health.channelName}</strong>
        {health.displayPhoneNumber && (
          <span className="text-xs text-[var(--foreground-muted)]">
            {health.displayPhoneNumber}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-[var(--foreground-muted)]">
          qualidade
        </span>
        <Badge data-testid="quality-rating" className={quality.className}>
          {quality.label}
        </Badge>
        {canSend && (
          <>
            <span className="text-[11px] text-[var(--foreground-muted)]">
              envio
            </span>
            <Badge data-testid="can-send" className={canSend.className}>
              {canSend.label}
            </Badge>
          </>
        )}
      </div>

      {/* Teto do tier + quanto já foi gasto na janela ROLANTE de 24h. */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-[var(--foreground-muted)]">
            {health.messagingLimitTier ?? 'tier desconhecido'} ·{' '}
            <strong className="text-[var(--foreground)]">
              {health.uniqueRecipients24h.toLocaleString('pt-BR')} /{' '}
              {health.tierLimit.toLocaleString('pt-BR')}
            </strong>{' '}
            destinatários únicos em 24h
          </span>
          <span className="text-[var(--foreground-muted)]">
            {health.tierUsagePct}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
          <div
            className={`h-full rounded-full ${
              health.nearTierLimit ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </div>

      {health.nearTierLimit && (
        <Alert>
          <AlertTitle>
            Perto do teto do tier ({health.tierUsagePct}%)
          </AlertTitle>
          <AlertDescription>
            O teto da Meta é de destinatários ÚNICOS em 24h ROLANTES. Estourá-lo
            faz a Meta rejeitar as mensagens em massa, o que derruba a qualidade
            do número e pode REBAIXAR o tier. Pare de enfileirar e retome depois
            da janela.
          </AlertDescription>
        </Alert>
      )}

      {declined && (
        <Alert>
          <AlertTitle>Nome de exibição reprovado pela Meta</AlertTitle>
          <AlertDescription>
            O destinatário vê o número, não o nome do negócio — isso derruba a
            confiança e aumenta bloqueios e denúncias, que são o que despenca a
            qualidade do número.
            {health.nameRejectionReason
              ? ` Motivo da Meta: ${health.nameRejectionReason}.`
              : ''}
          </AlertDescription>
        </Alert>
      )}

      {canSend && health.canSendMessageReason && (
        <p className="text-xs text-[var(--foreground-muted)]">
          {health.canSendMessageReason}
        </p>
      )}

      <p
        data-testid="synced-at"
        className="text-[11px] text-[var(--foreground-muted)]"
      >
        {syncLabel(health.syncedAt, health.stale)}
      </p>
    </div>
  );
}
