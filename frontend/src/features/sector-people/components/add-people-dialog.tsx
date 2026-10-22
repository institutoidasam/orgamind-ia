import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SectorPeopleOptions } from '../schemas';
import { ContactsTab } from './contacts-tab';
import { ExistingPersonTab } from './existing-person-tab';
import { NewPersonTab } from './new-person-tab';

type Props = {
  sectorId: string;
  options: SectorPeopleOptions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** ADMIN e gestor veem as mesmas três abas; o servidor decide o alcance de cada busca. */
export function AddPeopleDialog({ sectorId, options, open, onOpenChange }: Props) {
  const done = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Adicionar pessoas</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="new">
          <TabsList>
            <TabsTrigger value="new">Nova pessoa</TabsTrigger>
            <TabsTrigger value="contacts">Dos contatos</TabsTrigger>
            <TabsTrigger value="existing">Já cadastrada</TabsTrigger>
          </TabsList>
          <TabsContent value="new">
            <NewPersonTab sectorId={sectorId} options={options} onDone={done} />
          </TabsContent>
          <TabsContent value="contacts">
            <ContactsTab sectorId={sectorId} options={options} onDone={done} />
          </TabsContent>
          <TabsContent value="existing">
            <ExistingPersonTab sectorId={sectorId} onDone={done} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
