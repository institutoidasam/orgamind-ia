import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { draftHeader, useMessageDraft } from "./message-draft";
import type { TeamPurpose } from "./schemas";
import type { ActivityDraft } from "./use-send-filters";

const ACTIVITY: ActivityDraft = {
  date: "2026-11-25",
  time: "09:30",
  place: "Sala 2",
};
const HEADER = "Reunião em 25/11/2026 às 09:30 — Sala 2.\n\n";

type Props = { purpose: TeamPurpose; activity: ActivityDraft | null };

function setup(initial: Partial<Props> = {}) {
  return renderHook(
    (props: Props) => useMessageDraft(props.purpose, props.activity),
    {
      initialProps: { purpose: "meeting", activity: ACTIVITY, ...initial },
    },
  );
}

describe("draftHeader", () => {
  it("cabeçalho com e sem local", () => {
    expect(draftHeader("meeting", ACTIVITY)).toBe(HEADER);
    expect(draftHeader("lecture", { ...ACTIVITY, place: "  " })).toBe(
      "Palestra em 25/11/2026 às 09:30.\n\n",
    );
    expect(draftHeader("overtime", { ...ACTIVITY, place: null })).toBe(
      "Hora extra em 25/11/2026 às 09:30.\n\n",
    );
  });
});

describe("useMessageDraft: preencher", () => {
  it("preencher com texto vazio, com texto que começa pelo cabeçalho e com texto livre", () => {
    const { result, rerender } = setup();
    act(() => result.current.fill());
    expect(result.current.text).toBe(HEADER);

    act(() => result.current.setText(`${HEADER}Levem o material.`));
    rerender({ purpose: "meeting", activity: { ...ACTIVITY, time: "10:00" } });
    act(() => result.current.fill());
    expect(result.current.text).toBe(
      "Reunião em 25/11/2026 às 10:00 — Sala 2.\n\nLevem o material.",
    );

    act(() => result.current.setText("Levem o material."));
    act(() => result.current.fill());
    expect(result.current.text).toBe(
      "Reunião em 25/11/2026 às 10:00 — Sala 2.\n\nLevem o material.",
    );
  });

  it("só preenche com finalidade que tem atividade e com data e hora", () => {
    const urgency = setup({ purpose: "urgency" });
    const noTime = setup({ activity: { ...ACTIVITY, time: "" } });
    const noDate = setup({ activity: { ...ACTIVITY, date: "" } });
    const none = setup({ activity: null });
    for (const { result } of [urgency, noTime, noDate, none]) {
      expect(result.current.canFill).toBe(false);
      act(() => result.current.fill());
      expect(result.current.text).toBe("");
    }
    expect(setup().result.current.canFill).toBe(true);
    expect(setup({ purpose: "alignment" }).result.current.canFill).toBe(true);
  });
});

describe("useMessageDraft: dados que mudaram", () => {
  it("stale ao mudar data, hora ou local; não ao mudar o texto", () => {
    const { result, rerender } = setup();
    expect(result.current.stale).toBe(false);
    act(() => result.current.fill());
    act(() => result.current.setText("Outro texto"));
    expect(result.current.stale).toBe(false);

    const changes: Partial<ActivityDraft>[] = [
      { date: "2026-11-26" },
      { time: "10:00" },
      { place: "Sala 3" },
    ];
    for (const change of changes) {
      rerender({ purpose: "meeting", activity: { ...ACTIVITY, ...change } });
      expect(result.current.stale).toBe(true);
      rerender({ purpose: "meeting", activity: ACTIVITY });
      expect(result.current.stale).toBe(false);
    }
    rerender({ purpose: "lecture", activity: ACTIVITY });
    expect(result.current.stale).toBe(true);
  });

  it("Conferi o texto limpa o stale", () => {
    const { result, rerender } = setup();
    act(() => result.current.confirmChecked());
    rerender({ purpose: "meeting", activity: { ...ACTIVITY, time: "10:00" } });
    expect(result.current.stale).toBe(false);

    act(() => result.current.fill());
    rerender({ purpose: "meeting", activity: { ...ACTIVITY, time: "11:00" } });
    expect(result.current.stale).toBe(true);
    act(() => result.current.confirmChecked());
    expect(result.current.stale).toBe(false);
    rerender({ purpose: "meeting", activity: { ...ACTIVITY, time: "12:00" } });
    expect(result.current.stale).toBe(true);
  });
});
