import {
  PACING_JITTER_MIN_MS,
  PACING_JITTER_MAX_MS,
  PACING_BURST_SIZE,
  PACING_BURST_PAUSE_MS,
} from './pacing.helper';
import { TIMEZONE_DEFAULT } from '../../schemas/contracts/schedule.schema';
import type { ScheduleConfig } from '../../schemas/contracts/schedule.schema';

export type CheckSeverity = 'info' | 'warn' | 'block';

export type SendCheck = {
  code:
    | 'VOLUME'
    | 'FREQUENCY'
    | 'REACHABILITY'
    | 'OVERLAP'
    | 'WINDOW'
    | 'OPT_OUT'
    /**
     * U2 — the campaign's default instance is missing or soft-deleted
     * (isActive=false). Appended by the service (computeSendChecks only sees a
     * defensive instance snapshot) and NEVER overridable: sending through a
     * deleted instance is impossible, not merely risky.
     */
    | 'INSTANCE_DELETED';
  severity: CheckSeverity;
  message: string;
};

export type SendCheckInput = {
  /** Resolved recipient count (already opt-out excluded). */
  recipients: number;
  /** WhatsApp reachability summary for the audience. */
  reachability: {
    total: number;
    reachable: number;
    invalid: number;
    unknown: number;
  };
  /** Target instance's warmup / send-window state. */
  instance: {
    sentToday: number;
    dailySendLimit: number;
    sendWindowStartHour: number;
    sendWindowEndHour: number;
    sendWindowEnabled: boolean;
    /**
     * O transporte deste canal ENFILEIRA sozinho o que não cabe no limite de
     * 24h (broadcast do Zernio: o dispatch corta no teto da janela rolante e
     * re-enfileira o excedente até ela abrir). Quando true, audiência maior
     * que o saldo NÃO é risco — é o comportamento contratado — e o check
     * VOLUME informa em vez de bloquear.
     */
    queuesOverflow?: boolean;
  };
  schedule: ScheduleConfig;
  /** Is another campaign already RUNNING on the same instance? */
  hasRunningCampaignOnInstance: boolean;
  /** First scheduled run (UTC), if the broadcast is scheduled. */
  nextRunAt: Date | null;
  timezone?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tunables for the heuristics. Kept local so the checks stay deterministic and
// testable without touching the env-driven pacing knobs.
// ─────────────────────────────────────────────────────────────────────────────

/** Audience size at/above which recurrence is considered "aggressive". */
const LARGE_SEGMENT_THRESHOLD = 1000;

/** Invalid+unknown fraction above which reachability is flagged. */
const REACHABILITY_WARN_FRACTION = 0.3;

/** INTERVAL recurrence shorter than this (minutes) is "aggressive". */
const AGGRESSIVE_INTERVAL_MINUTES = 6 * 60; // 6 hours

/** WEEKLY covering this many weekdays (≈ most of the week) is "aggressive". */
const AGGRESSIVE_WEEKLY_DAYS = 4;

/**
 * Estimate the wall-clock duration (ms) to send `n` messages on one instance,
 * mirroring the worker's pacing: average jitter per send + a burst pause every
 * PACING_BURST_SIZE sends.
 */
export function estimateDurationMs(n: number): number {
  if (n <= 0) return 0;
  const avgJitter = (PACING_JITTER_MIN_MS + PACING_JITTER_MAX_MS) / 2;
  const bursts = Math.floor(n / PACING_BURST_SIZE);
  return n * avgJitter + bursts * PACING_BURST_PAUSE_MS;
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return 'menos de 1 min';
  if (totalMin < 60) return `~${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `~${h}h${String(m).padStart(2, '0')}` : `~${h}h`;
}

/** The local hour-of-day (0–23) of a UTC instant in the given timezone. */
function localHour(date: Date, timezone: string): number {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  // Intl can emit "24" for midnight in some runtimes; normalise to 0.
  const h = Number(hourStr);
  return h === 24 ? 0 : h;
}

function isRecurring(schedule: ScheduleConfig): boolean {
  return (
    schedule.type === 'DAILY_AT' ||
    schedule.type === 'WEEKLY' ||
    schedule.type === 'INTERVAL'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks. Each is a pure function of the input that returns the single
// check it owns (VOLUME / OPT_OUT always; the rest conditionally → `null`).
// computeSendChecks assembles them, in order, into the result list.
// ─────────────────────────────────────────────────────────────────────────────

/** Audience vs the instance's remaining daily budget. Always emitted. */
function checkVolume(input: SendCheckInput): SendCheck {
  const { recipients, instance } = input;
  const durationMs = estimateDurationMs(recipients);
  const remainingBudget = Math.max(
    0,
    instance.dailySendLimit - instance.sentToday,
  );
  const overflowsBudget = recipients > remainingBudget;

  // Canal que enfileira o excedente sozinho (broadcast do Zernio): estourar o
  // saldo é o comportamento CONTRATADO — o disparo corta no teto da janela de
  // 24h e o resto sai quando ela abrir. Exigir "entendo o risco" aqui seria
  // pedir aceite de um risco que não existe.
  if (overflowsBudget && instance.queuesOverflow) {
    const now = Math.min(recipients, remainingBudget);
    const later = recipients - now;
    return {
      code: 'VOLUME',
      severity: 'info',
      message:
        `${recipients} destinatários: ~${now} saem agora e os ${later} restantes ` +
        `entram em fila automaticamente até o limite de 24h liberar ` +
        `(teto atual: ${instance.dailySendLimit}).`,
    };
  }

  // ALERTA, não bloqueio (decisão do dono, 2026-08-12). O estouro do saldo
  // diário é risco de BAN — do número do cliente, que foi informado e assumiu.
  //
  // Bloquear custava caro por um caminho que ninguém previu: o único jeito de
  // furar era marcar "entendo o risco", e essa MESMA flag (`override`) vira,
  // em provedor não-oficial, o override de CONSENTIMENTO — que o backend
  // recusa sem justificativa escrita. O operador que só queria aceitar o risco
  // de ban levava `campaign.override_justification_required` e a campanha não
  // salvava de jeito nenhum: marcar dava 400, não marcar travava o botão.
  //
  // O aviso continua, com o mesmo texto. O que sai é a porta que obrigava a
  // pedir uma autorização muito maior do que a pretendida.
  const volumeAlerts = overflowsBudget && recipients >= 100;
  return {
    code: 'VOLUME',
    severity: volumeAlerts ? 'warn' : 'info',
    message: volumeAlerts
      ? `Enviar para ${recipients} números (${formatDuration(durationMs)} com pacing) excede a capacidade restante hoje desta instância (${remainingBudget} de ${instance.dailySendLimit}). Risco de bloqueio do número.`
      : `Vai enviar para ${recipients} números (${formatDuration(durationMs)} com pacing anti-ban).`,
  };
}

/** Aggressive recurrence over a large segment. */
function checkFrequency(input: SendCheckInput): SendCheck | null {
  const { recipients, schedule } = input;
  if (!(isRecurring(schedule) && recipients >= LARGE_SEGMENT_THRESHOLD)) {
    return null;
  }
  const aggressive =
    schedule.type === 'DAILY_AT' ||
    // A once-a-week (or few-days) send isn't "frequent"; only flag WEEKLY
    // when it covers most of the week (approaching daily).
    (schedule.type === 'WEEKLY' &&
      schedule.weekdays.length >= AGGRESSIVE_WEEKLY_DAYS) ||
    (schedule.type === 'INTERVAL' &&
      schedule.everyMinutes <= AGGRESSIVE_INTERVAL_MINUTES);
  if (!aggressive) return null;
  return {
    code: 'FREQUENCY',
    severity: 'warn',
    message: `Recorrência frequente sobre um segmento grande (${recipients} contatos) aumenta o risco de spam/banimento.`,
  };
}

/** High fraction of invalid/unknown numbers in the audience. */
function checkReachability(input: SendCheckInput): SendCheck | null {
  const { reachability } = input;
  const unreachable = reachability.invalid + reachability.unknown;
  if (
    !(
      reachability.total > 0 &&
      unreachable / reachability.total >= REACHABILITY_WARN_FRACTION
    )
  ) {
    return null;
  }
  const pct = Math.round((unreachable / reachability.total) * 100);
  return {
    code: 'REACHABILITY',
    severity: 'warn',
    message: `${pct}% dos números podem falhar (inválidos ou nunca verificados no WhatsApp).`,
  };
}

/** Another campaign already RUNNING on the same instance. */
function checkOverlap(input: SendCheckInput): SendCheck | null {
  if (!input.hasRunningCampaignOnInstance) return null;
  return {
    code: 'OVERLAP',
    severity: 'warn',
    message:
      'Já existe uma campanha em execução nesta instância. Os envios vão competir pela mesma fila/pacing.',
  };
}

/** Scheduled run falls outside the instance's send window. */
function checkWindow(input: SendCheckInput): SendCheck | null {
  const { instance } = input;
  if (!(instance.sendWindowEnabled && input.nextRunAt)) return null;
  const tz = input.timezone ?? TIMEZONE_DEFAULT;
  const hour = localHour(input.nextRunAt, tz);
  const { sendWindowStartHour: start, sendWindowEndHour: end } = instance;
  // Wrap-aware: a window with start > end is overnight (e.g. 20h–08h), so
  // "in window" means at/after start OR before end. start === end is a
  // degenerate config (rejected on write) — treat it as no restriction rather
  // than flag every hour as outside.
  const inWindow =
    start === end
      ? true
      : start < end
        ? hour >= start && hour < end
        : hour >= start || hour < end;
  if (inWindow) return null;
  return {
    code: 'WINDOW',
    severity: 'warn',
    message: `O disparo está agendado para ${String(hour).padStart(2, '0')}h, fora da janela de envio da instância (${String(instance.sendWindowStartHour).padStart(2, '0')}h–${String(instance.sendWindowEndHour).padStart(2, '0')}h).`,
  };
}

/** Standing reminder that opt-out contacts are always excluded. Always emitted. */
function checkOptOut(): SendCheck {
  return {
    code: 'OPT_OUT',
    severity: 'info',
    message:
      'Contatos que pediram para sair (opt-out) são sempre excluídos automaticamente.',
  };
}

/**
 * Pure mis-configuration analysis for a broadcast. Returns an ordered list of
 * checks; the caller decides what to render and whether any `block` requires an
 * operator override before the run/confirm path may proceed.
 */
export function computeSendChecks(
  input: SendCheckInput,
): SendCheck[] {
  const ordered: (SendCheck | null)[] = [
    checkVolume(input),
    checkFrequency(input),
    checkReachability(input),
    checkOverlap(input),
    checkWindow(input),
    checkOptOut(),
  ];
  return ordered.filter((c): c is SendCheck => c !== null);
}

/** True when any check would block the run without an explicit override. */
export function hasBlockingCheck(checks: SendCheck[]): boolean {
  return checks.some((c) => c.severity === 'block');
}
