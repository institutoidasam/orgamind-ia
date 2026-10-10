import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Priority } from "../schemas";
import { civilDate } from "../utils";
import type {
  Draft,
  EligibleMember,
  UpdateDraft,
  WizardSector,
} from "./communication-wizard-model";

type ContentProps = {
  draft: Draft;
  sectors: WizardSector[];
  isAdmin: boolean;
  onChange: UpdateDraft;
};
type RecipientsProps = {
  draft: Draft;
  sectors: WizardSector[];
  members: EligibleMember[];
  onChange: UpdateDraft;
};
type ReviewProps = {
  draft: Draft;
  origin?: string;
  destination?: string;
  ccNames: string[];
  assigneeName?: string | null;
};

export function ContentStep({
  draft,
  sectors,
  isAdmin,
  onChange,
}: ContentProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <KindPicker kind={draft.kind} onChange={onChange} />
      <ContentFields draft={draft} onChange={onChange} />
      <SectorFields
        draft={draft}
        sectors={sectors}
        isAdmin={isAdmin}
        onChange={onChange}
      />
      {draft.kind === "DEMAND" ? (
        <DemandFields draft={draft} onChange={onChange} />
      ) : null}
    </div>
  );
}

export function RecipientsStep({
  draft,
  sectors,
  members,
  onChange,
}: RecipientsProps) {
  const availableSectors = sectors.filter(
    (sector) =>
      sector.id !== draft.destinationSectorId &&
      sector.id !== draft.originSectorId,
  );
  return (
    <div className="space-y-5">
      {draft.kind === "DEMAND" ? (
        <AssigneeField draft={draft} members={members} onChange={onChange} />
      ) : null}
      <CcFields draft={draft} sectors={availableSectors} onChange={onChange} />
      <NotificationFields draft={draft} onChange={onChange} />
    </div>
  );
}

export function ReviewStep({
  draft,
  origin,
  destination,
  ccNames,
  assigneeName,
}: ReviewProps) {
  return (
    <dl className="grid gap-3 text-sm">
      <ReviewItem label="Tipo">
        {draft.kind === "DEMAND" ? "Demanda" : "Comunicado"}
      </ReviewItem>
      <ReviewItem label="Assunto">{draft.subject}</ReviewItem>
      <ReviewItem label="Origem → destino">
        {origin} → {destination}
      </ReviewItem>
      {ccNames.length ? (
        <ReviewItem label="Em ciência">{ccNames.join(", ")}</ReviewItem>
      ) : null}
      {draft.kind === "DEMAND" ? (
        <DemandReview draft={draft} assigneeName={assigneeName} />
      ) : null}
      <ReviewItem label="Notificações">
        <NotificationSummary draft={draft} />
      </ReviewItem>
      <ReviewItem label="Mensagem">
        <span className="whitespace-pre-wrap">{draft.message}</span>
      </ReviewItem>
    </dl>
  );
}

function KindPicker({
  kind,
  onChange,
}: {
  kind: Draft["kind"];
  onChange: UpdateDraft;
}) {
  return (
    <fieldset className="md:col-span-2">
      <legend className="mb-2 font-medium">O que você quer fazer?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant={kind === "DEMAND" ? "default" : "outline"}
          onClick={() => onChange("kind", "DEMAND")}
        >
          Solicitar uma ação: acompanhar prazo e responsável
        </Button>
        <Button
          type="button"
          variant={kind === "ANNOUNCEMENT" ? "default" : "outline"}
          onClick={() => onChange("kind", "ANNOUNCEMENT")}
        >
          Enviar comunicado: informar equipes sem tarefa
        </Button>
      </div>
    </fieldset>
  );
}

function ContentFields({
  draft,
  onChange,
}: Pick<ContentProps, "draft" | "onChange">) {
  return (
    <>
      <label className="grid gap-1 md:col-span-2">
        Assunto
        <Input
          value={draft.subject}
          onChange={(event) => onChange("subject", event.target.value)}
          maxLength={160}
        />
      </label>
      <label className="grid gap-1 md:col-span-2">
        Mensagem
        <Textarea
          value={draft.message}
          onChange={(event) => onChange("message", event.target.value)}
          maxLength={10000}
        />
        <span className="text-xs text-muted-foreground">
          Use linguagem objetiva. O histórico ficará visível aos setores
          envolvidos.
        </span>
      </label>
    </>
  );
}

function SectorFields({ draft, sectors, isAdmin, onChange }: ContentProps) {
  const destinationSectors = sectors.filter(
    (sector) => sector.id !== draft.originSectorId,
  );
  return (
    <>
      <label className="grid gap-1">
        Setor de origem
        <select
          className="h-9 rounded-lg border bg-card px-2"
          value={draft.originSectorId}
          disabled={!isAdmin}
          onChange={(event) => onChange("originSectorId", event.target.value)}
        >
          <option value="">Selecione…</option>
          {sectors.map((sector) => (
            <option key={sector.id} value={sector.id}>
              {sector.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        Setor destinatário
        <select
          className="h-9 rounded-lg border bg-card px-2"
          value={draft.destinationSectorId}
          onChange={(event) =>
            onChange("destinationSectorId", event.target.value)
          }
        >
          <option value="">Selecione…</option>
          {destinationSectors.map((sector) => (
            <option key={sector.id} value={sector.id}>
              {sector.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function DemandFields({
  draft,
  onChange,
}: Pick<ContentProps, "draft" | "onChange">) {
  return (
    <>
      <label className="grid gap-1">
        Prioridade
        <select
          className="h-9 rounded-lg border bg-card px-2"
          value={draft.priority}
          onChange={(event) =>
            onChange("priority", event.target.value as Priority)
          }
        >
          <option value="NORMAL">Normal</option>
          <option value="HIGH">Alta</option>
          <option value="URGENT">Urgente</option>
        </select>
      </label>
      <label className="grid gap-1">
        Prazo desejado
        <Input
          type="date"
          value={draft.dueDate}
          onChange={(event) => onChange("dueDate", event.target.value)}
        />
      </label>
    </>
  );
}

function AssigneeField({
  draft,
  members,
  onChange,
}: Pick<RecipientsProps, "draft" | "members" | "onChange">) {
  return (
    <label className="grid max-w-sm gap-1">
      Responsável inicial
      <select
        className="h-9 rounded-lg border bg-card px-2"
        value={draft.assigneeId}
        onChange={(event) => onChange("assigneeId", event.target.value)}
      >
        <option value="">Definir após o envio</option>
        {members.map((member) => (
          <option value={member.id} key={member.id}>
            {member.name || member.email}
          </option>
        ))}
      </select>
    </label>
  );
}

function CcFields({
  draft,
  sectors,
  onChange,
}: Pick<RecipientsProps, "draft" | "sectors" | "onChange">) {
  function toggleSector(id: string) {
    const ccSectorIds = draft.ccSectorIds.includes(id)
      ? draft.ccSectorIds.filter((value) => value !== id)
      : [...draft.ccSectorIds, id];
    onChange("ccSectorIds", ccSectorIds);
  }
  return (
    <fieldset>
      <legend className="mb-2 font-medium">Dar ciência a outros setores</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {sectors.map((sector) => (
          <label className="flex items-center gap-2" key={sector.id}>
            <Checkbox
              checked={draft.ccSectorIds.includes(sector.id)}
              onCheckedChange={() => toggleSector(sector.id)}
            />
            {sector.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NotificationFields({
  draft,
  onChange,
}: Pick<RecipientsProps, "draft" | "onChange">) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">Notificações</legend>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={draft.notifyTeam}
          onCheckedChange={(value) => onChange("notifyTeam", Boolean(value))}
        />
        Notificar o setor destinatário
      </label>
      {draft.kind === "DEMAND" ? (
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.notifyAssignee}
            onCheckedChange={(value) =>
              onChange("notifyAssignee", Boolean(value))
            }
          />
          Notificar também o responsável
        </label>
      ) : null}
    </fieldset>
  );
}

function DemandReview({
  draft,
  assigneeName,
}: Pick<ReviewProps, "draft" | "assigneeName">) {
  const priority = { NORMAL: "Normal", HIGH: "Alta", URGENT: "Urgente" }[
    draft.priority
  ];
  return (
    <>
      <ReviewItem label="Responsável">
        {assigneeName || "Definir após o envio"}
      </ReviewItem>
      <ReviewItem label="Prioridade e prazo">
        {priority} · {civilDate(draft.dueDate)}
      </ReviewItem>
    </>
  );
}

function NotificationSummary({ draft }: Pick<ReviewProps, "draft">) {
  const team = draft.notifyTeam
    ? "Setor destinatário será notificado."
    : "Setor destinatário sem notificação.";
  return draft.kind === "ANNOUNCEMENT"
    ? team
    : `${team} ${draft.notifyAssignee ? "Responsável será notificado." : "Responsável sem notificação."}`;
}

function ReviewItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
