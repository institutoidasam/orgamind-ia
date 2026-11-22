import type { ReactNode } from "react";
import { formatDatePtBr } from "@/lib/format-date-ptbr";
import { activityText } from "../activity-text";
import { BASE_LABEL, basePhrase, policyLabel, PURPOSE_LABEL } from "../labels";
import type { TeamAudienceRuleView } from "../schemas";

type Named = { name: string }[];

const names = (items: Named): string => items.map((i) => i.name).join(", ");

function levelsText(rule: TeamAudienceRuleView): string {
  const parts = [
    ...rule.levels.map((l) => l.name),
    ...(rule.withoutLevel ? ["Sem nível"] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : "Todos os níveis";
}

function whenText(rule: TeamAudienceRuleView): string {
  if (rule.when === "now") return "Agora";
  return rule.scheduledFor
    ? `No início do turno (${new Date(rule.scheduledFor).toLocaleString("pt-BR")})`
    : "No início do turno";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

type Props = {
  rule: TeamAudienceRuleView;
  includedCount: number;
  excludedCount: number;
};

/**
 * Painel da regra (C4): a regra do público como o servidor a aplicou. Serve à prévia, ao diálogo de envio
 * e ao detalhe do envio. `includedCount`/`excludedCount` vêm de quem o monta (prévia ou envio gravado).
 */
export function RulePanel({ rule, includedCount, excludedCount }: Props) {
  const activity = activityText(rule.activity);
  return (
    <section
      aria-label="Regra do público"
      className="space-y-2 rounded-md border p-3 text-sm"
      style={{ borderColor: "var(--border)" }}
    >
      <dl className="space-y-1">
        <Row label="Finalidade">{PURPOSE_LABEL[rule.purpose]}</Row>
        <Row label="Base">
          {BASE_LABEL[rule.base]}
          <p className="text-muted-foreground">
            {basePhrase(rule.base, rule.includeOff, rule.rosterDate)}
          </p>
        </Row>
        <Row label="Setores">{names(rule.sectors)}</Row>
        <Row label="Turnos">
          {rule.shifts ? names(rule.shifts) : "Todos os turnos"}
        </Row>
        <Row label="Níveis">{levelsText(rule)}</Row>
        <Row label="Folga">{rule.includeOff ? "Incluída" : "Não incluída"}</Row>
        <Row label="Data de referência">{formatDatePtBr(rule.rosterDate)}</Row>
        {activity && <Row label="Atividade">{activity}</Row>}
        {rule.urgencyReason && (
          <Row label="Motivo da urgência">{rule.urgencyReason}</Row>
        )}
        {rule.selectedCount !== null && (
          <Row label="Pessoas marcadas">{rule.selectedCount}</Row>
        )}
        <Row label="Momento do disparo">{whenText(rule)}</Row>
        <Row label="Política do agendamento">
          {policyLabel(rule.when, rule.schedulePolicy)}
        </Row>
      </dl>
      <p className="font-medium">{`No público (${includedCount}) · De fora (${excludedCount})`}</p>
    </section>
  );
}
