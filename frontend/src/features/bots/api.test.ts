import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api-client module
const getMock = vi.fn();
const patchMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: getMock,
    patch: patchMock,
  },
}));

// Mock tanstack query
const invalidateQueriesMock = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(({ queryFn }) => ({ data: undefined, isLoading: true, queryFn })),
    useMutation: vi.fn(({ mutationFn, onSuccess }) => ({
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

describe('bots api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useDifyApps', () => {
    it('maps id -> difyAppId via schema transform', async () => {
      const rawApps = [
        { id: 'app-1', name: 'Vendas', mode: 'chat' },
        { id: 'app-2', name: 'Suporte', mode: 'agent-chat' },
      ];
      getMock.mockReturnValue({ json: async () => rawApps });

      const { useDifyApps } = await import('./api');
      const { useQuery } = await import('@tanstack/react-query');

      useDifyApps();

      expect(useQuery).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['bots', 'dify-apps'] })
      );

      // Extract the queryFn and test it directly
      const queryArg = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const result = await queryArg.queryFn();
      expect(getMock).toHaveBeenCalledWith('bots/dify-apps');
      expect(result).toEqual([
        { difyAppId: 'app-1', name: 'Vendas', mode: 'chat' },
        { difyAppId: 'app-2', name: 'Suporte', mode: 'agent-chat' },
      ]);
    });
  });

  describe('useAssignBot', () => {
    it('calls PATCH bots/assignment with the payload', async () => {
      const responseJson = { instanceId: 'inst1', botDifyAppId: 'app-1', botName: 'Vendas' };
      patchMock.mockReturnValue({ json: async () => responseJson });

      const { useAssignBot } = await import('./api');
      const hook = useAssignBot();

      const result = await hook.mutateAsync({ instanceId: 'inst1', difyAppId: 'app-1' });

      expect(patchMock).toHaveBeenCalledWith('bots/assignment', { json: { instanceId: 'inst1', difyAppId: 'app-1' } });
      expect(result).toEqual(responseJson);
    });

    it('invalidates whatsapp instances on success', async () => {
      patchMock.mockReturnValue({ json: async () => ({}) });

      const { useAssignBot } = await import('./api');
      const hook = useAssignBot();

      await hook.mutateAsync({ instanceId: 'inst1', difyAppId: null });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['whatsapp', 'instances'] });
    });
  });
});
