import { ALERT_ACK_DEADLINE_MINUTES, ALERT_CONFIRM_LINE } from "../alert-text";

/** A linha que o servidor acrescenta ao fim de todo alerta urgente: aparece sob a caixa de texto, sem edição (I2). */
export function AlertConfirmLine() {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Acrescentada ao fim do alerta, sem edição:
      </p>
      <p className="rounded-md border bg-muted px-3 py-2 text-sm">
        {ALERT_CONFIRM_LINE}
      </p>
    </div>
  );
}

/** Prazo de ciência na revisão da Urgência (I3): o relógio só começa quando o envio é confirmado. */
export function AlertDeadlineNote() {
  return (
    <p className="text-sm">{`Prazo de ciência: ${ALERT_ACK_DEADLINE_MINUTES} min, contado da confirmação do envio`}</p>
  );
}
