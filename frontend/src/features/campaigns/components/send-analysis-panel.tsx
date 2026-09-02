import { AlertTriangle, Ban, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  hasBlockingCheck,
  type SendCheck,
  type CheckSeverity,
} from "../schemas";

type Props = {
  checks: SendCheck[];
  recipients?: number;
  /**
   * ★ Quantos a regra "já está em campanha com este mesmo template" tirou da
   * audiência (spec 2026-08-12).
   *
   * Importa aqui porque os CHECKS não a conhecem: `preflight-checks` resolve o
   * `where` direto do FilterGroup — sem o template e sem o limite — então
   * VOLUME, alcançabilidade e consentimento descrevem uma audiência MAIOR do
   * que a que vai existir. Com este número o painel diz sobre quantos contatos
   * os alertas foram calculados, em vez de deixar o operador ler "vai enviar
   * para 500" logo acima de um disparo de 88.
   */
  excludedSameTemplate?: number;
  /**
   * ★ Quantos contatos a ANÁLISE mediu — o `recipients` que o próprio
   * `preflight-checks` devolveu, contando o FilterGroup cru.
   *
   * É o único número honesto para esta frase. `recipients + excludedSameTemplate`
   * NÃO serve: o backend aplica o limite "os N primeiros" ANTES da exclusão por
   * template (campaigns.service.ts, applyAudienceLimit → sameTemplateExclusion),
   * então essa soma é o tamanho da lista JÁ RECORTADA pelo limite. Com filtro de
   * 13000, limite 500 e 412 excluídos, ela diria "calculados sobre 500" quando
   * foram calculados sobre 13000 — um número inventado, com cara de precisão,
   * exatamente no lugar criado para acabar com números inventados.
   */
  analyzedCount?: number | null;
  /**
   * Pedido do cliente (2026-08-25) — quando o operador liga "Excluir quem já
   * recebeu qualquer campanha anterior" (passo 3), a frase abaixo de
   * `excludedSameTemplate` deixa de ser verdade: os excluídos não são só de
   * "este mesmo template" — são de QUALQUER campanha anterior. `false`
   * (default) preserva a frase de sempre.
   */
  excludeAnyPreviousCampaign?: boolean;
  /** Whether the operator accepted the risk of any blocking check. */
  override: boolean;
  onOverrideChange: (v: boolean) => void;
};

const SEVERITY_META: Record<
  CheckSeverity,
  { label: string; icon: React.ReactNode; badge: string; row: string }
> = {
  info: {
    label: "Info",
    icon: <Info className="h-4 w-4" />,
    badge: "bg-sky-100 text-sky-800 border-sky-200",
    row: "border-sky-200 bg-sky-50/50",
  },
  warn: {
    label: "Atenção",
    icon: <AlertTriangle className="h-4 w-4" />,
    badge: "bg-amber-100 text-amber-900 border-amber-200",
    row: "border-amber-200 bg-amber-50/60",
  },
  block: {
    label: "Bloqueio",
    icon: <Ban className="h-4 w-4" />,
    badge: "bg-red-100 text-red-800 border-red-200",
    row: "border-red-300 bg-red-50/70",
  },
};

/**
 * Renders the send-check (anti-ban) analysis with severity badges. When any
 * `block` check is present, an "entendo o risco" override checkbox must be
 * ticked before the confirm button (owned by the parent) can enable.
 */
export function SendAnalysisPanel({
  checks,
  recipients,
  excludedSameTemplate = 0,
  analyzedCount,
  excludeAnyPreviousCampaign = false,
  override,
  onOverrideChange,
}: Props) {
  const blocking = hasBlockingCheck(checks);

  // A análise mediu MAIS gente do que o disparo vai atingir? Pode ser o limite,
  // pode ser a exclusão por template, podem ser os dois — o aviso não depende de
  // saber qual: depende só de os dois números não baterem.
  const analysisOverAudience =
    recipients != null && analyzedCount != null && analyzedCount > recipients;

  // Order: blocks first, then warns, then infos — most urgent at top.
  const order: Record<CheckSeverity, number> = { block: 0, warn: 1, info: 2 };
  const sorted = [...checks].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );

  return (
    <div className="space-y-3" data-testid="send-analysis">
      {recipients != null && (
        <div className="text-sm">
          <span className="font-medium">{recipients}</span> destinatário(s)
          {excludedSameTemplate > 0
            ? excludeAnyPreviousCampaign
              ? ` — sem os ${excludedSameTemplate} que já receberam alguma campanha anterior.`
              : ` — sem os ${excludedSameTemplate} que já estão em campanha com este mesmo template.`
            : '.'}
        </div>
      )}

      {/* ★ Os alertas abaixo NÃO conhecem o recorte da audiência: o backend os
          calcula sobre o filtro cru, sem o limite "os N primeiros" e sem a
          exclusão por template. Dizer sobre quantos contatos eles foram
          medidos — com o número que o próprio preflight devolveu — é o que
          impede a tela de prometer um número e o disparo fazer outro. */}
      {analysisOverAudience && (
        <p
          data-testid="analysis-audience-caveat"
          className="text-xs text-muted-foreground"
        >
          Os alertas abaixo (volume, alcançabilidade e consentimento) foram
          medidos sobre os <span className="font-medium">{analyzedCount}</span>{' '}
          contatos que o filtro encontrou, antes de cortar a lista. Esta
          campanha vai para <span className="font-medium">{recipients}</span> —
          leia os alertas como teto, não como o número do disparo.
        </p>
      )}

      {/* Sem alertas o painel continua existindo — a contagem de destinatários
          (e o aviso da exclusão) é informação, não alerta, e sumia junto com a
          lista vazia. O texto muda conforme a análise já rodou: mandar
          "preencha o segmento e a conexão" ao lado de uma contagem de
          destinatários é pedir o que já foi feito, e ensina o operador a
          ignorar o painel que carrega o aviso e o "Entendo o risco". */}
      {checks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {recipients != null
            ? 'Nenhum alerta nesta configuração.'
            : 'Nenhum alerta — preencha o segmento e a conexão para ver a análise.'}
        </p>
      )}

      <ul className="space-y-2">
        {sorted.map((c) => {
          const meta = SEVERITY_META[c.severity];
          return (
            <li
              key={c.code}
              className={`flex items-start gap-2.5 rounded-md border p-2.5 text-sm ${meta.row}`}
            >
              <span className="mt-0.5">{meta.icon}</span>
              <div className="flex-1 space-y-1">
                <Badge
                  variant="outline"
                  className={`text-[10px] font-semibold uppercase ${meta.badge}`}
                >
                  {meta.label}
                </Badge>
                <p className="leading-snug">{c.message}</p>
              </div>
            </li>
          );
        })}
      </ul>

      {blocking && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3">
          <Checkbox
            id="send-analysis-override"
            checked={override}
            onCheckedChange={(v) => onOverrideChange(v === true)}
          />
          <Label
            htmlFor="send-analysis-override"
            className="cursor-pointer text-sm font-normal leading-snug"
          >
            Entendo o risco e quero prosseguir mesmo com os bloqueios acima.
          </Label>
        </div>
      )}
    </div>
  );
}
