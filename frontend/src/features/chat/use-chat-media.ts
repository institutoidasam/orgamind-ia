import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';

/**
 * Fetches protected media as a blob (Bearer via ky) and exposes an object URL.
 *
 * The query caches the *blob* (staleTime Infinity, gcTime 5m) so revisiting a
 * conversation never re-downloads it. The object URL, however, is owned by the
 * component instance: each mount derives a fresh URL from the cached blob and
 * revokes only that URL on unmount. This decouples revocation from React's
 * unmount of a *shared* cached URL — the bug where switching conversations
 * (bubbles keyed by id remount) revoked a URL still cached and served to a
 * later mount, leaving <img>/<video>/<audio>/<a download> pointing at a dead
 * blob.
 */
export function useChatMedia(mediaId: string | null, enabled: boolean) {
  const q = useQuery({
    queryKey: ['chat', 'media', mediaId] as const,
    enabled: enabled && !!mediaId,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async () => api.get(`chat/media/${mediaId}`).blob(),
  });

  const blob = q.data;
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => { URL.revokeObjectURL(objectUrl); };
  }, [blob]);

  return { ...q, data: url };
}
