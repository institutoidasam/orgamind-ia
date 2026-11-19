// frontend/src/features/whatsapp/api.disabled-channel.spec.ts
//
// Cobertura de hook para "Números desligados" (C3/C4): useRemoveDisabledChannel,
// o `.default([])` de `disabledChannels` em useProviders e a invalidação de
// useUpdateChannelSectors. Mocka `@tanstack/react-query` (mesma técnica de
// bots/api.test.ts) para rodar sem React: só importa o fio — qual endpoint
// é chamado e quais chaves são invalidadas.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const deleteMock = vi.fn();
const putMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
    put: (...args: unknown[]) => putMock(...args),
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

const INVALIDATED = [
  ['whatsapp', 'providers'],
  ['whatsapp', 'instances'],
  ['internal', 'sectors'],
  ['sector-people'],
];

function expectInvalidated() {
  for (const queryKey of INVALIDATED) {
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useRemoveDisabledChannel', () => {
  it('faz DELETE whatsapp/channels/:id e invalida as mesmas chaves de useUpdateChannelSectors', async () => {
    deleteMock.mockResolvedValue(undefined);
    const { useRemoveDisabledChannel } = await import('./api');
    await useRemoveDisabledChannel().mutateAsync('ch1');

    expect(deleteMock).toHaveBeenCalledWith('whatsapp/channels/ch1');
    expectInvalidated();
  });
});

describe('useUpdateChannelSectors', () => {
  it('faz PUT com a lista e invalida conexões e setores', async () => {
    putMock.mockReturnValue({
      json: async () => ({ channelId: 'ch1', sectors: [{ id: 'log', name: 'Logística' }], moved: [] }),
    });
    const { useUpdateChannelSectors } = await import('./api');
    const result = await useUpdateChannelSectors().mutateAsync({ channelId: 'ch1', sectorIds: ['log'] });

    expect(putMock).toHaveBeenCalledWith('whatsapp/channels/ch1/sectors', { json: { sectorIds: ['log'] } });
    expect(result.sectors).toEqual([{ id: 'log', name: 'Logística' }]);
    expectInvalidated();
  });
});

describe('useProviders — disabledChannels (C3)', () => {
  async function fetchProviders(payload: unknown) {
    getMock.mockReturnValue({ json: async () => payload });
    const api = await import('./api');
    const { queryFn } = api.useProviders() as unknown as { queryFn: () => Promise<{ disabledChannels: unknown[] }> };
    return queryFn();
  }

  it('api antiga sem disabledChannels vira []', async () => {
    expect((await fetchProviders({ providers: [] })).disabledChannels).toEqual([]);
  });

  it('lê os números desligados', async () => {
    const channel = { id: 'g1', name: 'GBR', provider: 'GOZAP', phoneE164: '+5511999990000', sectorNames: ['Produção'] };
    expect((await fetchProviders({ providers: [], disabledChannels: [channel] })).disabledChannels).toEqual([channel]);
  });
});
