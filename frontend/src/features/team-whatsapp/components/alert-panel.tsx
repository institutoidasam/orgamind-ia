import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermission } from "@/features/permissions/use-permission";
import { alertActionErrorText, useUndoManualAck } from "../alert-actions-api";
import { useAlertView } from "../alert-api";
import {
  ackLabel,
  closureText,
  deadlineText,
  GROUP_LABEL,
  personDetails,
  reminderText,
} from "../alert-labels";
import {
  ALERT_GROUPS,
  type AlertGroup,
  type AlertPerson,
  type TeamAlertPanel,
} from "../alert-schemas";
import { ManualAckDialog } from "./manual-ack-dialog";
import { RecipientTable } from "./recipient-table";
import { ReminderDialog } from "./reminder-dialog";

/** Qual contagem do servidor é de cada grupo. */
const COUNT_KEY = {
  no_delivery: "noDelivery",
  no_reply: "noReply",
  replied: "replied",
  acked: "acked",
} as const satisfies Record<AlertGroup, keyof TeamAlertPanel["counts"]>;

type PanelProps = { panel: TeamAlertPanel; now: Date };

/** As ações por pessoa (T13); só existem para quem tem `equipe.enviar` e `equipe.urgencia`. */
type RowActions = {
  onRegister: (person: AlertPerson) => void;
  onUndo: (person: AlertPerson) => void;
  busy: boolean;
};

/** Sem ciência: registrar; ciência manual: desfazer; a automática não se desfaz (I5). */
function PersonButtons({
  person,
  actions,
}: {
  person: AlertPerson;
  actions: RowActions;
}) {
  if (!person.ack) {
    return (
      <Button
        size="sm"
        variant="outline"
        aria-label={`Registrar ciência de ${person.userName}`}
        onClick={() => actions.onRegister(person)}
      >
        Registrar ciência
      </Button>
    );
  }
  if (person.ack.kind !== "manual") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={actions.busy}
      aria-label={`Desfazer ciência manual de ${person.userName}`}
      onClick={() => actions.onUndo(person)}
    >
      Desfazer ciência manual
    </Button>
  );
}

type ViewProps = PanelProps & { actions?: RowActions; toolbar?: ReactNode };

/** Nome com o rótulo da ciência; abaixo, a resposta ou a observação que o servidor já decidiu mostrar (DI15). */
function PersonItem({
  person,
  panel,
  now,
  actions,
}: Omit<ViewProps, "toolbar"> & { person: AlertPerson }) {
  const closure = closureText(person.closure);
  const lines = closure
    ? [...personDetails(person), closure]
    : personDetails(person);
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{person.userName}</span> ·{" "}
          {ackLabel(person, panel, now)}
        </p>
        {actions && <PersonButtons person={person} actions={actions} />}
      </div>
      {lines.map((line, index) => (
        <p
          key={`${index}:${line}`}
          className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {line}
        </p>
      ))}
    </li>
  );
}

function Group({
  group,
  panel,
  now,
  actions,
}: Omit<ViewProps, "toolbar"> & { group: AlertGroup }) {
  const people = panel.people.filter((p) => p.group === group);
  const titleId = `alert-group-${group}`;
  return (
    <section className="space-y-1">
      <h3 id={titleId} className="text-sm font-semibold">
        {GROUP_LABEL[group]} ({panel.counts[COUNT_KEY[group]]})
      </h3>
      {people.length > 0 && (
        <ul aria-labelledby={titleId} className="text-sm">
          {people.map((person) => (
            <PersonItem
              key={person.recipientId}
              person={person}
              panel={panel}
              now={now}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Reminders({ items }: { items: TeamAlertPanel["reminders"]["items"] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 id="alert-reminders-title" className="text-sm font-semibold">
        Lembretes do alerta
      </h3>
      <ul aria-labelledby="alert-reminders-title" className="text-sm">
        {items.map((item) => (
          <li key={item.dispatchId}>{reminderText(item)}</li>
        ))}
      </ul>
    </section>
  );
}

/** O painel em si; `actions` e `toolbar` só chegam a quem pode agir (T13). */
function AlertPanelView({ panel, now, actions, toolbar }: ViewProps) {
  return (
    <section
      aria-labelledby="alert-panel-title"
      className="space-y-4 rounded-md border p-4"
      style={{ borderColor: "var(--border)" }}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 id="alert-panel-title" className="text-base font-semibold">
            Pendências do alerta
          </h2>
          <p className="text-sm">{deadlineText(panel, now)}</p>
        </div>
        {toolbar}
      </header>
      {ALERT_GROUPS.map((group) => (
        <Group
          key={group}
          group={group}
          panel={panel}
          now={now}
          actions={actions}
        />
      ))}
      <Reminders items={panel.reminders.items} />
    </section>
  );
}

/** Desfazer a ciência manual: avisa no toast; o erro usa o texto do servidor ou o da ação. */
function useUndoAction(alertId: string) {
  const undo = useUndoManualAck(alertId);
  const run = async (person: AlertPerson) => {
    try {
      await undo.mutateAsync(person.recipientId);
      toast.success("Ciência manual desfeita");
    } catch (err) {
      toast.error(
        await alertActionErrorText(
          err,
          "Não foi possível desfazer a ciência. Tente de novo.",
        ),
      );
    }
  };
  return { run, busy: undo.isPending };
}

/** O painel com as ações: lembrete aos pendentes, registrar e desfazer a ciência manual. */
function ActionablePanel({ panel, now }: PanelProps) {
  const [asking, setAsking] = useState<AlertPerson | null>(null);
  const [reminding, setReminding] = useState(false);
  const undo = useUndoAction(panel.dispatchId);
  const hasPending = panel.people.some((person) => !person.ack);
  return (
    <>
      <AlertPanelView
        panel={panel}
        now={now}
        actions={{ onRegister: setAsking, onUndo: undo.run, busy: undo.busy }}
        toolbar={
          hasPending && (
            <Button variant="outline" onClick={() => setReminding(true)}>
              Enviar lembrete aos pendentes
            </Button>
          )
        }
      />
      <ReminderDialog
        panel={panel}
        now={now}
        open={reminding}
        onOpenChange={setReminding}
      />
      <ManualAckDialog
        alertId={panel.dispatchId}
        person={asking}
        onClose={() => setAsking(null)}
      />
    </>
  );
}

/**
 * Painel de pendências do alerta urgente (I6): o prazo, os quatro grupos com a contagem e os nomes, e os lembretes
 * já enviados. Mostra o que o servidor devolve a quem vê o envio; `now` é o relógio da tela. As ações (lembrete e
 * ciência manual) só aparecem com `equipe.enviar` e `equipe.urgencia` (I1): esconder é a tela, recusar é do servidor.
 */
export function AlertPanel({ panel, now }: PanelProps) {
  const canSend = usePermission("equipe.enviar");
  const urgent = usePermission("equipe.urgencia");
  if (canSend && urgent) return <ActionablePanel panel={panel} now={now} />;
  return <AlertPanelView panel={panel} now={now} />;
}

/** Um erro numa releitura não tira o painel da tela: só a primeira carga sem resposta mostra o erro. */
function PanelState({
  panelQuery,
  now,
}: {
  panelQuery: UseQueryResult<TeamAlertPanel>;
  now: Date;
}) {
  if (panelQuery.data) return <AlertPanel panel={panelQuery.data} now={now} />;
  if (panelQuery.isError) {
    return (
      <QueryErrorFallback
        error={panelQuery.error}
        onRetry={panelQuery.refetch}
      />
    );
  }
  return <Skeleton className="h-32 w-full" />;
}

type BodyProps = { dispatchId: string; failedCount: number; query?: string };

/**
 * O resultado de um alerta: o painel acima da tabela de destinatários, que ganha a coluna "Ciência" com os mesmos
 * rótulos (mapa `recipientId` → rótulo; a API de destinatários não muda).
 */
export function AlertAndRecipients({
  dispatchId,
  failedCount,
  query,
}: BodyProps) {
  const { panelQuery, now, ackLabels } = useAlertView(dispatchId);
  return (
    <>
      <PanelState panelQuery={panelQuery} now={now} />
      <RecipientTable
        dispatchId={dispatchId}
        failedCount={failedCount}
        query={query}
        ackLabels={ackLabels}
      />
    </>
  );
}
