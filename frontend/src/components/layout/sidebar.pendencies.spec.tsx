import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HTTPError } from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...a: unknown[]) => get(...a) },
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => ({ location: { pathname: "/dashboard" } }),
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/internal-unread", () => ({
  useInternalUnreadCount: () => ({ data: { count: 0 } }),
}));

import { Sidebar } from "./sidebar";

const LINK = { name: /Pendências da equipe/ };

function renderSidebar(role: string) {
  const user = { email: `${role}@orgamind.com`, name: role, role };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <Sidebar collapsed={false} user={user} />
    </QueryClientProvider>,
  );
  return client;
}

function countReturns(unassignedOverdue: number) {
  get.mockReturnValue({ json: () => Promise.resolve({ unassignedOverdue }) });
}

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function forbiddenNotSender(): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: "HTTPError",
    message: "status 403",
    data: { code: "team_whatsapp.forbidden" },
    response: { status: 403 },
  });
  return err;
}

beforeEach(() => {
  get.mockReset();
  toastError.mockClear();
});
afterEach(cleanup);

describe("Sidebar: Pendências da equipe (K2-6, aceite 12)", () => {
  it("remetente — item com o número do contador", async () => {
    countReturns(7);
    renderSidebar("SUPERVISOR");

    const link = await screen.findByRole("link", LINK);
    expect(link).toHaveAttribute("href", "/pendencias-equipe");
    expect(link).toHaveTextContent("7");
    expect(get).toHaveBeenCalledWith("internal/team-whatsapp/pendency-count");
  });

  it("aceite 12: 403 forbidden (null) — item some, sem erro nem toast", async () => {
    get.mockReturnValue({ json: () => Promise.reject(forbiddenNotSender()) });
    const client = renderSidebar("OPERATOR");

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryState(["team-pendencies", "count"])?.status).toBe(
      "success",
    );
    expect(screen.queryByRole("link", LINK)).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("aceite 12: VIEWER — nenhuma consulta", async () => {
    renderSidebar("VIEWER");

    await screen.findByRole("link", { name: "Demandas" });
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", LINK)).not.toBeInTheDocument();
  });

  it("carregando — item escondido", async () => {
    get.mockReturnValue({ json: () => new Promise(() => undefined) });
    renderSidebar("ADMIN");

    await screen.findByRole("link", { name: "WhatsApp da equipe" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link", LINK)).not.toBeInTheDocument();
  });

  it("zero — item sem número", async () => {
    countReturns(0);
    renderSidebar("ADMIN");

    const link = await screen.findByRole("link", LINK);
    expect(link).toHaveTextContent(/^Pendências da equipe$/);
  });
});
