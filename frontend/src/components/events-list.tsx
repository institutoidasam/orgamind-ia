import type {
  CampaignMessage,
  MessageStatus,
} from "@/features/campaigns/schemas";
import { initials } from "@/lib/initials";

const STATUS_VAR: Record<MessageStatus, string> = {
  QUEUED: "queued",
  // Parked while its instance is offline — visually treated like "queued"
  // (pending) since it will auto-resend on reconnect.
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

type Props = {
  messages: CampaignMessage[];
  activeId: string | null;
  onActive: (id: string) => void;
};

export function EventsList({ messages, activeId, onActive }: Props) {
  return (
    <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
      {messages.map((m) => {
        const v = STATUS_VAR[m.status] ?? "queued";
        const isActive = m.id === activeId;
        return (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onActive(m.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
              style={{
                background: isActive ? "var(--surface-hover)" : "transparent",
                borderLeft: isActive
                  ? "3px solid var(--brand-orange)"
                  : "3px solid transparent",
              }}
            >
              {m.contact.profilePictureUrl ? (
                <img
                  src={m.contact.profilePictureUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-8 shrink-0 rounded-full object-cover"
                  style={{ border: `1px solid var(--st-${v}-border)` }}
                />
              ) : (
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                  style={{
                    background: `var(--st-${v}-fg)`,
                    border: `1px solid var(--st-${v}-border)`,
                  }}
                  aria-hidden
                >
                  {initials(m.contact.name) === "?"
                    ? m.contact.phoneE164.slice(-2)
                    : initials(m.contact.name)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {m.contact.name ?? "(sem nome)"}
                  </span>
                  <span
                    className="ds-mono text-[11px]"
                    style={{ color: "var(--foreground-muted)" }}
                  >
                    {formatTime(m.queuedAt)}
                  </span>
                </div>
                <div
                  className="ds-mono text-xs"
                  style={{ color: "var(--foreground-muted)" }}
                >
                  {m.contact.phoneE164}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatTime(d: string | Date) {
  return new Date(d).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
