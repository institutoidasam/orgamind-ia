import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import {
  internalNumberListSchema,
  internalNumberSchema,
  sectorDetailSchema,
  sectorListSchema,
  type InternalNumberInput,
  type SectorInput,
} from "./schemas";

const sectorsKey = ["internal", "sectors"] as const;
const numbersKey = ["internal", "numbers"] as const;

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

export function useInternalNumbers() {
  return useQuery({
    queryKey: numbersKey,
    queryFn: listAllNumbers,
  });
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

async function listAllNumbers() {
  const first = internalNumberListSchema.parse(
    await api
      .get("internal/numbers", { searchParams: { page: 1, pageSize: 100 } })
      .json(),
  );
  return collectPages(first, (page) =>
    api
      .get("internal/numbers", { searchParams: { page, pageSize: 100 } })
      .json()
      .then((data) => internalNumberListSchema.parse(data)),
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

export function useCreateInternalNumber() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: InternalNumberInput) =>
      api
        .post("internal/numbers", { json: input })
        .json()
        .then((data) => internalNumberSchema.parse(data)),
    onSuccess: () => client.invalidateQueries({ queryKey: numbersKey }),
  });
}

export function useUpdateInternalNumber(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<InternalNumberInput>) =>
      api
        .patch(`internal/numbers/${id}`, { json: input })
        .json()
        .then((data) => internalNumberSchema.parse(data)),
    onSuccess: () => client.invalidateQueries({ queryKey: numbersKey }),
  });
}

function useSectorMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: sectorsKey }),
  });
}
