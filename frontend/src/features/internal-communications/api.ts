import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { useSectors } from '@/features/internal-admin/api';
import {
  communicationDetailSchema, communicationPageSchema, eligibleMemberSchema, internalDashboardSchema,
  type CommunicationKind, type DemandStatus, type Priority,
} from './schemas';

export type CommunicationFilters = { q?: string; kind?: CommunicationKind; status?: DemandStatus; unassigned?: boolean; sectorId?: string; page?: number; pageSize?: number };
export type CreateCommunication = {
  kind: CommunicationKind; subject: string; message: string; originSectorId: string; destinationSectorId: string;
  ccSectorIds: string[]; assigneeId?: string; priority?: Priority; dueDate?: string; notifyTeam: boolean;
  notifyAssignee: boolean; clientRequestId: string;
};
export type DemandUpdate = { expectedVersion: number; status?: DemandStatus; assigneeId?: string | null; priority?: Priority; dueDate?: string | null };

const baseKey = ['internal-communications'] as const;

function searchParams(filters: CommunicationFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''));
}

function invalidate(client: ReturnType<typeof useQueryClient>) {
  return client.invalidateQueries({ queryKey: baseKey });
}

export function useCommunications(filters: CommunicationFilters = {}) {
  return useQuery({
    queryKey: [...baseKey, 'list', filters],
    queryFn: () => api.get('internal/communications', { searchParams: { page: 1, pageSize: 25, ...searchParams(filters) } }).json()
      .then((data) => communicationPageSchema.parse(data)),
  });
}

export function useInbox(filters: CommunicationFilters = {}) {
  return useQuery({
    queryKey: [...baseKey, 'inbox', filters],
    queryFn: () => api.get('internal/inbox', { searchParams: { page: 1, pageSize: 25, ...searchParams(filters) } }).json()
      .then((data) => communicationPageSchema.parse(data)),
  });
}

export function useCommunication(id: string) {
  return useQuery({
    queryKey: [...baseKey, 'detail', id], enabled: Boolean(id),
    queryFn: () => api.get(`internal/communications/${id}`).json().then((data) => communicationDetailSchema.parse(data)),
  });
}

export function useInternalDashboard() {
  return useQuery({
    queryKey: [...baseKey, 'dashboard'],
    queryFn: () => api.get('internal/dashboard').json().then((data) => internalDashboardSchema.parse(data)),
  });
}

export function useActiveSectors() {
  const sectors = useSectors(true);
  return { ...sectors, data: sectors.data?.items ?? [] };
}

export function useEligibleMembers(sectorId?: string) {
  return useQuery({
    queryKey: [...baseKey, 'eligible-members', sectorId], enabled: Boolean(sectorId),
    queryFn: () => api.get(`internal/sectors/${sectorId}/members`, { searchParams: { eligible: true } }).json()
      .then((data) => z.object({ items: z.array(eligibleMemberSchema) }).parse(data).items),
  });
}

export function useCreateCommunication() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCommunication) => api.post('internal/communications', { json: input }).json().then((data) => communicationDetailSchema.parse(data)),
    onSuccess: () => invalidate(client),
  });
}

export function useUpdateDemand(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DemandUpdate) => api.patch(`internal/communications/${id}/demand`, { json: input }).json().then((data) => communicationDetailSchema.parse(data)),
    onSuccess: () => invalidate(client),
  });
}

export function useComment(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => api.post(`internal/communications/${id}/comments`, { json: { message } }).json().then((data) => communicationDetailSchema.parse(data)),
    onSuccess: () => invalidate(client),
  });
}

export function useMarkCommunicationRead(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`internal/communications/${id}/read`).json().then((data) => communicationDetailSchema.parse(data)),
    onSuccess: () => invalidate(client),
  });
}
