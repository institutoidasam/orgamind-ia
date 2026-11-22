import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { inactivateSectorText } from "../sector-usage";

type Props = {
  open: boolean;
  name: string;
  /** Setor com número próprio da área (`sector.channel` não nulo): a confirmação avisa. */
  hasAreaNumber: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirma a inativação do setor sem uso (E6); o servidor ainda recusa se o uso surgir depois. */
export function SectorInactivateDialog({
  open,
  name,
  hasAreaNumber,
  pending,
  onConfirm,
  onCancel,
}: Props) {
  const [question, areaNote] = inactivateSectorText(name, hasAreaNumber);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !next && !pending && onCancel()}
    >
      {/* Sem parágrafo do número não há descrição: `aria-describedby` undefined cala o aviso do Radix. */}
      <AlertDialogContent
        {...(areaNote ? {} : { "aria-describedby": undefined })}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-snug">
            {question}
          </AlertDialogTitle>
          {areaNote && (
            <AlertDialogDescription>{areaNote}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <Button onClick={onConfirm} disabled={pending}>
            Inativar setor
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
