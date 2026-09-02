import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Users2 } from 'lucide-react';
import { usePreviewCampaign, usePreflightByFilters } from '../api';
import type { FilterGroup, PreviewResult, PreflightResult } from '../schemas';
import { SameTemplateExclusionNotice } from './same-template-exclusion-notice';
import { AudienceExclusionsLine } from './audience-exclusions-line';

type Props = {
  filters: FilterGroup;
  /**
   * "Os N primeiros contatos" (null = todos). Entra na PRÉVIA, e não só no
   * create, porque a prévia tem de contar e amostrar exatamente quem vai
   * receber — senão a tela diria 13.400 e o disparo mandaria para 200.
   */
  limit?: number | null;
  /**
   * ★ O template escolhido no passo 1. Vai para o backend porque a prévia tem
   * de aplicar a MESMA exclusão que o disparo vai aplicar (spec 2026-08-12):
   * quem já está em outra campanha deste template não entra. Sem ele a tela
   * prometeria 500 e sairiam 88 — o contrato que a Fase 0 consertou.
   */
  templateId?: string | null;
  /**
   * Pedido do cliente (2026-08-25) — espelha o toggle do passo 3 ("Excluir
   * quem já recebeu qualquer campanha anterior"). A prévia tem de contar com
   * a MESMA régua que o disparo vai aplicar (`Campaign.excludeAnyPreviousCampaign`)
   * — senão a tela promete um número e o disparo materializa outro.
   */
  excludeAnyPreviousCampaign?: boolean;
  onPreviewResult?: (r: PreviewResult) => void;
};

export function LivePreview({
  filters,
  limit = null,
  templateId = null,
  excludeAnyPreviousCampaign = false,
  onPreviewResult,
}: Props) {
  const preview = usePreviewCampaign();
  const preflight = usePreflightByFilters();
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [hasError, setHasError] = useState(false);

  // Use a serialized key so the effect only fires when content (not reference) changes.
  // This avoids cycles with parent state where new filter objects are created on every
  // render with identical content.
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const parsed = JSON.parse(filtersKey) as FilterGroup;
        const [r, pf] = await Promise.all([
          // A prévia leva o limite: o número e a amostra têm de ser os do RECORTE.
          preview.mutateAsync({
            filters: parsed,
            limit,
            templateId,
            excludeAnyPreviousCampaign,
          }),
          // O preflight (alcançabilidade) segue sobre o filtro inteiro — ele
          // responde "quantos desses números são válidos", não "quantos vão receber".
          preflight.mutateAsync(parsed),
        ]);
        if (cancelled) return;
        setResult(r);
        setPreflightResult(pf);
        setHasError(false);
        onPreviewResult?.(r);
      } catch {
        // An invalid/empty filter combination 400s the preview endpoint. Surface
        // it inline (like SegmentPreviewPanel) instead of silently showing a
        // stale/empty count.
        if (cancelled) return;
        setHasError(true);
        setResult(null);
        setPreflightResult(null);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // preview, preflight & onPreviewResult are stable enough across renders for our use case
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, limit, templateId, excludeAnyPreviousCampaign]);

  const isEmpty = result?.count === 0;
  // Só aparece quando de fato excluiu alguém: um "0 excluídos" permanente vira
  // ruído e treina o operador a ignorar o aviso justo quando ele importa.
  const excluidos = result?.excludedSameTemplate ?? 0;
  // B.4 — opcional na resposta (rollout do backend em paralelo, Task 15):
  // tolera undefined como 0.
  const invalidosExcluidos = result?.excludedInvalid ?? 0;

  // Derived preflight indicators
  const pf = preflightResult;
  const manyUnreachable =
    pf && pf.total > 0 && (pf.invalid + pf.unknown) / pf.total > 0.3;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border bg-gradient-to-br from-primary/5 to-transparent p-4">
        {preview.isPending ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Calculando…</p>
              <p className="text-xs text-muted-foreground">
                Aplicando filtros aos contatos
              </p>
            </div>
          </>
        ) : hasError ? (
          <>
            <AlertTriangle
              className="h-6 w-6 shrink-0"
              style={{ color: 'var(--st-failed-fg)' }}
            />
            <div>
              <p className="text-sm font-medium text-destructive">
                Não foi possível calcular o preview
              </p>
              <p className="text-xs text-muted-foreground">
                Verifique se os filtros estão completos e válidos.
              </p>
            </div>
          </>
        ) : isEmpty ? (
          <>
            <Users2
              className="h-6 w-6"
              style={{ color: 'var(--st-cancelled-fg)' }}
            />
            <div>
              <p className="text-sm font-medium">Nenhum contato corresponde</p>
              <p className="text-xs text-muted-foreground">
                Ajuste os filtros à esquerda para incluir destinatários
              </p>
            </div>
          </>
        ) : (
          <>
            <CheckCircle2
              className="h-6 w-6"
              style={{ color: 'var(--st-read-fg)' }}
            />
            <div>
              <p className="text-2xl font-bold leading-none">
                {result?.count ?? '—'}{' '}
                <span className="text-base font-normal text-muted-foreground">
                  contato{result?.count === 1 ? '' : 's'} selecionado{result?.count === 1 ? '' : 's'}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Vão receber a mensagem quando você disparar
              </p>
            </div>
          </>
        )}
      </div>

      {/* A.2 — a contabilidade da audiência numa linha, na ordem em que as
          exclusões se aplicam. O aviso longo abaixo continua existindo: ele
          explica o CASO (campanha cancelada com linhas presas em SENT), esta
          linha só faz a conta fechar. A Fase B acrescenta aqui o item dos
          inválidos confirmados. */}
      <AudienceExclusionsLine
        total={(result?.count ?? 0) + excluidos + invalidosExcluidos}
        items={[
          // B.4 — antes do item de mesmo template: é a ordem em que as
          // exclusões se aplicam (spec A.2).
          {
            label: 'inválidos confirmados excluídos',
            count: invalidosExcluidos,
          },
          {
            label: 'já estão em campanha com este mesmo template (excluídos)',
            count: excluidos,
          },
        ]}
      />

      {/* ★ Por que a audiência encolheu (spec 2026-08-12). O texto vive em
          `SameTemplateExclusionNotice` porque a MESMA frase tem de aparecer na
          confirmação do passo 4 — a tela onde o operador aperta o botão. */}
      <SameTemplateExclusionNotice count={excluidos} />

      {/* WhatsApp reachability pre-flight summary */}
      {pf && pf.total > 0 && (
        <div
          className="rounded-lg border px-3 py-2 text-sm"
          style={
            manyUnreachable
              ? {
                  background: 'var(--st-failed-bg)',
                  borderColor: 'var(--st-failed-border)',
                }
              : {
                  background: 'var(--st-read-bg)',
                  borderColor: 'var(--st-read-border)',
                }
          }
        >
          <div className="flex items-center gap-2">
            {manyUnreachable ? (
              <AlertTriangle
                className="h-4 w-4 shrink-0"
                style={{ color: 'var(--st-failed-fg)' }}
              />
            ) : (
              <CheckCircle2
                className="h-4 w-4 shrink-0"
                style={{ color: 'var(--st-read-fg)' }}
              />
            )}
            <span className="font-medium">
              {pf.reachable} de {pf.total} alcançáveis no WhatsApp
            </span>
          </div>
          <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
            <span>
              <span className="font-medium" style={{ color: 'var(--st-read-fg)' }}>
                {pf.reachable}
              </span>{' '}
              confirmados
            </span>
            {pf.unknown > 0 && (
              <span>
                <span className="font-medium">{pf.unknown}</span> não verificados
              </span>
            )}
            {pf.invalid > 0 && (
              <span>
                <span
                  className="font-medium"
                  style={{ color: 'var(--st-failed-fg)' }}
                >
                  {pf.invalid}
                </span>{' '}
                inválidos
              </span>
            )}
          </div>
          {manyUnreachable && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--st-failed-fg)' }}>
              Mais de 30% dos contatos não estão confirmados no WhatsApp — verifique sua lista antes de disparar.
            </p>
          )}
        </div>
      )}

      {result && result.sample.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            Amostra ({Math.min(result.sample.length, 10)} de {result.count})
          </div>
          <ul className="divide-y text-sm">
            {result.sample.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 px-3 py-1.5"
              >
                <span className="truncate font-medium">{c.name ?? '—'}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {c.phoneE164}
                </span>
              </li>
            ))}
          </ul>
          {result.count > result.sample.length && (
            <div className="border-t px-3 py-1.5 text-center text-xs text-muted-foreground">
              + {result.count - result.sample.length} outro
              {result.count - result.sample.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
