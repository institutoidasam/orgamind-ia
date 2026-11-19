import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { auditTrailPageSchema, personAssignmentsSchema, type AuditCategory } from './schemas';

export type AuditTrailQuery = {
  q?: string;
  from?: string;
  to?: string;
  category?: AuditCategory;
  page: number;
  pageSize: number;
};

/** Itens por página do histórico de uma pessoa (diálogo). */
export const PERSON_HISTORY_PAGE_SIZE = 20;

/** Só vai para a URL o que foi preenchido. */
function filled(query: Record<string, string | number | undefined>) {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
}

/** Consulta geral da trilha (`GET /audit-trail`), mais recentes primeiro. */
export function useAuditTrail(query: AuditTrailQuery) {
  return useQuery({
    queryKey: ['audit-trail', 'list', query],
    queryFn: () =>
      api
        .get('audit-trail', { searchParams: filled(query) })
        .json()
        .then((data) => auditTrailPageSchema.parse(data)),
    placeholderData: keepPreviousData,
  });
}

/** Histórico de uma pessoa (`GET /audit-trail/people/:userId`), mais recentes primeiro. */
export function usePersonHistory(userId: string, page: number) {
  return useQuery({
    queryKey: ['audit-trail', 'people', userId, page],
    queryFn: () =>
      api
        .get(`audit-trail/people/${userId}`, { searchParams: { page, pageSize: PERSON_HISTORY_PAGE_SIZE } })
        .json()
        .then((data) => auditTrailPageSchema.parse(data)),
  });
}

/** Vínculos de uma pessoa (`GET /audit-trail/people/:userId/assignments`), linha aberta primeiro, depois por `to` decrescente. */
export function usePersonAssignments(userId: string) {
  return useQuery({
    queryKey: ['audit-trail', 'people', userId, 'assignments'],
    queryFn: () =>
      api
        .get(`audit-trail/people/${userId}/assignments`)
        .json()
        .then((data) => personAssignmentsSchema.parse(data)),
  });
}
