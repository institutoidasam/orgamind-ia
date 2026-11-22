import { Link } from "@tanstack/react-router";
import {
  useConversationLastDispatch,
  lastDispatchText,
} from "../team-dispatch";

/**
 * Faixa do topo da conversa com o último envio à equipe (K3-6, DT7). A situação da pendência e o link
 * "Ver resultado" só aparecem quando o servidor os manda (alcance e `canViewDispatch` de quem olha).
 */
export function LastDispatchBanner({
  conversationId,
}: {
  conversationId: string;
}) {
  const last = useConversationLastDispatch(conversationId).data?.last;
  if (!last) return null;
  return (
    <div
      data-testid="last-dispatch-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-1.5 text-xs"
      style={{
        background: "var(--surface-sunken)",
        color: "var(--foreground-muted)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span>{lastDispatchText(last)}</span>
      {last.dispatchId ? (
        <Link
          className="underline"
          to="/whatsapp-equipe/$dispatchId"
          params={{ dispatchId: last.dispatchId }}
        >
          Ver resultado
        </Link>
      ) : null}
    </div>
  );
}
