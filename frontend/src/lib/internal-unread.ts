import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

const unreadCountSchema = z.object({ count: z.number().int().nonnegative() });

const INTERNAL_READER_ROLES = new Set(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER']);

export type InternalUnreadScope = {
  role?: string;
  userKey?: string;
};

export function canReadInternalUnread(scope?: InternalUnreadScope) {
  return Boolean(scope?.userKey && scope.role && INTERNAL_READER_ROLES.has(scope.role));
}

export function useInternalUnreadCount(scope?: InternalUnreadScope) {
  const enabled = canReadInternalUnread(scope);
  return useQuery({
    queryKey: ['internal-communications', 'unread-count', scope?.role ?? null, scope?.userKey ?? null],
    enabled,
    queryFn: () => api.get('internal/unread-count').json().then((data) => unreadCountSchema.parse(data)),
  });
}
