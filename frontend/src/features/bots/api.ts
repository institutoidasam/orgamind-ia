import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { difyAppSchema, type AssignBotInput, type DifyApp } from './schemas';

const difyAppListSchema = z.array(difyAppSchema);

export function useDifyApps() {
  return useQuery({
    queryKey: ['bots', 'dify-apps'],
    queryFn: async (): Promise<DifyApp[]> => difyAppListSchema.parse(await api.get('bots/dify-apps').json()),
  });
}

export function useAssignBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignBotInput) => api.patch('bots/assignment', { json: input }).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
  });
}
