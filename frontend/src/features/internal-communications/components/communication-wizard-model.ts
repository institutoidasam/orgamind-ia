import type { CreateCommunication } from "../api";
import type { CommunicationKind, Priority } from "../schemas";

export type Draft = {
  kind: CommunicationKind;
  subject: string;
  message: string;
  originSectorId: string;
  destinationSectorId: string;
  ccSectorIds: string[];
  assigneeId: string;
  priority: Priority;
  dueDate: string;
  notifyTeam: boolean;
  notifyAssignee: boolean;
  clientRequestId: string;
};

export type WizardSector = { id: string; name: string };
export type EligibleMember = {
  id: string;
  name: string | null;
  email: string | null;
};
export type UpdateDraft = <K extends keyof Draft>(
  key: K,
  value: Draft[K],
) => void;

export function newDraft(
  originSectorId = "",
  kind: CommunicationKind = "DEMAND",
): Draft {
  return {
    kind,
    subject: "",
    message: "",
    originSectorId,
    destinationSectorId: "",
    ccSectorIds: [],
    assigneeId: "",
    priority: "NORMAL",
    dueDate: "",
    notifyTeam: true,
    notifyAssignee: true,
    clientRequestId: crypto.randomUUID(),
  };
}

export function changeDraft<K extends keyof Draft>(
  draft: Draft,
  key: K,
  value: Draft[K],
): Draft {
  if (key === "originSectorId") return changeOrigin(draft, value as string);
  if (key === "destinationSectorId")
    return changeDestination(draft, value as string);
  return { ...draft, [key]: value };
}

export function validateFirstStep(draft: Draft): string | undefined {
  if (!draft.subject.trim() || !draft.message.trim())
    return "Preencha assunto e mensagem para continuar.";
  if (!draft.originSectorId || !draft.destinationSectorId)
    return "Selecione os setores de origem e destinatário para continuar.";
  return undefined;
}

export function toCreateInput(draft: Draft): CreateCommunication {
  const common = {
    kind: draft.kind,
    subject: draft.subject.trim(),
    message: draft.message.trim(),
    originSectorId: draft.originSectorId,
    destinationSectorId: draft.destinationSectorId,
    ccSectorIds: draft.ccSectorIds,
    notifyTeam: draft.notifyTeam,
    notifyAssignee: draft.notifyAssignee,
    clientRequestId: draft.clientRequestId,
  };
  if (draft.kind === "ANNOUNCEMENT") return common;
  return {
    ...common,
    priority: draft.priority,
    ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
    ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
  };
}

export function stepTitle(step: number): string {
  return (
    ["Tipo e conteúdo", "Destinatários", "Revisão e envio"][step - 1] ??
    "Nova comunicação"
  );
}

export function isActiveSector(
  sectors: WizardSector[],
  sectorId: string,
): boolean {
  return sectors.some((sector) => sector.id === sectorId);
}

function changeOrigin(draft: Draft, originSectorId: string): Draft {
  const destinationSectorId =
    draft.destinationSectorId === originSectorId
      ? ""
      : draft.destinationSectorId;
  return cleanRecipients({
    ...draft,
    originSectorId,
    destinationSectorId,
    assigneeId: destinationSectorId ? draft.assigneeId : "",
  });
}

function changeDestination(draft: Draft, destinationSectorId: string): Draft {
  return cleanRecipients({ ...draft, destinationSectorId, assigneeId: "" });
}

function cleanRecipients(draft: Draft): Draft {
  return {
    ...draft,
    ccSectorIds: draft.ccSectorIds.filter(
      (id) => id !== draft.originSectorId && id !== draft.destinationSectorId,
    ),
  };
}
