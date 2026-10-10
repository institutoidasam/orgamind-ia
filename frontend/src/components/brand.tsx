import { cn } from '@/lib/utils';
import { PRODUCT_NAME, WORKSPACE_NAME } from '@/lib/brand';

type BrandProps = {
  compact?: boolean;
  subtitle?: string;
  inverse?: boolean;
  className?: string;
};

export function Brand({
  compact = false,
  subtitle = WORKSPACE_NAME,
  inverse = false,
  className,
}: BrandProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span
        aria-hidden={compact ? undefined : true}
        className="grid size-[33px] shrink-0 place-items-center rounded-[8px] bg-[var(--brand-orange)] text-[19px] font-extrabold leading-none text-white"
      >
        {compact ? (
          <>
            <span aria-hidden="true">O</span>
            <span className="sr-only">{PRODUCT_NAME}</span>
          </>
        ) : 'O'}
      </span>
      {!compact && (
        <span className="min-w-0 leading-tight">
          <span
            className={cn(
              'block text-[18px] font-bold tracking-[-0.04em]',
              inverse ? 'text-white' : 'text-[var(--brand-navy)]',
            )}
          >
            {PRODUCT_NAME}
          </span>
          {subtitle && (
            <span
              className={cn(
                'block truncate text-[10px] font-medium uppercase tracking-[0.08em]',
                inverse ? 'text-[#adbdd1]' : 'text-[var(--foreground-muted)]',
              )}
            >
              {subtitle}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
