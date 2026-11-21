import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { alertActionErrorText, useSendReminder } from "../alert-actions-api";
import type { AlertPerson, TeamAlertPanel } from "../alert-schemas";
import { POLL_INTERVAL_MS } from "../api";
import { reminderBlock, reminderLists, type Excluded } from "../reminder-rules";

/**
 * Relógio do diálogo: o da tela, e, enquanto o intervalo de 5 minutos não passou, um próprio a cada 10 s (o da tela
 * para de andar quando o alerta já tem mais de 2 horas e ninguém mais é relido).
 */
function useDialogClock(now: Date, nextAllowedAt: string | null | undefined) {
  const [later, setLater] = useState<Date | null>(null);
  const current = later && later > now ? later : now;
  const waiting =
    !!nextAllowedAt && current.getTime() < Date.parse(nextAllowedAt);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setLater(new Date()), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return current;
}

type ChooseProps = {
  eligible: AlertPerson[];
  skipped: ReadonlySet<string>;
  onToggle: (recipientId: string) => void;
};

function EligibleList({ eligible, skipped, onToggle }: ChooseProps) {
  return (
    <ul aria-label="Quem recebe o lembrete" className="text-sm">
      {eligible.map((person) => (
        <li key={person.recipientId} className="flex items-center gap-3 py-1">
          <Checkbox
            aria-label={person.userName}
            checked={!skipped.has(person.recipientId)}
            onCheckedChange={() => onToggle(person.recipientId)}
          />
          <span>
            {person.userName}
            {person.mayHaveReceived && (
              <span className="text-muted-foreground">
                {" "}
                · pode já ter recebido
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ExcludedList({ excluded }: { excluded: Excluded[] }) {
  if (excluded.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 id="reminder-excluded-title" className="text-sm font-semibold">
        Não entram
      </h3>
      <ul
        aria-labelledby="reminder-excluded-title"
        className="text-sm text-muted-foreground"
      >
        {excluded.map(({ person, hint }) => (
          <li key={person.recipientId}>
            {person.userName} — {hint}
          </li>
        ))}
      </ul>
    </section>
  );
}

const SEND_FALLBACK = "Não foi possível enviar o lembrete. Tente de novo.";

type FormProps = { panel: TeamAlertPanel; now: Date; onDone: () => void };

/** Estado do formulário: quem foi desmarcado, o erro do servidor, o relógio e o envio. */
function useReminderForm({ panel, now, onDone }: FormProps) {
  const lists = reminderLists(panel);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const send = useSendReminder(panel.dispatchId);
  const clock = useDialogClock(now, panel.reminders.nextAllowedAt);
  const chosen = lists.eligible.filter((p) => !skipped.has(p.recipientId));
  const toggle = (id: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const submit = async () => {
    setError(null);
    try {
      const { queued } = await send.mutateAsync(
        chosen.map((p) => p.recipientId),
      );
      toast.success(`Lembrete na fila para ${queued} pessoa(s)`);
      onDone();
    } catch (err) {
      setError(await alertActionErrorText(err, SEND_FALLBACK));
    }
  };
  const block = reminderBlock(panel, chosen.length, clock);
  return {
    ...lists,
    skipped,
    toggle,
    submit,
    error,
    block,
    busy: send.isPending,
  };
}

function ReminderForm(props: FormProps) {
  const { count, max } = props.panel.reminders;
  const form = useReminderForm(props);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Enviar lembrete aos pendentes</DialogTitle>
        <DialogDescription>
          {count >= max
            ? `Já foram enviados ${count} de ${max} lembretes.`
            : `Lembrete ${count + 1} de ${max}`}
        </DialogDescription>
      </DialogHeader>
      <EligibleList
        eligible={form.eligible}
        skipped={form.skipped}
        onToggle={form.toggle}
      />
      <ExcludedList excluded={form.excluded} />
      {(form.error ?? form.block) && (
        <p role={form.error ? "alert" : undefined} className="text-sm">
          {form.error ?? form.block}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={props.onDone}>
          Voltar
        </Button>
        <Button
          disabled={form.block !== null || form.busy}
          onClick={form.submit}
        >
          Enviar lembrete
        </Button>
      </DialogFooter>
    </>
  );
}

type Props = {
  panel: TeamAlertPanel;
  now: Date;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Lembrete aos pendentes (I7): a lista nominal dos elegíveis, todos marcados, da qual se tiram nomes; abaixo, quem
 * não entra. Mostra ou esconde a ação; a recusa (chave, limite, intervalo) é do servidor.
 */
export function ReminderDialog({ panel, now, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ReminderForm
          panel={panel}
          now={now}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
