import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NO_SHIFT_LABEL } from '@/features/shifts/labels';
import { useRemoveSectorPerson } from '../api';
import { toastSectorPeopleError } from '../error-messages';
import type { SectorPerson } from '../schemas';

type Props = {
  sectorId: string;
  people: SectorPerson[];
  onEdit: (person: SectorPerson) => void;
};

function useRemovePerson(sectorId: string) {
  const remove = useRemoveSectorPerson(sectorId);
  return async (person: SectorPerson) => {
    try {
      await remove.mutateAsync(person.id);
      toast.success(`${person.name} saiu do setor.`);
    } catch (error) {
      await toastSectorPeopleError(error);
    }
  };
}

export function PeopleTable({ sectorId, people, onEdit }: Props) {
  const removePerson = useRemovePerson(sectorId);
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Nível</TableHead>
            <TableHead>Função</TableHead>
            <TableHead>Turno</TableHead>
            <TableHead>Acesso ao sistema</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((person) => (
            <TableRow key={person.id}>
              <TableCell className="font-medium">{person.name}</TableCell>
              <TableCell>{person.level?.name ?? 'Sem nível'}</TableCell>
              <TableCell>{person.jobTitle ?? '—'}</TableCell>
              <TableCell>{person.shift?.name ?? NO_SHIFT_LABEL}</TableCell>
              <TableCell>
                <Badge variant={person.hasAccess ? 'secondary' : 'outline'}>
                  {person.hasAccess ? 'Com acesso' : 'Sem acesso'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onEdit(person)}>Editar</Button>
                  {!person.hasAccess && (
                    <Button size="sm" variant="ghost" onClick={() => removePerson(person)}>Tirar do setor</Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
