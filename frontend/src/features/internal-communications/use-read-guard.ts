import { useCallback, useEffect, useRef, useState } from 'react';

type ReadableCommunication = {
  id: string;
  isUnread: boolean;
  updatedAt: string;
};

function withoutFailure(failures: Map<string, unknown>, version: string) {
  if (!failures.has(version)) return failures;
  const next = new Map(failures);
  next.delete(version);
  return next;
}

export function useReadGuard(
  item: ReadableCommunication | undefined,
  markRead: () => Promise<unknown> | void,
) {
  const readVersions = useRef(new Set<string>());
  const pendingVersions = useRef(new Set<string>());
  const failedVersions = useRef(new Set<string>());
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [failures, setFailures] = useState<Map<string, unknown>>(() => new Map());
  const version = item ? `${item.id}:${item.updatedAt}` : null;

  const markVersionRead = useCallback((nextItem: ReadableCommunication, retry = false) => {
    const nextVersion = `${nextItem.id}:${nextItem.updatedAt}`;
    if (!nextItem.isUnread || readVersions.current.has(nextVersion) || pendingVersions.current.has(nextVersion)) return;
    if (!retry && failedVersions.current.has(nextVersion)) return;

    failedVersions.current.delete(nextVersion);
    pendingVersions.current.add(nextVersion);
    setPendingVersion(nextVersion);
    setFailures((current) => withoutFailure(current, nextVersion));

    void Promise.resolve(markRead()).then(
      () => {
        readVersions.current.add(nextVersion);
        setFailures((current) => withoutFailure(current, nextVersion));
      },
      (error: unknown) => {
        failedVersions.current.add(nextVersion);
        setFailures((current) => new Map(current).set(nextVersion, error));
      },
    ).finally(() => {
      pendingVersions.current.delete(nextVersion);
      setPendingVersion((current) => current === nextVersion ? null : current);
    });
  }, [markRead]);

  useEffect(() => {
    if (item) markVersionRead(item);
  }, [item, markVersionRead]);

  const retry = useCallback(() => {
    if (item && version && failedVersions.current.has(version)) markVersionRead(item, true);
  }, [item, markVersionRead, version]);

  return {
    error: version && failures.has(version) ? failures.get(version) : null,
    isPending: version !== null && pendingVersion === version,
    retry,
  };
}
