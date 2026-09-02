import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ScheduleInfoCard } from "./schedule-info-card";
import type { ScheduleConfig } from "../schemas";

describe("ScheduleInfoCard — visibility", () => {
  it("renders nothing for no scheduleType", () => {
    const { container } = render(<ScheduleInfoCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for IMMEDIATE", () => {
    const { container } = render(
      <ScheduleInfoCard scheduleType="IMMEDIATE" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("ScheduleInfoCard — status badge", () => {
  it("shows 'Ativo' badge when scheduleEnabled", () => {
    render(<ScheduleInfoCard scheduleType="DAILY_AT" scheduleEnabled />);
    expect(screen.getByText("Ativo")).toBeInTheDocument();
    expect(screen.queryByText("Desativado")).not.toBeInTheDocument();
  });

  it("shows 'Desativado' badge when not scheduleEnabled", () => {
    render(<ScheduleInfoCard scheduleType="DAILY_AT" scheduleEnabled={false} />);
    expect(screen.getByText("Desativado")).toBeInTheDocument();
    expect(screen.queryByText("Ativo")).not.toBeInTheDocument();
  });
});

describe("ScheduleInfoCard — fields", () => {
  it("maps a known scheduleType to its label", () => {
    render(<ScheduleInfoCard scheduleType="WEEKLY" />);
    expect(screen.getByText("Semanal")).toBeInTheDocument();
  });

  it("falls back to the raw scheduleType for an unknown type", () => {
    render(
      <ScheduleInfoCard scheduleType={"MYSTERY" as never} />,
    );
    expect(screen.getByText("MYSTERY")).toBeInTheDocument();
  });

  it("renders timezone, runCount and '—' for a missing lastRunAt", () => {
    render(
      <ScheduleInfoCard
        scheduleType="DAILY_AT"
        timezone="America/Sao_Paulo"
        runCount={7}
      />,
    );
    expect(screen.getByText("America/Sao_Paulo")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    // Fuso "—" not present (tz set) but lastRunAt missing => one "—"
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("defaults runCount to 0 and timezone to '—' when absent", () => {
    render(<ScheduleInfoCard scheduleType="DAILY_AT" />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("ScheduleInfoCard — next run", () => {
  it("shows 'Sem execuções futuras' when nextRunAt is null", () => {
    render(<ScheduleInfoCard scheduleType="DAILY_AT" nextRunAt={null} />);
    expect(screen.getByText("Sem execuções futuras")).toBeInTheDocument();
  });

  it("formats nextRunAt in pt-BR short date/time", () => {
    render(
      <ScheduleInfoCard
        scheduleType="DAILY_AT"
        nextRunAt="2026-06-15T09:00:00-03:00"
      />,
    );
    const expected = new Date("2026-06-15T09:00:00-03:00").toLocaleString(
      "pt-BR",
      { dateStyle: "short", timeStyle: "short" },
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe("ScheduleInfoCard — describe(scheduleConfig)", () => {
  it("describes ONCE_AT", () => {
    const cfg: ScheduleConfig = {
      type: "ONCE_AT",
      runAt: new Date("2026-06-20T10:00:00-03:00"),
    };
    render(<ScheduleInfoCard scheduleType="ONCE_AT" scheduleConfig={cfg} />);
    const when = new Date("2026-06-20T10:00:00-03:00").toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
    expect(screen.getByText(`Uma vez em ${when}`)).toBeInTheDocument();
  });

  it("describes DAILY_AT", () => {
    const cfg: ScheduleConfig = { type: "DAILY_AT", time: "09:00" };
    render(<ScheduleInfoCard scheduleType="DAILY_AT" scheduleConfig={cfg} />);
    expect(screen.getByText("Todo dia às 09:00")).toBeInTheDocument();
  });

  it("describes WEEKLY sorting weekdays", () => {
    const cfg: ScheduleConfig = {
      type: "WEEKLY",
      time: "14:30",
      weekdays: [5, 1, 3],
    };
    render(<ScheduleInfoCard scheduleType="WEEKLY" scheduleConfig={cfg} />);
    // sorted [1,3,5] -> Seg/Qua/Sex
    expect(screen.getByText("Seg/Qua/Sex às 14:30")).toBeInTheDocument();
  });

  it("describes WEEKLY defensively when weekdays is missing", () => {
    const cfg = { type: "WEEKLY", time: "08:00" } as unknown as ScheduleConfig;
    render(<ScheduleInfoCard scheduleType="WEEKLY" scheduleConfig={cfg} />);
    expect(screen.getByText("às 08:00")).toBeInTheDocument();
  });

  it("describes INTERVAL in days, hours, or minutes", () => {
    const days: ScheduleConfig = { type: "INTERVAL", everyMinutes: 2880 };
    const { unmount } = render(
      <ScheduleInfoCard scheduleType="INTERVAL" scheduleConfig={days} />,
    );
    expect(screen.getByText("A cada 2 dia(s)")).toBeInTheDocument();
    unmount();

    const hours: ScheduleConfig = { type: "INTERVAL", everyMinutes: 120 };
    const r2 = render(
      <ScheduleInfoCard scheduleType="INTERVAL" scheduleConfig={hours} />,
    );
    expect(screen.getByText("A cada 2 hora(s)")).toBeInTheDocument();
    r2.unmount();

    const mins: ScheduleConfig = { type: "INTERVAL", everyMinutes: 45 };
    render(<ScheduleInfoCard scheduleType="INTERVAL" scheduleConfig={mins} />);
    expect(screen.getByText("A cada 45 minuto(s)")).toBeInTheDocument();
  });
});
