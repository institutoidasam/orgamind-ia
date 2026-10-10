import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreateInternalNumber,
  useInternalNumbers,
  useSectors,
  useUpdateInternalNumber,
} from "./api";

const { get, post, patch } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api: { get, post, patch } }));

const sector = {
  id: "sector-1", name: "Engenharia", code: "ENG", description: null,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
};
const secondSector = {
  ...sector,
  id: "sector-2",
  name: "Operações",
  code: "OPS",
};
const number = {
  id: "number-1", name: "Recepção", phone: "+5592999990000", provider: "META",
  sectorId: "sector-1", sector: { id: "sector-1", name: "Engenharia", code: "ENG" },
  routeToSector: true, channelId: null, createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

function response(value: unknown) { return { json: () => Promise.resolve(value) }; }
function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

function QueryProbe() {
  const sectors = useSectors(true);
  const numbers = useInternalNumbers();
  const sectorIds = sectors.data?.items.map(({ id }) => id).join(",") ?? "";
  const numberIds = numbers.data?.items.map(({ id }) => id).join(",") ?? "";
  return <p>{`${sectorIds}/${numberIds}`}</p>;
}

function MutationProbe() {
  const create = useCreateInternalNumber();
  const update = useUpdateInternalNumber("number-1");
  const input = { name: "Recepção", phone: "+5592999990000", provider: "META" as const, sectorId: "sector-1", routeToSector: true };
  return <><button onClick={() => create.mutate(input)}>create</button><button onClick={() => update.mutate({ name: "Novo" })}>update</button></>;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string, options?: { searchParams?: { page?: number } }) => {
    if (path === "internal/sectors") return response({ items: options?.searchParams?.page === 2 ? [secondSector] : [sector], total: 101, page: options?.searchParams?.page ?? 1, pageSize: 100 });
    return response({ items: [number], total: 1, page: 1, pageSize: 100 });
  });
  post.mockReturnValue(response(number));
  patch.mockReturnValue(response(number));
});

describe("internal admin API", () => {
  it("aggregates sector pages and loads structural numbers", async () => {
    wrap(<QueryProbe />);
    await waitFor(() => expect(screen.getByText("sector-1,sector-2/number-1")).toBeInTheDocument());
    expect(get).toHaveBeenCalledWith("internal/sectors", expect.objectContaining({ searchParams: expect.objectContaining({ activeOnly: true, page: 1 }) }));
    expect(get).toHaveBeenCalledWith("internal/sectors", expect.objectContaining({ searchParams: expect.objectContaining({ page: 2 }) }));
  });

  it("posts, patches and invalidates the number registry", async () => {
    const user = userEvent.setup();
    wrap(<MutationProbe />);
    await user.click(screen.getByRole("button", { name: "create" }));
    await user.click(screen.getByRole("button", { name: "update" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("internal/numbers", expect.any(Object)));
    expect(patch).toHaveBeenCalledWith("internal/numbers/number-1", expect.any(Object));
  });
});
