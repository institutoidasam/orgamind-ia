// frontend/src/components/query-error-fallback.tsx
import { useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { extractApiError, type ApiError } from '@/lib/api-error';

type Props = {
  error: unknown;
  onRetry?: () => void;
  className?: string;
};

/**
 * Standardized error state for any `useQuery` result. Resolves ProblemDetails
 * out of HTTPError responses; falls back to a generic message for non-HTTP
 * errors. The retry button is omitted when no `onRetry` is supplied.
 */
export function QueryErrorFallback({ error, onRetry, className }: Props) {
  const [parsed, setParsed] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    extractApiError(error).then((p) => {
      if (!cancelled) setParsed(p);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  if (!parsed) return null;

  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle />
      <AlertTitle>{parsed.title}</AlertTitle>
      <AlertDescription>
        <p>{parsed.message}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={onRetry}
          >
            <RotateCw className="size-3.5" />
            Tentar novamente
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
