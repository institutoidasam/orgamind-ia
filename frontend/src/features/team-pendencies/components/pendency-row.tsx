import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GROUP_LABEL } from "@/features/team-whatsapp/alert-labels";
import {
  closureLine,
  handlerLabel,
  manausTime,
  noteLine,
  REMOVED_USER_LABEL,
  replyLabel,
  SITUATION_LABEL,
} from "../labels";
import type { PendencyMe } from "../pendency-actions";
import type { TeamPendencyItem } from "../schemas";

type Props = {
  item: TeamPendencyItem;
  me: PendencyMe;
  /** Encaixe das ações da tratativa (T13): recebe a linha e devolve os botões, que entram ao lado dos links. */
  renderActions?: (item: TeamPendencyItem) => ReactNode;
};

const NO_VALUE = "—";

/** Telefone completo (só chega com `telefone.ver_completo`), ou o mascarado, ou "Sem telefone". */
function phoneText({
  phoneE164,
  hasPhone,
  phoneMasked,
}: TeamPendencyItem["person"]) {
  if (phoneE164) return phoneE164;
  return hasPhone && phoneMasked ? phoneMasked : "Sem telefone";
}

function RowHeader({ item }: { item: TeamPendencyItem }) {
  const { person } = item;
  const where = `${person.name} · ${person.sectorName ?? NO_VALUE} · ${person.shiftName ?? NO_VALUE}`;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-medium">{where}</p>
        <p className="text-xs text-muted-foreground">{phoneText(person)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{GROUP_LABEL[item.group]}</Badge>
        <Badge
          variant={item.situation === "OVERDUE" ? "destructive" : "secondary"}
        >
          {SITUATION_LABEL[item.situation]}
        </Badge>
      </div>
    </div>
  );
}

function AlertLines({ item }: { item: TeamPendencyItem }) {
  const { alert } = item;
  const author = alert.authorName ?? REMOVED_USER_LABEL;
  return (
    <>
      <p>{`Alerta de ${author} em ${manausTime(alert.sentAt)}: ${alert.text}`}</p>
      <p className="text-muted-foreground">{`Prazo de ciência: ${manausTime(alert.ackDeadlineAt)}`}</p>
    </>
  );
}

function TreatmentLines({ item }: { item: TeamPendencyItem }) {
  const { handler, dueAt, closure, group, lastReply } = item;
  return (
    <>
      <p>{handlerLabel(handler)}</p>
      {dueAt && <p>{`Prazo da tratativa: ${manausTime(dueAt)}`}</p>}
      {closure && <p>{closureLine(closure)}</p>}
      {group === "replied" && lastReply && (
        <p>{`Última resposta: ${replyLabel(lastReply)}`}</p>
      )}
    </>
  );
}

function NotesList({ notes }: { notes: TeamPendencyItem["notes"] }) {
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Anotações" className="space-y-1 text-muted-foreground">
      {notes.map((note) => (
        <li key={note.id}>{noteLine(note)}</li>
      ))}
    </ul>
  );
}

function RowLinks({ item, me, renderActions }: Props) {
  const { conversationId } = item;
  // A caixa de entrada é de ADMIN e OPERATOR; sem mensagem do envio não há conversa para abrir.
  const canOpenChat =
    conversationId !== null && (me.role === "ADMIN" || me.role === "OPERATOR");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canOpenChat && (
        <Button asChild variant="outline" size="sm">
          <Link to="/inbox/$conversationId" params={{ conversationId }}>
            Abrir conversa
          </Link>
        </Button>
      )}
      {item.canViewDispatch && (
        <Button asChild variant="outline" size="sm">
          <Link
            to="/whatsapp-equipe/$dispatchId"
            params={{ dispatchId: item.dispatchId }}
          >
            Ver resultado do alerta
          </Link>
        </Button>
      )}
      {renderActions?.(item)}
    </div>
  );
}

/** Uma pendência da lista (K2-5, DK19). Mostra os campos; as ações da tratativa entram por `renderActions`. */
export function PendencyRow({ item, me, renderActions }: Props) {
  return (
    <article className="space-y-2 rounded-md border bg-card p-4 text-sm">
      <RowHeader item={item} />
      <AlertLines item={item} />
      <TreatmentLines item={item} />
      <NotesList notes={item.notes} />
      <RowLinks item={item} me={me} renderActions={renderActions} />
    </article>
  );
}
