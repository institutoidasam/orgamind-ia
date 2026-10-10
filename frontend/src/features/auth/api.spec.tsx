// auth/api.spec.tsx
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChangePassword, useLogin } from "./api";
import { useAuthStore } from "@/stores/auth.store";
import { queryClient } from "@/lib/query-client";

// Controllable fake api client.
let jsonResult: unknown = {};
const { logoutRemote } = vi.hoisted(() => ({ logoutRemote: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: {
    post: () => ({ json: () => Promise.resolve(jsonResult) }),
  },
  logoutRemote,
}));

const VALID = {
  accessToken: "tok",
  mustChangePassword: false,
  user: { id: "u1", email: "a@b.com", name: "A", role: "ADMIN" as const },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jsonResult = {};
  logoutRemote.mockReset();
  queryClient.clear();
  logoutRemote.mockImplementation(async () => {
    useAuthStore.getState().logout();
    queryClient.clear();
  });
  useAuthStore.setState({
    accessToken: null,
    user: null,
    mustChangePassword: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useLogin response validation", () => {
  it("accepts a well-formed login response and sets the session", async () => {
    jsonResult = VALID;
    const { result } = renderHook(() => useLogin(), { wrapper });

    await result.current.mutateAsync({
      email: "a@b.com",
      password: "password1",
    });

    expect(useAuthStore.getState().accessToken).toBe("tok");
    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().user?.sectorId).toBeNull();
    expect(useAuthStore.getState().user?.isActive).toBe(true);
  });

  it("rejects a malformed login response instead of blindly casting it", async () => {
    // Missing accessToken + bad role — a raw cast would happily pass this on.
    jsonResult = {
      mustChangePassword: false,
      user: { id: "u1", email: "a@b.com", name: "A", role: "WRONG" },
    };
    const { result } = renderHook(() => useLogin(), { wrapper });

    await expect(
      result.current.mutateAsync({ email: "a@b.com", password: "password1" }),
    ).rejects.toBeTruthy();

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
  });
});

describe('useChangePassword', () => {
  it('descarta a sessão local depois de trocar a senha com sucesso', async () => {
    useAuthStore.setState({ accessToken: 'session-token', user: VALID.user, mustChangePassword: true });
    queryClient.setQueryData(['internal-communications', 'unread-count'], { count: 2 });
    const { result } = renderHook(() => useChangePassword(), { wrapper });
    const passwordInput = { currentPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() };

    await result.current.mutateAsync(passwordInput);

    expect(logoutRemote).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().mustChangePassword).toBe(false);
    expect(queryClient.getQueryData(['internal-communications', 'unread-count'])).toBeUndefined();
  });
});
