import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  SegmentSummary,
  SegmentDetail,
  CreateSegment,
  UpdateSegment,
  SegmentPreviewResult,
} from "./schemas";

function invalidateSegmentTree(qc: QueryClient, id?: string) {
  qc.invalidateQueries({
    predicate: (q) => {
      if (q.queryKey[0] !== "segments") return false;
      if (id == null) return true;
      // matches ['segments'], ['segments', id], ['segments', id, 'preview']
      return q.queryKey[1] == null || q.queryKey[1] === id;
    },
  });
}

export const segmentsQueries = {
  list: () =>
    queryOptions({
      queryKey: ["segments"] as const,
      queryFn: () => api.get("segments").json<SegmentSummary[]>(),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: ["segments", id] as const,
      queryFn: () => api.get(`segments/${id}`).json<SegmentDetail>(),
    }),
};

export function useSegments() {
  return useQuery(segmentsQueries.list());
}

export function useSegment(id: string | undefined) {
  return useQuery({
    ...segmentsQueries.detail(id ?? ""),
    enabled: !!id,
  });
}

export function useSegmentPreview(id: string | undefined) {
  return useQuery({
    queryKey: ["segments", id, "preview"] as const,
    queryFn: () =>
      api.get(`segments/${id}/preview`).json<SegmentPreviewResult>(),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSegment): Promise<SegmentDetail> =>
      api.post("segments", { json: input }).json<SegmentDetail>(),
    onSuccess: () => invalidateSegmentTree(qc),
  });
}

export function useUpdateSegment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateSegment): Promise<SegmentDetail> =>
      api.patch(`segments/${id}`, { json: patch }).json<SegmentDetail>(),
    onSuccess: () => invalidateSegmentTree(qc, id),
  });
}

export function useDeleteSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`segments/${id}`);
    },
    onSuccess: (_, id) => invalidateSegmentTree(qc, id),
  });
}
