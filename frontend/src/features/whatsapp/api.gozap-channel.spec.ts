// frontend/src/features/whatsapp/api.gozap-channel.spec.ts
//
// Hook-level coverage for the GOZAP channel lifecycle (F-A Task 8):
// useCreateGozapChannel, useGozapQr, useDeleteGozapChannel. Mocks
// `@tanstack/react-query` itself (same technique as bots/api.test.ts) so
// mutations/queries run outside React rendering — no QueryClientProvider,
// no act() noise, just the wiring: which endpoint gets called, with what
// body, and what refetchInterval the QR query registers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const postMock = vi.fn();
const getMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
    get: (...args: unknown[]) => getMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

const invalidateQueriesMock = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn((opts: Record<string, unknown>) => ({ data: undefined, isLoading: true, ...opts })),
    useMutation: vi.fn(({ mutationFn, onSuccess }: {
      mutationFn: (input: unknown) => Promise<unknown>;
      onSuccess?: (result: unknown, input: unknown, ctx: unknown) => void;
    }) => ({
      mutateAsync: async (input: unknown) => {
        const result = await mutationFn(input);
        if (onSuccess) onSuccess(result, input, undefined);
        return result;
      },
      isPending: false,
    })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: invalidateQueriesMock })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCreateGozapChannel', () => {
  it('POSTs whatsapp/channels with provider GOZAP and ONLY the name — no phoneE164/zernioAccountId', async () => {
    postMock.mockReturnValue({
      json: async () => ({
        id: 'ch1',
        name: 'Loja 1',
        phoneE164: null,
        isActive: true,
        isDefault: false,
        provider: 'GOZAP',
      }),
    });
    const { useCreateGozapChannel } = await import('./api');
    const result = await useCreateGozapChannel().mutateAsync({ name: 'Loja 1' });

    expect(postMock).toHaveBeenCalledWith('whatsapp/channels', {
      json: { provider: 'GOZAP', name: 'Loja 1' },
    });
    const [, opts] = postMock.mock.calls[0] as [string, { json: Record<string, unknown> }];
    expect(Object.keys(opts.json).sort()).toEqual(['name', 'provider']);
    expect(opts.json).not.toHaveProperty('phoneE164');
    expect(opts.json).not.toHaveProperty('zernioAccountId');
    expect(result).toEqual(expect.objectContaining({ id: 'ch1', provider: 'GOZAP' }));
  });

  it('never expects a token back — the backend response has none and the schema does not require one', async () => {
    postMock.mockReturnValue({
      json: async () => ({
        id: 'ch1',
        name: 'Loja 1',
        phoneE164: null,
        isActive: true,
        isDefault: false,
        provider: 'GOZAP',
      }),
    });
    const { useCreateGozapChannel } = await import('./api');
    const result = await useCreateGozapChannel().mutateAsync({ name: 'Loja 1' });
    expect(result).not.toHaveProperty('gozapInstanceToken');
    expect(result).not.toHaveProperty('token');
  });

  it('invalidates the providers query on success', async () => {
    postMock.mockReturnValue({
      json: async () => ({
        id: 'ch1', name: 'X', phoneE164: null, isActive: true, isDefault: false, provider: 'GOZAP',
      }),
    });
    const { useCreateGozapChannel } = await import('./api');
    await useCreateGozapChannel().mutateAsync({ name: 'X' });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['whatsapp', 'providers'] });
  });
});

describe('useGozapQr', () => {
  it('GETs whatsapp/channels/:id/qr', async () => {
    getMock.mockReturnValue({ json: async () => ({ state: 'connecting' }) });
    const { useGozapQr } = await import('./api');
    const { useQuery } = await import('@tanstack/react-query');

    useGozapQr('ch1');
    const queryArg = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      queryFn: () => Promise<unknown>;
      queryKey: unknown[];
      enabled: boolean;
    };
    expect(queryArg.queryKey).toEqual(['whatsapp', 'channels', 'ch1', 'qr']);
    expect(queryArg.enabled).toBe(true);

    const result = await queryArg.queryFn();
    expect(getMock).toHaveBeenCalledWith('whatsapp/channels/ch1/qr');
    expect(result).toEqual({ state: 'connecting' });
  });

  it('is disabled while channelId is undefined — no fetch', async () => {
    const { useGozapQr } = await import('./api');
    const { useQuery } = await import('@tanstack/react-query');

    useGozapQr(undefined);
    const queryArg = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0][0] as { enabled: boolean };
    expect(queryArg.enabled).toBe(false);
  });

  // The behaviour under test: reuse `qrRefetchInterval` (already unit-tested
  // in api.qr-interval.spec.ts) so the QR poll STOPS the moment the channel
  // reports 'open' — same anti-storm guard EVOLUTION relies on, mirrored here
  // for GOZAP's own QR cache (25s, gozap-instances.service.ts).
  it('STOPS polling once state is "open"', async () => {
    const { useGozapQr } = await import('./api');
    const { useQuery } = await import('@tanstack/react-query');

    useGozapQr('ch1');
    const queryArg = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      refetchInterval: (q: { state: { data: { state: string } | undefined } }) => number | false;
    };

    expect(queryArg.refetchInterval({ state: { data: { state: 'open' } } })).toBe(false);
    expect(queryArg.refetchInterval({ state: { data: { state: 'connecting' } } })).toBe(3_000);
    expect(queryArg.refetchInterval({ state: { data: { state: 'close' } } })).toBe(3_000);
    expect(queryArg.refetchInterval({ state: { data: undefined } })).toBe(3_000);
  });
});

describe('useDeleteGozapChannel', () => {
  it('DELETEs whatsapp/channels/:id', async () => {
    deleteMock.mockResolvedValue(undefined);
    const { useDeleteGozapChannel } = await import('./api');
    await useDeleteGozapChannel().mutateAsync('ch1');
    expect(deleteMock).toHaveBeenCalledWith('whatsapp/channels/ch1');
  });

  it('invalidates the providers query on success', async () => {
    deleteMock.mockResolvedValue(undefined);
    const { useDeleteGozapChannel } = await import('./api');
    await useDeleteGozapChannel().mutateAsync('ch1');
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['whatsapp', 'providers'] });
  });
});
