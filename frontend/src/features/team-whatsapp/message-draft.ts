import { useState } from "react";
import { formatDatePtBr } from "@/lib/format-date-ptbr";
import { PURPOSE_LABEL } from "./labels";
import { PURPOSE_RULES } from "./purpose";
import type { TeamPurpose } from "./schemas";
import type { ActivityDraft } from "./use-send-filters";

/** Aviso do G2: o texto foi preenchido com dados que o operador mudou depois. Também é a trava do envio. */
export const DRAFT_STALE_TEXT =
  "Os dados da atividade mudaram depois que o texto foi preenchido. Confira o texto.";

/** Dados da atividade como o cabeçalho os usa: `place` vazio ou nulo = sem local. */
type HeaderActivity = { date: string; time: string; place: string | null };

/**
 * Cabeçalho do texto preenchido (G2, DG12): `{Finalidade} em {dd/mm/aaaa} às {HH:mm}`, ` — {local}` se houver, `.` e
 * uma linha em branco, para o operador seguir escrevendo abaixo. Não é template do WhatsApp: é texto livre.
 */
export function draftHeader(
  purpose: TeamPurpose,
  { date, time, place }: HeaderActivity,
): string {
  const where = place?.trim() ? ` — ${place.trim()}` : "";
  return `${PURPOSE_LABEL[purpose]} em ${formatDatePtBr(date)} às ${time}${where}.\n\n`;
}

/**
 * Põe o cabeçalho no texto: vazio, vira o cabeçalho; começando pelo último cabeçalho preenchido, troca só ele;
 * texto livre fica como está, com o cabeçalho antes (DG12).
 */
function withHeader(
  text: string,
  lastHeader: string | null,
  header: string,
): string {
  if (text.trim() === "") return header;
  if (lastHeader && text.startsWith(lastHeader)) {
    return header + text.slice(lastHeader.length);
  }
  return header + text;
}

/** O que o texto preenchido dizia: finalidade, data, hora e local (aparado). Sem atividade, só a finalidade. */
type Snapshot = {
  purpose: TeamPurpose;
  date: string;
  time: string;
  place: string;
};

function snapshotOf(
  purpose: TeamPurpose,
  activity: ActivityDraft | null,
): Snapshot {
  const { date = "", time = "", place = "" } = activity ?? {};
  return { purpose, date, time, place: place.trim() };
}

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.purpose === b.purpose &&
  a.date === b.date &&
  a.time === b.time &&
  a.place === b.place;

/**
 * `header`: o último cabeçalho posto no texto (para trocá-lo). `reference`: os dados do último preenchimento ou da
 * última conferência; null = nunca preencheu, e então nada fica velho.
 */
type DraftState = {
  text: string;
  header: string | null;
  reference: Snapshot | null;
};

const EMPTY: DraftState = { text: "", header: null, reference: null };

/**
 * Texto da mensagem e a marca do preenchimento (DG12), na página: fechar o diálogo não perde o texto e sair da
 * página perde; o envio aceito chama `reset()`. Finalidade sem atividade (Aviso de turno, Urgência) não preenche.
 * `stale`: finalidade, data, hora ou local mudaram desde o preenchimento (ou desde "Conferi o texto").
 */
export function useMessageDraft(
  purpose: TeamPurpose,
  activity: ActivityDraft | null,
) {
  const [state, setState] = useState<DraftState>(EMPTY);
  const data = PURPOSE_RULES[purpose].activity === "none" ? null : activity;
  const current = snapshotOf(purpose, data);
  const canFill = data !== null && data.date !== "" && data.time !== "";
  return {
    text: state.text,
    setText: (text: string) => setState((prev) => ({ ...prev, text })),
    canFill,
    stale: state.reference !== null && !sameSnapshot(state.reference, current),
    fill: () => {
      if (!canFill) return;
      const header = draftHeader(purpose, data);
      setState((prev) => ({
        text: withHeader(prev.text, prev.header, header),
        header,
        reference: current,
      }));
    },
    confirmChecked: () =>
      setState((prev) =>
        prev.reference ? { ...prev, reference: current } : prev,
      ),
    reset: () => setState(EMPTY),
  };
}

export type MessageDraft = ReturnType<typeof useMessageDraft>;
