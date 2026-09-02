import { Trash2, Users2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SegmentSummary } from "../schemas";
import { SegmentInfoBlock } from "./segment-info-block";

type Props = {
  segments: SegmentSummary[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export function SegmentList({ segments, onSelect, onDelete }: Props) {
  if (segments.length === 0) {
    return (
      <div className="space-y-4">
        <SegmentInfoBlock />
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <Users2 className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Nenhum segmento ainda</p>
          <p className="text-xs text-muted-foreground">
            Clique em "Novo segmento" acima para criar seu primeiro público.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SegmentInfoBlock />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Descrição</TableHead>
            <TableHead className="w-[140px]">Tamanho</TableHead>
            <TableHead>Criado em</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {segments.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => onSelect(s.id)}
                >
                  {s.name}
                </button>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {s.description ?? "—"}
              </TableCell>
              <TableCell>
                {s.lastCount != null ? (
                  <span className="font-medium">{s.lastCount}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    não calculado
                  </span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {new Date(s.createdAt).toLocaleString("pt-BR")}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remover ${s.name}`}
                  onClick={() => onDelete(s.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
