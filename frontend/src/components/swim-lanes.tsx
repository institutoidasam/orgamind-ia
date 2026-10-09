import { Check } from "lucide-react";
import type {
  CampaignMessage,
  MessageStatus,
} from "@/features/campaigns/schemas";

const STAGES = ["Enfileirada", "Enviada", "Entregue", "Lida"] as const;

const STATUS_VAR: Record<MessageStatus, string> = {
  QUEUED: "queued",
  WAITING_INSTANCE: "queued",
  // A2 transient claim state (QUEUED→SENDING→SENT) — still "pending" visually.
  SENDING: "queued",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  CANCELLED: "cancelled",
  // C1/C2 — pulados pelo gate de consentimento: terminais, nunca foram ao
  // provedor. Visualmente iguais a "cancelada" (não é falha de envio).
  SKIPPED_NO_CONSENT: "cancelled",
  SKIPPED_SUPPRESSED: "cancelled",
  SKIPPED_NO_OPTIN: "cancelled",
};

type StageEvent = {
  reached: boolean;
  statusVar: string;
  duration?: string;
  barWidth?: number;
  failCard?: string;
};

type StageTimes = {
  queuedAt: number;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  failedAt: number | null;
};

type StageBuildInput = {
  statusVar: string;
  reachedAt: number | null;
  from: number | null;
  to: number | null;
  envelope: number;
};

export function SwimLanes({ message }: { message: CampaignMessage }) {
  const events = buildStages(message);

  return (
    <ol className="space-y-0 pl-1">
      {STAGES.map((stage, i) => (
        <StageRow
          key={stage}
          stage={stage}
          ev={events[i]}
          next={events[i + 1]}
          isLast={i === STAGES.length - 1}
        />
      ))}
    </ol>
  );
}

function StageRow({
  stage,
  ev,
  next,
  isLast,
}: {
  stage: string;
  ev: StageEvent;
  next: StageEvent | undefined;
  isLast: boolean;
}) {
  return (
    <li className="flex gap-3">
      <StageMarker ev={ev} next={next} isLast={isLast} />
      <StageDetails stage={stage} ev={ev} />
    </li>
  );
}

function StageMarker({
  ev,
  next,
  isLast,
}: Pick<Parameters<typeof StageRow>[0], "ev" | "next" | "isLast">) {
  return (
    <div className="flex flex-col items-center" aria-hidden>
      <div
        className="grid size-[22px] place-items-center rounded-full text-white"
        style={markerStyle(ev)}
      >
        {ev.reached && <Check className="size-3" />}
      </div>
      {!isLast && (
        <div className="my-0.5 w-0.5 flex-1" style={connectorStyle(ev, next)} />
      )}
    </div>
  );
}

function StageDetails({
  stage,
  ev,
}: Pick<Parameters<typeof StageRow>[0], "stage" | "ev">) {
  return (
    <div className="flex-1 pb-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{stage}</span>
        <span
          className="ds-mono text-xs"
          style={{ color: "var(--foreground-muted)" }}
        >
          {ev.duration ?? (ev.reached ? "—" : "")}
        </span>
      </div>
      {ev.barWidth != null && <ProgressBar ev={ev} />}
      {ev.failCard && <FailureCard text={ev.failCard} />}
    </div>
  );
}

function ProgressBar({ ev }: { ev: StageEvent }) {
  return (
    <div
      className="mt-1 h-1 rounded-full"
      style={{
        width: `${ev.barWidth}%`,
        background: `var(--st-${ev.statusVar}-fg)`,
      }}
    />
  );
}

function FailureCard({ text }: { text: string }) {
  return (
    <div
      className="mt-2 rounded-md border p-2 text-xs"
      style={{
        background: "var(--st-failed-bg)",
        borderColor: "var(--st-failed-border)",
        color: "var(--st-failed-fg)",
      }}
    >
      {text}
    </div>
  );
}

function markerStyle(ev: StageEvent): React.CSSProperties {
  return {
    background: ev.reached
      ? `var(--st-${ev.statusVar}-fg)`
      : "var(--surface-sunken)",
    border: ev.reached
      ? `1px solid var(--st-${ev.statusVar}-border)`
      : "1px solid var(--border)",
  };
}

function connectorStyle(ev: StageEvent, next: StageEvent | undefined): React.CSSProperties {
  return {
    background:
      next?.reached || ev.reached
        ? `var(--st-${ev.statusVar}-border)`
        : "var(--border)",
  };
}

function buildStages(message: CampaignMessage): Record<number, StageEvent> {
  const times = stageTimes(message);
  const envelope = totalEnvelope(times);
  const stages = [
    createStage({
      statusVar: STATUS_VAR.QUEUED,
      reachedAt: times.queuedAt,
      from: times.queuedAt,
      to: times.sentAt ?? times.failedAt,
      envelope,
    }),
    createStage({
      statusVar: STATUS_VAR.SENT,
      reachedAt: times.sentAt,
      from: times.sentAt ?? times.queuedAt,
      to: times.deliveredAt ?? times.failedAt,
      envelope,
    }),
    createStage({
      statusVar: STATUS_VAR.DELIVERED,
      reachedAt: times.deliveredAt,
      from: times.deliveredAt ?? times.sentAt ?? times.queuedAt,
      to: times.readAt,
      envelope,
    }),
    createStage({
      statusVar: STATUS_VAR.READ,
      reachedAt: times.readAt,
      from: null,
      to: null,
      envelope,
    }),
  ];

  addTerminalCard(stages, message, times);
  return {
    0: stages[0],
    1: stages[1],
    2: stages[2],
    3: stages[3],
  };
}

function stageTimes(message: CampaignMessage): StageTimes {
  return {
    queuedAt: new Date(message.queuedAt).getTime(),
    sentAt: toTimestamp(message.sentAt),
    deliveredAt: toTimestamp(message.deliveredAt),
    readAt: toTimestamp(message.readAt),
    failedAt: toTimestamp(message.failedAt),
  };
}

function toTimestamp(value: string | Date | null) {
  return value ? new Date(value).getTime() : null;
}

function totalEnvelope(times: StageTimes) {
  const endAt =
    times.readAt ??
    times.deliveredAt ??
    times.sentAt ??
    times.failedAt ??
    Date.now();
  return endAt - times.queuedAt || 1;
}

function createStage({
  statusVar,
  reachedAt,
  from,
  to,
  envelope,
}: StageBuildInput): StageEvent {
  return {
    reached: reachedAt != null,
    statusVar,
    duration: from == null || to == null ? undefined : formatDelta(to - from),
    barWidth:
      from == null || to == null
        ? undefined
        : Math.min(100, Math.round(((to - from) / envelope) * 100)),
  };
}

function addTerminalCard(
  stages: StageEvent[],
  message: CampaignMessage,
  times: StageTimes,
) {
  if (message.status === "FAILED" && times.failedAt != null) {
    attachTerminalCard(stages, times, failureMessage(message), STATUS_VAR.FAILED);
  }
  if (message.status === "CANCELLED") {
    const text =
      message.errorCode === "opted_out"
        ? "Contato em opt-out — não enviada"
        : "Mensagem cancelada";
    attachTerminalCard(stages, times, text, STATUS_VAR.CANCELLED);
  }
}

function failureMessage(message: CampaignMessage) {
  if (!message.errorMessage) return "Falha desconhecida";
  return `${message.errorCode ? `[${message.errorCode}] ` : ""}${message.errorMessage}`;
}

function attachTerminalCard(
  stages: StageEvent[],
  times: StageTimes,
  text: string,
  statusVar: string,
) {
  const index = nextPendingStageIndex(times);
  const target = stages[index];
  target.failCard = text;
  target.statusVar = statusVar;
}

function nextPendingStageIndex(times: StageTimes) {
  if (times.sentAt == null) return 1;
  if (times.deliveredAt == null) return 2;
  return 3;
}

function formatDelta(ms: number) {
  if (ms < 0) return "—";
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `+${Math.round(ms / 60_000)}min`;
  return `+${Math.round(ms / 3_600_000)}h`;
}
