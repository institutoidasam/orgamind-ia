import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  pendencyHandoverSkipText,
  usePendencyHandover,
  usePendencyHandoverList,
  usePendencyHandoverTargets,
} from "../handover-api";
import { manausTime, REMOVED_USER_LABEL, SITUATION_LABEL } from "../labels";
import type { PendencyMe } from "../pendency-actions";
import type { TeamPendencyItem } from "../schemas";
import { PENDENCY_TEXT_MAX } from "./pendency-text-dialog";

/** De quem as pendências saem: `own` = as minhas; senão, as de outra pessoa (só ADMIN; `name` nulo = removido). */
export type HandoverFrom = { id: string; name: string | null; own: boolean };

const OWN_TITLE = "Passar minhas pendências";
const NOTE_HINT = "Vai para cada pendência como 'Passagem de turno: …'.";
const SELECT_CLASS = "h-9 rounded-lg border bg-card px-2 text-sm";
const TRUNCATED_TEXT =
  "A lista pode estar incompleta porque há mais de 2.000 pendências abertas. Confira depois se ficou alguma com esta pessoa.";

function titleOf(from: HandoverFrom): string {
  return from.own
    ? OWN_TITLE
    : `Passar as pendências de ${from.name ?? REMOVED_USER_LABEL}`;
}

/** "{pessoa} · Alerta de {dd/MM HH:mm} · {situação}" (DT9). */
function itemLabel(item: TeamPendencyItem): string {
  const when = manausTime(item.alert.sentAt);
  return `${item.person.name} · Alerta de ${when} · ${SITUATION_LABEL[item.situation]}`;
}

const OpenHandover = createContext<(from: HandoverFrom) => void>(
  () => undefined,
);

/** Botão "Passar minhas pendências" no topo da tela: só com `equipe.enviar`. */
export function HandoverOwnButton({ me }: { me: PendencyMe }) {
  const open = useContext(OpenHandover);
  if (!me.canWrite) return null;
  return (
    <div className="flex justify-end">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => open({ id: me.id, name: null, own: true })}
      >
        {OWN_TITLE}
      </Button>
    </div>
  );
}

/** Na linha com responsável que não é quem olha, só o ADMIN passa as pendências de outro (K3-4). */
export function HandoverRowButton({
  item,
  me,
}: {
  item: TeamPendencyItem;
  me: PendencyMe;
}) {
  const open = useContext(OpenHandover);
  const { handler } = item;
  if (me.role !== "ADMIN" || !me.canWrite) return null;
  if (!handler || handler.id === me.id) return null;
  const from = { id: handler.id, name: handler.name, own: false };
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => open(from)}
    >
      {titleOf(from)}
    </Button>
  );
}

type ChecklistProps = {
  query: ReturnType<typeof usePendencyHandoverList>;
  unchecked: ReadonlySet<string>;
  onToggle: (id: string) => void;
};

/** Aviso da leitura cortada em 2.000 abertas: a lista (mesmo vazia) pode não ter todas as de quem sai. */
function TruncatedNotice() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {TRUNCATED_TEXT}
    </p>
  );
}

function Checklist({ query, unchecked, onToggle }: ChecklistProps) {
  if (query.isError)
    return <p role="alert">Não foi possível carregar as pendências.</p>;
  if (!query.data) return <p>Carregando pendências…</p>;
  const { items, total, truncated } = query.data;
  if (items.length === 0)
    return (
      <>
        <p>Nenhuma pendência em tratativa.</p>
        {truncated && <TruncatedNotice />}
      </>
    );
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Pendências em tratativa</legend>
      <ul className="max-h-60 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`handover-${item.id}`}
              checked={!unchecked.has(item.id)}
              onCheckedChange={() => onToggle(item.id)}
            />
            <Label htmlFor={`handover-${item.id}`}>{itemLabel(item)}</Label>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p role="status" className="text-sm text-muted-foreground">
          {`Mostrando ${items.length} de ${total}. Passe estas e abra de novo para passar as demais.`}
        </p>
      )}
      {truncated && <TruncatedNotice />}
    </fieldset>
  );
}

type TargetProps = {
  fromId: string;
  value: string;
  onChange: (id: string) => void;
};

function TargetSelect({ fromId, value, onChange }: TargetProps) {
  const targets = usePendencyHandoverTargets(fromId, true);
  return (
    <div className="grid gap-2">
      <Label htmlFor="handover-to">Passar para</Label>
      <select
        id="handover-to"
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Escolha um colega</option>
        {(targets.data?.items ?? []).map((target) => (
          <option key={target.id} value={target.id}>
            {target.name}
          </option>
        ))}
      </select>
    </div>
  );
}

type Fields = {
  unchecked: ReadonlySet<string>;
  toId: string;
  note: string;
};

const INITIAL_FIELDS: Fields = { unchecked: new Set(), toId: "", note: "" };

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Linha das puladas: a chave é o id da pendência (o texto se repete quando a mesma pessoa tem duas). */
type SkippedLine = { id: string; text: string };

/** Linhas "{item}: {motivo}" das puladas; o rótulo vem das pendências mostradas no envio (a lista recarrega depois). */
function skippedLines(
  skipped: { id: string; reason: string }[],
  sent: TeamPendencyItem[],
  targetName: string,
): SkippedLine[] {
  return skipped.map((skip) => {
    const item = sent.find((candidate) => candidate.id === skip.id);
    const name = item ? itemLabel(item) : "Pendência";
    const reason = pendencyHandoverSkipText(skip.reason, targetName);
    return { id: skip.id, text: `${name}: ${reason}` };
  });
}

type SendArgs = {
  items: TeamPendencyItem[];
  toId: string;
  toName: string;
  note: string;
};

/** Envio: tudo passado fecha o diálogo; com puladas ele passa a mostrá-las. `fromUserId` só quando não são as minhas. */
function useHandoverSend(from: HandoverFrom, onClose: () => void) {
  const handover = usePendencyHandover();
  const [skipped, setSkipped] = useState<SkippedLine[] | null>(null);
  const send = ({ items, toId, toName, note }: SendArgs) =>
    handover.mutate(
      {
        toUserId: toId,
        toName,
        fromUserId: from.own ? undefined : from.id,
        note,
        pendencyIds: items.map((item) => item.id),
      },
      {
        onSuccess: (result) => {
          if (result.skipped.length === 0) onClose();
          else setSkipped(skippedLines(result.skipped, items, toName));
        },
      },
    );
  return { send, skipped, busy: handover.isPending };
}

function SkippedView({
  lines,
  onClose,
}: {
  lines: SkippedLine[];
  onClose: () => void;
}) {
  return (
    <>
      <p className="text-sm font-medium">Não foram passadas:</p>
      <ul className="max-h-60 space-y-1 overflow-y-auto text-sm">
        {lines.map((line) => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Fechar
        </Button>
      </DialogFooter>
    </>
  );
}

function NoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (note: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="handover-note">Observação</Label>
      <Textarea
        id="handover-note"
        maxLength={PENDENCY_TEXT_MAX}
        aria-describedby="handover-note-hint"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, PENDENCY_TEXT_MAX))}
      />
      <p id="handover-note-hint" className="text-xs text-muted-foreground">
        {NOTE_HINT}
      </p>
    </div>
  );
}

type FooterProps = {
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

function FormFooter({ disabled, onCancel, onConfirm }: FooterProps) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancelar
      </Button>
      <Button type="button" disabled={disabled} onClick={onConfirm}>
        Confirmar
      </Button>
    </DialogFooter>
  );
}

function FormHeader({ title }: { title: string }) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
    </DialogHeader>
  );
}

/**
 * Campos do formulário e o destino escolhido. Destino que saiu da lista recarregada (ex.: `user.not_found`) volta ao
 * vazio: o placeholder explica o Confirmar desligado.
 */
function useHandoverFields(
  targets: ReturnType<typeof usePendencyHandoverTargets>,
) {
  const [fields, setFields] = useState(INITIAL_FIELDS);
  const update = (patch: Partial<Fields>) =>
    setFields((current) => ({ ...current, ...patch }));
  const target = targets.data?.items.find((t) => t.id === fields.toId);
  if (fields.toId !== "" && targets.data && !target) update({ toId: "" });
  return { fields, update, target };
}

type FormProps = { from: HandoverFrom; onClose: () => void };

function HandoverForm({ from, onClose }: FormProps) {
  const list = usePendencyHandoverList(from.id, from.own, true);
  const targets = usePendencyHandoverTargets(from.id, true);
  const { fields, update, target } = useHandoverFields(targets);
  const { send, skipped, busy } = useHandoverSend(from, onClose);
  const items = (list.data?.items ?? []).filter(
    (item) => !fields.unchecked.has(item.id),
  );
  const note = fields.note.trim();
  const header = <FormHeader title={titleOf(from)} />;
  if (skipped)
    return (
      <>
        {header}
        <SkippedView lines={skipped} onClose={onClose} />
      </>
    );
  return (
    <>
      {header}
      <Checklist
        query={list}
        unchecked={fields.unchecked}
        onToggle={(id) => update({ unchecked: toggled(fields.unchecked, id) })}
      />
      <TargetSelect
        fromId={from.id}
        value={fields.toId}
        onChange={(toId) => update({ toId })}
      />
      <NoteField
        value={fields.note}
        onChange={(text) => update({ note: text })}
      />
      <FormFooter
        disabled={busy || items.length === 0 || !target || note === ""}
        onCancel={onClose}
        onConfirm={() =>
          target && send({ items, toId: target.id, toName: target.name, note })
        }
      />
    </>
  );
}

/** Abre o diálogo da passagem (botão do topo e botão da linha) e o hospeda: a tela só precisa envolvê-la. */
export function PendencyHandoverProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [from, setFrom] = useState<HandoverFrom | null>(null);
  return (
    <OpenHandover.Provider value={setFrom}>
      {children}
      <PendencyHandoverDialog from={from} onClose={() => setFrom(null)} />
    </OpenHandover.Provider>
  );
}

/**
 * "Passar minhas pendências" / "Passar as pendências de {nome}" (K3-4, DT9): lista as pendências em tratativa de quem
 * sai (todas marcadas, desmarcáveis), o destino e a observação, obrigatória e comum a todas. O formulário vive dentro
 * do conteúdo: fechar o desmonta e nada do que foi digitado sobra para a próxima abertura.
 */
export function PendencyHandoverDialog({
  from,
  onClose,
}: {
  from: HandoverFrom | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={from !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        {from && <HandoverForm from={from} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
