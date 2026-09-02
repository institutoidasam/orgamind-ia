import {
  useMutation,
  useQuery,
  useQueryClient,
  queryOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  Contact,
  ContactsListResponse,
  ListContactsQuery,
} from './schemas';

function invalidateContactTree(qc: QueryClient) {
  qc.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'contacts' || q.queryKey[0] === 'contact-facets',
  });
}

export const contactsQueries = {
  list: (q: ListContactsQuery) =>
    queryOptions({
      queryKey: ['contacts', q],
      queryFn: () =>
        api
          .get('contacts', {
            searchParams: q as Record<string, string | number | boolean>,
          })
          .json<ContactsListResponse>(),
    }),
};

/**
 * `enabled` (default `true`) é do CHAMADOR — achado 3 (revisão): o diálogo
 * "Validar números" fica SEMPRE montado (o `open` do Radix só o esconde
 * visualmente) e chamava este hook sem freio nenhum, disparando
 * `?validity=unvalidated&pageSize=1` a CADA carregamento da tela de
 * contatos, mesmo com o diálogo fechado. Mesmo idioma do `enabled` de
 * `useSyncProgress`, abaixo.
 */
export function useContacts(
  q: ListContactsQuery,
  options?: { enabled?: boolean },
) {
  return useQuery({ ...contactsQueries.list(q), enabled: options?.enabled ?? true });
}

type CreateContactPayload = {
  phone: string;
  name?: string;
  city?: string;
  group?: string;
  tags?: string[];
};

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactPayload) =>
      api.post('contacts', { json: input }).json<Contact>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

type UpdateContactPayload = {
  name?: string;
  city?: string;
  group?: string;
  tags?: string[];
  optedOut?: boolean;
};

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContactPayload }) =>
      api.patch(`contacts/${id}`, { json: input }).json<Contact>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`contacts/${id}`).json<Contact>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

/**
 * Duas formas de apagar em massa, e só duas:
 *  - `ids`: a seleção de caixinhas da página (o caminho de sempre);
 *  - `validity: 'invalid'`: TODOS os inválidos confirmados, o pedido do
 *    cliente. O back apaga por PREDICADO — a tela nunca manda milhares de ids.
 * `expectedCount` só vale junto de `validity`: é a contagem que o operador
 * viu e confirmou na tela. O back recusa com 409 (sem apagar nada) se a
 * contagem viva já não bater — sinal de que a lista mudou entre a tela e o
 * clique.
 */
type BulkDeletePayload = {
  ids?: string[];
  validity?: 'invalid';
  expectedCount?: number;
};

export function useBulkDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkDeletePayload) =>
      api
        .post('contacts/bulk-delete', { json: input })
        .json<{ deleted: number }>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

/**
 * Persist a contact's WhatsApp labels — backend reconciles the diff
 * (additions + removals) through Evolution before mirroring locally.
 * 30s timeout because each label add/remove is its own Evolution call.
 */
export function useSetContactLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; labelIds: string[] }) =>
      api
        .post(`contacts/${input.id}/labels`, {
          json: { labelIds: input.labelIds },
          timeout: 30_000,
        })
        .json<Contact>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

/**
 * Dispara a validação ativa. `startedAt` volta na resposta e é o MARCO da
 * barra de progresso — sem ele a tela contaria checagens de ontem como se
 * fossem desta rodada. `total` é o DENOMINADOR da barra: quantos ids este
 * pedido selecionou de fato (não a contagem ao vivo da lista, que pode
 * encolher durante a própria validação — ver `useSyncProgress`).
 */
export function useSyncContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'unvalidated' | 'all') =>
      api.post('contacts/sync', { json: { mode } }).json<{
        enqueued: number;
        total: number;
        mode: 'unvalidated' | 'all';
        startedAt: string;
      }>(),
    onSuccess: () => invalidateContactTree(qc),
  });
}

/**
 * Progresso da validação ativa.
 *
 * `total` é o denominador CAPTURADO na resposta do POST (não recalculado ao
 * vivo) — é contra ele que `checked` é comparado para saber quando parar.
 *
 * `enabled` é do CHAMADOR: verdadeiro só quando o diálogo está aberto E uma
 * rodada foi disparada (`since` não-nulo). O diálogo de sincronizar fica
 * SEMPRE montado (o Radix `open` só o esconde visualmente), então sem este
 * controle o polling de 5s nunca pararia, mesmo com o diálogo fechado.
 *
 * `refetchInterval` em forma de função (mesmo padrão de
 * `campaigns/api.ts#useCampaign`) porque "continuar repetindo" depende de um
 * estado (o `checked` mais recente) que só existe DEPOIS da primeira
 * resposta — não dá para decidir com um número estático:
 *   - `!enabled` → para (diálogo fechado ou nenhuma rodada em curso);
 *   - erro → para (não fica martelando um endpoint que está falhando);
 *   - `checked >= total` → para (a rodada terminou, continuar seria
 *     desperdício até o operador disparar outra).
 */
export function useSyncProgress({
  since,
  total,
  enabled,
}: {
  since: string | null;
  total: number;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ['contact-sync-progress', since],
    enabled: enabled && since !== null,
    refetchInterval: (query) => {
      if (!enabled) return false;
      if (query.state.status === 'error') return false;
      if ((query.state.data?.checked ?? 0) >= total) return false;
      return 5_000;
    },
    // Achado 3 (revisão) — mesmo idioma de `campaigns/api.ts#useCampaign`:
    // sem isto, a aba em segundo plano continuaria martelando o endpoint a
    // cada 5s enquanto o operador olha outra janela.
    refetchIntervalInBackground: false,
    queryFn: () =>
      api
        .get('contacts/sync/progress', { searchParams: { since: since ?? '' } })
        .json<{ checked: number; unvalidated: number }>(),
  });
}

/**
 * Os parâmetros da planilha são os MESMOS da tela, menos a paginação — o
 * operador exporta o que está vendo.
 *
 * Chave vazia é DESCARTADA, e não enviada: `?city=` não significa "cidade
 * vazia", significa "sem filtro de cidade". Enviá-la faria a planilha
 * discordar da tela no primeiro filtro limpo. `optedOut: false` sobrevive
 * porque a comparação é com `''`/`undefined`, nunca com falsy.
 */
export function buildExportSearchParams(
  q: ListContactsQuery,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(q)) {
    if (key === 'page' || key === 'pageSize') continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Baixa a planilha PELA API autenticada (ky põe o Bearer no cabeçalho) e
 * devolve o Blob — um `<a href>` cru para a rota não carregaria o token e
 * levaria o operador a uma tela de 401 em branco.
 *
 * 120s de timeout: 50 mil linhas em streaming levam mais que os 15s padrão do
 * cliente, e um timeout aqui aparece como "erro ao exportar" sem explicação.
 */
export function useExportContacts() {
  return useMutation({
    mutationFn: (q: ListContactsQuery) =>
      api
        .get('contacts/export.xlsx', {
          searchParams: buildExportSearchParams(q),
          timeout: 120_000,
        })
        .blob(),
  });
}
