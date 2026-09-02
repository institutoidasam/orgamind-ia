import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  Clock,
  Eye,
  Send,
  ShieldOff,
  Unplug,
  UserX,
} from "lucide-react";
import type { MessageStatus } from "../schemas";

type StatusEntry = {
  label: string;
  styles: React.CSSProperties;
  icon: React.ReactNode;
  description: string;
};

const STATUS_CONFIG: Record<MessageStatus, StatusEntry> = {
  QUEUED: {
    label: "Na fila",
    description: "Aguardando envio",
    styles: {
      background: "var(--st-queued-bg)",
      color: "var(--st-queued-fg)",
      borderColor: "var(--st-queued-border)",
    },
    icon: <Clock className="h-3 w-3" />,
  },
  WAITING_INSTANCE: {
    label: "Aguardando conexão",
    description:
      "A conexão WhatsApp usada por esta mensagem está offline. Será reenviada automaticamente quando reconectar.",
    styles: {
      background: "var(--st-queued-bg)",
      color: "var(--st-queued-fg)",
      borderColor: "var(--st-queued-border)",
    },
    icon: <Unplug className="h-3 w-3" />,
  },
  SENDING: {
    label: "Enviando",
    description: "Envio em andamento (entregue ao provedor; aguardando confirmação)",
    styles: {
      background: "var(--st-queued-bg)",
      color: "var(--st-queued-fg)",
      borderColor: "var(--st-queued-border)",
    },
    icon: <Send className="h-3 w-3" />,
  },
  SENT: {
    label: "Enviada",
    description: "Aceita pelo WhatsApp (1 tique cinza)",
    styles: {
      background: "var(--st-sent-bg)",
      color: "var(--st-sent-fg)",
      borderColor: "var(--st-sent-border)",
    },
    icon: <Check className="h-3 w-3" />,
  },
  DELIVERED: {
    label: "Entregue",
    description: "Chegou ao aparelho (2 tiques cinza)",
    styles: {
      background: "var(--st-delivered-bg)",
      color: "var(--st-delivered-fg)",
      borderColor: "var(--st-delivered-border)",
    },
    icon: <CheckCheck className="h-3 w-3" />,
  },
  READ: {
    label: "Lida",
    description: "Visualizada pelo destinatário (2 tiques azuis)",
    styles: {
      background: "var(--st-read-bg)",
      color: "var(--st-read-fg)",
      borderColor: "var(--st-read-border)",
    },
    icon: <Eye className="h-3 w-3" />,
  },
  FAILED: {
    label: "Falhou",
    description: "Erro no envio",
    styles: {
      background: "var(--st-failed-bg)",
      color: "var(--st-failed-fg)",
      borderColor: "var(--st-failed-border)",
    },
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  CANCELLED: {
    label: "Cancelada",
    description: "Não enviada (cancelada ou opt-out)",
    styles: {
      background: "var(--st-cancelled-bg)",
      color: "var(--st-cancelled-fg)",
      borderColor: "var(--st-cancelled-border)",
    },
    icon: <Ban className="h-3 w-3" />,
  },
  // ── C1/C2 — pulados pelo GATE DE CONSENTIMENTO ──────────────────────────────
  // Sem rótulo, estes dois caíam no fallback "Desconhecido" — e são exatamente
  // os status que EXPLICAM por que uma campanha não enviou nada. O operador via
  // "Desconhecido" e não sabia se era bug ou regra.
  SKIPPED_NO_CONSENT: {
    label: "Sem consentimento",
    description:
      "Não enviada: o contato não consentiu para a FINALIDADE desta campanha (consentir para outra finalidade não autoriza esta).",
    styles: {
      background: "var(--st-cancelled-bg)",
      color: "var(--st-cancelled-fg)",
      borderColor: "var(--st-cancelled-border)",
    },
    icon: <ShieldOff className="h-3 w-3" />,
  },
  SKIPPED_SUPPRESSED: {
    label: "Suprimido",
    description:
      "Não enviada: o contato revogou o consentimento (PARAR/opt-out). A supressão é absoluta — nem o override de ADMIN a fura.",
    styles: {
      background: "var(--st-cancelled-bg)",
      color: "var(--st-cancelled-fg)",
      borderColor: "var(--st-cancelled-border)",
    },
    icon: <UserX className="h-3 w-3" />,
  },
  // Legado do gate binário de opt-in (T8). Não é mais escrito, mas linhas
  // históricas existem e não podem aparecer como "Desconhecido".
  SKIPPED_NO_OPTIN: {
    label: "Sem opt-in (legado)",
    description:
      "Não enviada pelo antigo gate binário de opt-in (anterior ao consentimento por finalidade).",
    styles: {
      background: "var(--st-cancelled-bg)",
      color: "var(--st-cancelled-fg)",
      borderColor: "var(--st-cancelled-border)",
    },
    icon: <ShieldOff className="h-3 w-3" />,
  },
};

// Defensive fallback: a render must never throw just because the backend
// introduced a message status the frontend doesn't know yet (this is exactly
// how WAITING_INSTANCE crashed the whole campaign page via the global error
// boundary). Unknown statuses render with a neutral badge instead.
const UNKNOWN_STATUS: StatusEntry = {
  label: "Desconhecido",
  description: "Status não reconhecido",
  styles: {
    background: "var(--st-queued-bg)",
    color: "var(--st-queued-fg)",
    borderColor: "var(--st-queued-border)",
  },
  icon: <Clock className="h-3 w-3" />,
};

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const c = STATUS_CONFIG[status] ?? UNKNOWN_STATUS;
  return (
    <span
      title={c.description}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={c.styles}
    >
      {c.icon}
      {c.label}
    </span>
  );
}
