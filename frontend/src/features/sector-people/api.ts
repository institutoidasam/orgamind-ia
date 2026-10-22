import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  addFromContactsResponseSchema,
  movePeopleResponseSchema,
  sectorContactCandidatesSchema,
  sectorPeopleResponseSchema,
  sectorPersonCandidatesSchema,
  type AddFromContactsInput,
  type CreateSectorPersonInput,
  type UpdateSectorPersonInput,
} from './schemas';

const peopleKey = (sectorId: string) => ['sector-people', sectorId] as const;

export function useSectorPeople(sectorId: string) {
  return useQuery({
    queryKey: peopleKey(sectorId),
    // O gestor não lê `GET /internal/sectors/:id`; cabeçalho e pessoas vêm daqui (D9).
    queryFn: async () =>
      sectorPeopleResponseSchema.parse(await api.get(`internal/sectors/${sectorId}/people`).json()),
    retry: false,
  });
}

/** Depois de editar ou tirar alguém: a lista do setor, a de setores (contagem) e a de usuários. */
function useRefreshAfterWrite(sectorId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: peopleKey(sectorId) }),
      qc.invalidateQueries({ queryKey: ['internal', 'sectors'] }),
      qc.invalidateQueries({ queryKey: ['users'] }),
    ]);
}

export function useUpdateSectorPerson(sectorId: string) {
  const refresh = useRefreshAfterWrite(sectorId);
  return useMutation({
    mutationFn: ({ userId, data }: { userId: string; data: UpdateSectorPersonInput }) =>
      api.patch(`internal/sectors/${sectorId}/people/${userId}`, { json: data }),
    onSuccess: refresh,
  });
}

export function useRemoveSectorPerson(sectorId: string) {
  const refresh = useRefreshAfterWrite(sectorId);
  return useMutation({
    mutationFn: (userId: string) => api.delete(`internal/sectors/${sectorId}/people/${userId}`),
    onSuccess: refresh,
  });
}

const peoplePath = (sectorId: string) => `internal/sectors/${sectorId}/people`;

/** Candidatos a mudar para este setor (o gestor só vê quem está sem setor e sem acesso). */
export function useSectorPersonCandidates(sectorId: string, q: string) {
  return useQuery({
    queryKey: [...peopleKey(sectorId), 'candidates', q],
    queryFn: async () =>
      sectorPersonCandidatesSchema.parse(await api.get(`${peoplePath(sectorId)}/candidates`, { searchParams: { q } }).json()),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Contatos para virar pessoas deste setor; `person` marca quem já é pessoa (desabilitado na tela). */
export function useSectorContactCandidates(sectorId: string, q: string) {
  return useQuery({
    queryKey: [...peopleKey(sectorId), 'contact-candidates', q],
    queryFn: async () =>
      sectorContactCandidatesSchema.parse(await api.get(`${peoplePath(sectorId)}/contact-candidates`, { searchParams: { q } }).json()),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useCreateSectorPerson(sectorId: string) {
  const refresh = useRefreshAfterWrite(sectorId);
  return useMutation({
    mutationFn: (data: CreateSectorPersonInput) => api.post(peoplePath(sectorId), { json: data }),
    onSuccess: refresh,
  });
}

/** 200 mesmo com falhas por item: quem deu certo fica criado e a lista do setor é recarregada. */
export function useAddPeopleFromContacts(sectorId: string) {
  const refresh = useRefreshAfterWrite(sectorId);
  return useMutation({
    mutationFn: async (data: AddFromContactsInput) =>
      addFromContactsResponseSchema.parse(await api.post(`${peoplePath(sectorId)}/from-contacts`, { json: data }).json()),
    onSuccess: refresh,
  });
}

export function useMoveSectorPeople(sectorId: string) {
  const refresh = useRefreshAfterWrite(sectorId);
  return useMutation({
    mutationFn: async (userIds: string[]) =>
      movePeopleResponseSchema.parse(await api.post(`${peoplePath(sectorId)}/move`, { json: { userIds } }).json()),
    onSuccess: refresh,
  });
}
