import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Skeleton } from '@/components/ui/skeleton';
import {
  COORTE_ACAO,
  COORTE_LABEL,
  FONTE_LABEL,
  coorteKeys,
  useClassifyBase,
  useConsentOverview,
  type CoorteKey,
} from '@/features/consent/overview';
import { PurposesAdmin } from '@/features/consent/components/purposes-admin';
import { BulkGrantSection } from '@/features/consent/components/bulk-grant-dialog';
import { useAuthStore } from '@/stores/auth.store';

/**
 * `/consentimento`, e não `/opt-in` como a spec §7 sugere: `/opt-in` já é a
 * LANDING PÚBLICA do §3.2 (`src/routes/opt-in.tsx`, sem login), e o
 * `_authenticated` é um layout SEM path — as duas rotas resolveriam para a mesma
 * URL. A landing é a que está impressa em cartaz e QR: quem se move é o painel.
 */
export const Route = createFileRoute('/_authenticated/consentimento')({
  component: OptInPage,
});

const nf = new Intl.NumberFormat('pt-BR');
const num = (n: number) => nf.format(n);
const pct = (n: number) => `${nf.format(Math.round(n * 10) / 10)}%`;

/**
 * C5 — Painel de opt-in (spec §7).
 *
 * A tela existe para trocar a métrica de sucesso do orgamind. "Mensagens enviadas"
 * é um número que sobe até o número ser banido; o número que importa é **quantos
 * podem receber campanha hoje** — com consentimento por finalidade e sem
 * supressão. Ele fica no topo, sozinho, e normalmente vai doer.
 *
 * Os outros dois blocos respondem as perguntas que sobram: qual canal de coleta
 * funciona (fonte + funil por token) e quanto da base é inutilizável (coortes de
 * procedência). A expectativa realista da spec (§6.3), pela analogia com o
 * re-permissionamento de e-mail no GDPR: dos 13k, sobram ~1.500–4.000.
 */
function OptInPage() {
  const overview = useConsentOverview();
  const classify = useClassifyBase();
  // Escrever o texto de consentimento é escrever a PROVA, e registrar
  // consentimento da base existente é declarar, com o próprio nome, que aqueles
  // titulares concordaram. As duas coisas são ADMIN — no backend também.
  const isAdmin = useAuthStore((s) => s.user?.role) === 'ADMIN';

  if (overview.isError) {
    return <QueryErrorFallback error={overview.error} onRetry={() => overview.refetch()} />;
  }

  const data = overview.data;

  async function auditar() {
    try {
      const report = await classify.mutateAsync();
      toast.success(
        `Auditoria concluída: ${num(report.scanned)} contatos, ${num(report.updated)} reclassificados. Nenhuma mensagem enviada.`,
      );
    } catch {
      toast.error('Falha ao rodar a auditoria da base');
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Opt-in</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          A métrica que importa não é quantas mensagens saíram — é quantas pessoas
          <strong> autorizaram </strong> receber, e para qual finalidade.
        </p>
      </header>

      {overview.isLoading || !data ? (
        <>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </>
      ) : (
        <>
          {/* ── O número que autoriza apertar um botão ───────────────────── */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="pt-6" data-testid="podem-receber-hoje">
                <p
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  Podem receber campanha hoje
                </p>
                <p className="mt-2 text-4xl font-semibold tabular-nums">
                  {num(data.podemReceberHoje)}
                  <span
                    className="text-xl font-normal"
                    style={{ color: 'var(--foreground-muted)' }}
                  >
                    {' '}
                    de {num(data.total)}
                  </span>
                </p>
                <p className="mt-2 text-sm" style={{ color: 'var(--foreground-muted)' }}>
                  Com consentimento ativo para alguma finalidade e sem opt-out. É o único
                  número que autoriza um disparo — o resto da base não pode receber
                  campanha, e enviar assim mata o canal antes de qualquer discussão
                  jurídica.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6" data-testid="inutilizaveis">
                <p
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--foreground-muted)' }}
                >
                  Base inutilizável
                </p>
                <p className="mt-2 text-4xl font-semibold tabular-nums">
                  {num(data.inutilizaveis)}
                </p>
                <p className="mt-2 text-sm" style={{ color: 'var(--foreground-muted)' }}>
                  Contatos <strong>sem consentimento e sem procedência</strong> comprovável.
                  Não dá para escrever com verdade &ldquo;você nos deixou este contato
                  quando participou de X&rdquo; — então eles não deveriam receber nada.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Stat
              testId="sem-consentimento"
              label="Sem nenhum consentimento"
              value={num(data.semConsentimento)}
              hint="O denominador do problema."
            />
            <Stat
              testId="suprimidos"
              label="Suprimidos (opt-out)"
              value={num(data.suprimidos)}
              hint={`${num(data.suprimidosNaSemana)} novos nos últimos 7 dias. Revogação é absoluta: nem override de admin fura.`}
            />
            <Stat
              testId="sem-checagem"
              label="Sem checagem de WhatsApp"
              value={num(data.semChecagemWhatsapp)}
              hint="Rode o check de validade antes de qualquer disparo: número morto queima cota do tier."
            />
          </div>

          {/* ── Estado do consentimento ──────────────────────────────────── */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Consentimento por finalidade</CardTitle>
              </CardHeader>
              <CardContent data-testid="por-finalidade" className="space-y-3">
                {data.porFinalidade.length === 0 ? (
                  <Empty>Nenhuma finalidade cadastrada.</Empty>
                ) : (
                  data.porFinalidade.map((p) => (
                    <div key={p.purposeKey} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span>{p.label}</span>
                        <span className="tabular-nums font-medium">
                          {num(p.granted)}{' '}
                          <span style={{ color: 'var(--foreground-muted)' }}>
                            ({pct(p.pctBase)})
                          </span>
                        </span>
                      </div>
                      <Bar value={p.pctBase} />
                    </div>
                  ))
                )}
                <p className="pt-1 text-xs" style={{ color: 'var(--foreground-muted)' }}>
                  Consentir para uma finalidade não autoriza as outras — autorização
                  genérica é nula.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>De onde vem o consentimento</CardTitle>
              </CardHeader>
              <CardContent data-testid="por-fonte" className="space-y-3">
                {data.porFonte.length === 0 ? (
                  <Empty>
                    Nenhum consentimento coletado ainda. Comece pelos links/QR e pela
                    landing pública — são os canais de risco zero.
                  </Empty>
                ) : (
                  data.porFonte.map((f) => (
                    <div
                      key={f.source}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span>{FONTE_LABEL[f.source] ?? f.source}</span>
                      <span className="tabular-nums font-medium">{num(f.granted)}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Funil por token de origem ────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Funil por ponto de coleta</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.funil.length === 0 ? (
                <Empty>Nenhum link/QR gerado ainda.</Empty>
              ) : (
                <>
                  <div
                    className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b pb-2 text-xs uppercase tracking-wide"
                    style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
                  >
                    <span>Origem</span>
                    <span className="text-right">Chegaram</span>
                    <span className="text-right">Consentiram</span>
                    <span className="text-right">Conversão</span>
                  </div>
                  {data.funil.map((f) => (
                    <div
                      key={f.token}
                      data-testid={`funil-${f.token}`}
                      className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-4 text-sm"
                    >
                      <span>
                        <span className="font-mono">{f.token}</span>
                        {f.description ? (
                          <span
                            className="ml-2 text-xs"
                            style={{ color: 'var(--foreground-muted)' }}
                          >
                            {f.description}
                          </span>
                        ) : null}
                        {!f.active ? (
                          <span
                            className="ml-2 text-xs"
                            style={{ color: 'var(--foreground-muted)' }}
                          >
                            (inativo)
                          </span>
                        ) : null}
                      </span>
                      <span className="text-right tabular-nums">{num(f.inbounds)}</span>
                      <span className="text-right tabular-nums font-medium">
                        {num(f.grants)}
                      </span>
                      <span className="text-right tabular-nums">{pct(f.conversao)}</span>
                    </div>
                  ))}
                  <p className="pt-1 text-xs" style={{ color: 'var(--foreground-muted)' }}>
                    Muitas chegadas e poucos consentimentos = o texto já escrito na mensagem
                    está sendo apagado antes do envio. É problema de copy, não de canal: sem
                    o texto, o inbound abre janela de atendimento e não consente.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* ── Auditoria das coortes ────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <CardTitle>Procedência da base</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={auditar}
                disabled={classify.isPending}
              >
                {classify.isPending ? 'Auditando…' : 'Rodar auditoria'}
              </Button>
            </CardHeader>
            <CardContent data-testid="coortes" className="space-y-3">
              {data.auditadoEm === null ? (
                <p
                  className="rounded-lg border border-dashed p-4 text-sm"
                  style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
                >
                  A base nunca foi auditada — nenhum contato está classificado. Enquanto isso
                  não rodar, procedência nenhuma está comprovada e a base inteira conta como
                  inutilizável.
                </p>
              ) : (
                <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                  Última auditoria em{' '}
                  {data.auditadoEm.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.
                  A auditoria não envia mensagem nem grava consentimento.
                </p>
              )}

              {coorteKeys.map((key: CoorteKey) => {
                const n = data.coortes[key] ?? 0;
                const share = data.total === 0 ? 0 : (n / data.total) * 100;
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span>{COORTE_LABEL[key]}</span>
                      <span className="tabular-nums font-medium">
                        {num(n)}{' '}
                        <span style={{ color: 'var(--foreground-muted)' }}>
                          ({pct(share)})
                        </span>
                      </span>
                    </div>
                    <Bar value={share} />
                    <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>
                      {COORTE_ACAO[key]}
                    </p>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {isAdmin && (
            <>
              <PurposesAdmin />
              <BulkGrantSection />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6" data-testid={testId}>
        <p
          className="text-xs uppercase tracking-wide"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--foreground-muted)' }}>
          {hint}
        </p>
      </CardContent>
    </Card>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ backgroundColor: 'var(--border)' }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(value, value > 0 ? 1 : 0))}%`,
          backgroundColor: 'var(--primary)',
        }}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
      {children}
    </p>
  );
}
