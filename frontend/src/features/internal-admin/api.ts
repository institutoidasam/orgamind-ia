import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import {
  sectorDetailSchema,
  sectorListSchema,
  type SectorInput,
} from "./schemas";

/** Prefixo de toda query de setores (`useSectors`, `useSector`): invalidar este invalida as duas. */
export const sectorsKey = ["internal", "sectors"] as const;

export function useSectors(activeOnly = false) {
  return useQuery({
    queryKey: [...sectorsKey, { activeOnly }],
    queryFn: () => listAllSectors(activeOnly),
  });
}

export function useSector(id: string | undefined) {
  return useQuery({
    queryKey: [...sectorsKey, id],
    enabled: Boolean(id),
    queryFn: () =>
      api
        .get(`internal/sectors/${id}`)
        .json()
        .then((data) => sectorDetailSchema.parse(data)),
  });
}

export function useCreateSector() {
  return useSectorMutation((input: SectorInput) =>
    api.post("internal/sectors", { json: input }).json(),
  );
}

export function useUpdateSector(id: string) {
  return useSectorMutation((input: Partial<SectorInput>) =>
    api.patch(`internal/sectors/${id}`, { json: input }).json(),
  );
}

async function listAllSectors(activeOnly: boolean) {
  const first = await api
    .get("internal/sectors", {
      searchParams: {
        page: 1,
        pageSize: 100,
        ...(activeOnly ? { activeOnly: true } : {}),
      },
    })
    .json();
  const parsed = sectorListSchema.parse(first);
  return collectPages(parsed, (page) =>
    api
      .get("internal/sectors", {
        searchParams: {
          page,
          pageSize: 100,
          ...(activeOnly ? { activeOnly: true } : {}),
        },
      })
      .json()
      .then((data) => sectorListSchema.parse(data)),
  );
}

async function collectPages<
  Item,
  T extends { items: Item[]; total: number; pageSize: number },
>(first: T, load: (page: number) => Promise<T>) {
  const pages = Math.ceil(first.total / first.pageSize);
  if (pages <= 1) return first;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) => load(index + 2)),
  );
  return {
    ...first,
    items: [...first.items, ...rest.flatMap((page) => page.items)],
  };
}

function useSectorMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: sectorsKey }),
  });
}
