import type { ChatMessageTeamTag } from "../schemas";
import { teamTagText } from "../team-dispatch";

/** Linha pequena acima da bolha: marca a mensagem que é envio, lembrete ou resposta de alerta da equipe (K3-6, DT6). */
export function MessageTeamTag({ tag }: { tag?: ChatMessageTeamTag | null }) {
  if (!tag) return null;
  return (
    <p
      data-testid="message-team-tag"
      className="mb-0.5 text-[10px]"
      style={{ color: "var(--foreground-muted)" }}
    >
      {teamTagText(tag)}
    </p>
  );
}
