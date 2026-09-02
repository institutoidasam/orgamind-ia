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
  const reached = ev.reached;

  const dotStyle: React.CSSProperties = {
    background: reached
      ? `var(--st-${ev.statusVar}-fg)`
      : "var(--surface-sunken)",
    border: reached
      ? `1px solid var(--st-${ev.statusVar}-border)`
      : "1px solid var(--border)",
  };
  const connectorStyle: React.CSSProperties = {
    background:
      next?.reached || reached
        ? `var(--st-${ev.statusVar}-border)`
        : "var(--border)",
  };

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center" aria-hidden>
        <div
          className="grid size-[22px] place-items-center rounded-full text-white"
          style={dotStyle}
        >
          {reached && <Check className="size-3" />}
        </div>
        {!isLast && <div className="my-0.5 w-0.5 flex-1" style={connectorStyle} />}
      </div>
      <div className="flex-1 pb-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{stage}</span>
          <span
            className="ds-mono text-xs"
            style={{ color: "var(--foreground-muted)" }}
          >
            {ev.duration ?? (reached ? "—" : "")}
          </span>
        </div>
        {ev.barWidth != null && (
          <div
            className="mt-1 h-1 rounded-full"
            style={{
              width: `${ev.barWidth}%`,
              background: `var(--st-${ev.statusVar}-fg)`,
            }}
          />
        )}
        {ev.failCard && (
          <div
            className="mt-2 rounded-md border p-2 text-xs"
            style={{
              background: "var(--st-failed-bg)",
              borderColor: "var(--st-failed-border)",
              color: "var(--st-failed-fg)",
            }}
          >
            {ev.failCard}
          </div>
        )}
      </div>
    </li>
  );
}

function buildStages(m: CampaignMessage): Record<number, StageEvent> {
  const queuedAt = new Date(m.queuedAt).getTime();
  const sentAt = m.sentAt ? new Date(m.sentAt).getTime() : null;
  const deliveredAt = m.deliveredAt ? new Date(m.deliveredAt).getTime() : null;
  const readAt = m.readAt ? new Date(m.readAt).getTime() : null;
  const failedAt = m.failedAt ? new Date(m.failedAt).getTime() : null;

  const reached = (t: number | null) => t != null;
  const dur = (from: number, to: number | null) =>
    to == null ? undefined : formatDelta(to - from);

  const totalEnvelope =
    (readAt ?? deliveredAt ?? sentAt ?? failedAt ?? Date.now()) - queuedAt || 1;
  const widthOf = (from: number, to: number | null) =>
    to == null
      ? undefined
      : Math.min(100, Math.round(((to - from) / totalEnvelope) * 100));

  const stage0: StageEvent = {
    reached: true,
    statusVar: STATUS_VAR.QUEUED,
    duration: dur(queuedAt, sentAt ?? failedAt ?? null),
    barWidth: widthOf(queuedAt, sentAt ?? failedAt ?? null),
  };
  const stage1: StageEvent = {
    reached: reached(sentAt),
    statusVar: STATUS_VAR.SENT,
    duration: dur(sentAt ?? queuedAt, deliveredAt ?? failedAt ?? null),
    barWidth: widthOf(sentAt ?? queuedAt, deliveredAt ?? failedAt ?? null),
  };
  const stage2: StageEvent = {
    reached: reached(deliveredAt),
    statusVar: STATUS_VAR.DELIVERED,
    duration: dur(deliveredAt ?? sentAt ?? queuedAt, readAt ?? null),
    barWidth: widthOf(deliveredAt ?? sentAt ?? queuedAt, readAt ?? null),
  };
  const stage3: StageEvent = {
    reached: reached(readAt),
    statusVar: STATUS_VAR.READ,
  };

  // Inject failure / cancellation card on the next-pending stage
  if (m.status === "FAILED" && failedAt) {
    const target = !sentAt ? stage1 : !deliveredAt ? stage2 : stage3;
    target.failCard = m.errorMessage
      ? `${m.errorCode ? `[${m.errorCode}] ` : ""}${m.errorMessage}`
      : "Falha desconhecida";
    target.statusVar = STATUS_VAR.FAILED;
  }
  if (m.status === "CANCELLED") {
    const target = !sentAt ? stage1 : !deliveredAt ? stage2 : stage3;
    target.failCard =
      m.errorCode === "opted_out"
        ? "Contato em opt-out — não enviada"
        : "Mensagem cancelada";
    target.statusVar = STATUS_VAR.CANCELLED;
  }

  return { 0: stage0, 1: stage1, 2: stage2, 3: stage3 };
}

function formatDelta(ms: number) {
  if (ms < 0) return "—";
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `+${Math.round(ms / 60_000)}min`;
  return `+${Math.round(ms / 3_600_000)}h`;
}
