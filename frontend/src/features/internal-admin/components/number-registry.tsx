import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QueryErrorFallback } from "@/components/query-error-fallback";
import { extractApiError } from "@/lib/api-error";
import {
  useCreateInternalNumber,
  useInternalNumbers,
  useSectors,
  useUpdateInternalNumber,
} from "../api";
import { useProviders } from "@/features/whatsapp/api";
import {
  internalNumberInputSchema,
  type InternalNumber,
  type InternalNumberInput,
} from "../schemas";
import { FormField } from "./form-field";

const EMPTY: InternalNumberInput = {
  name: "",
  phone: "+55",
  provider: "META",
  sectorId: "",
  routeToSector: true,
};

export function NumberRegistry() {
  const numbers = useInternalNumbers();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<InternalNumber | null>(null);
  const [editing, setEditing] = useState<InternalNumber | null>(null);
  if (numbers.isError)
    return (
      <QueryErrorFallback error={numbers.error} onRetry={numbers.refetch} />
    );
  return (
    <section className="space-y-4 rounded-xl border p-4">
      <RegistryHeader onCreate={() => setOpen(true)} />
      <NumberList
        numbers={numbers.data?.items ?? []}
        loading={numbers.isLoading}
        onSelect={setSelected}
      />
      <NumberDialog open={open} onOpenChange={setOpen} />
      {editing ? (
        <NumberDialog
          number={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}
      {selected ? (
        <NumberDetailsDialog
          number={selected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setSelected(null);
            setEditing(selected);
          }}
        />
      ) : null}
    </section>
  );
}

function RegistryHeader({ onCreate }: { onCreate: () => void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="ds-eyebrow">administração / estrutura</p>
        <h1 className="ds-display !text-3xl">Números e canais.</h1>
        <p className="text-sm text-muted-foreground">
          O vínculo do número não concede acesso ao canal externo.
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus className="mr-2 size-4" />
        Cadastrar número
      </Button>
    </header>
  );
}

function NumberList({
  numbers,
  loading,
  onSelect,
}: {
  numbers: InternalNumber[];
  loading: boolean;
  onSelect: (number: InternalNumber) => void;
}) {
  if (loading)
    return <p className="text-sm text-muted-foreground">Carregando números…</p>;
  if (!numbers.length)
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum número estrutural cadastrado.
      </p>
    );
  return (
    <div className="space-y-2">
      {numbers.map((number) => (
        <NumberRow key={number.id} number={number} onSelect={onSelect} />
      ))}
    </div>
  );
}

function NumberRow({
  number,
  onSelect,
}: {
  number: InternalNumber;
  onSelect: (number: InternalNumber) => void;
}) {
  const configured = number.configurationStatus === "CONFIGURED";
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div>
        <p className="font-medium">{number.name}</p>
        <p className="text-sm text-muted-foreground">
          {number.phone} · {providerLabel(number.provider)} ·{" "}
          {number.sector?.name ?? "Sem setor"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={configured ? "secondary" : "outline"}>
          {configured ? "Integração cadastrada" : "A configurar"}
        </Badge>
        <Badge variant="outline">
          {number.routingStatus === "PENDING"
            ? "Roteamento pendente"
            : number.routingStatus}
        </Badge>
        <Button size="sm" variant="outline" onClick={() => onSelect(number)}>
          Detalhes
        </Button>
      </div>
    </article>
  );
}

function NumberDetailsDialog({
  number,
  onClose,
  onEdit,
}: {
  number: InternalNumber;
  onClose: () => void;
  onEdit: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{number.name}</DialogTitle>
        </DialogHeader>
        <NumberDetails number={number} />
        <DialogFooter>
          <Button variant="outline" onClick={onEdit}>
            Editar cadastro
          </Button>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberDetails({ number }: { number: InternalNumber }) {
  return (
    <div className="space-y-2 text-sm">
      <p><strong>Número:</strong> {number.phone}</p>
      <p><strong>Setor:</strong> {number.sector?.name ?? "Sem setor"}</p>
      <p><strong>Provedor:</strong> {providerLabel(number.provider)}</p>
      <p><strong>Roteamento:</strong> {number.routeToSector ? "Pendente de configuração" : "Não solicitado"}</p>
      <p className="text-muted-foreground">{channelMessage(number)}</p>
      <p className="text-xs text-muted-foreground">Configure o canal externo nos formulários desta página. O vínculo não concede acesso a ele.</p>
    </div>
  );
}

function channelMessage(number: InternalNumber) {
  return number.channel
    ? `Canal efetivo: ${number.channel.name}`
    : "Nenhum canal externo configurado para este cadastro.";
}

function NumberDialog({
  number,
  open,
  onOpenChange,
}: {
  number?: InternalNumber;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const state = useNumberDialog(number, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{number ? "Editar número" : "Cadastrar número"}</DialogTitle>
        </DialogHeader>
        <NumberForm state={state} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function useNumberDialog(
  number: InternalNumber | undefined,
  onOpenChange: (open: boolean) => void,
) {
  const create = useCreateInternalNumber();
  const update = useUpdateInternalNumber(number?.id ?? "");
  const sectors = useSectors(true);
  const providers = useProviders();
  const form = useForm<InternalNumberInput>({
    resolver: zodResolver(internalNumberInputSchema) as never,
    defaultValues: number ? numberInput(number) : EMPTY,
  });
  useEffect(
    () => form.reset(number ? numberInput(number) : EMPTY),
    [number, form],
  );
  const routeToSector = useWatch({ control: form.control, name: "routeToSector" });
  const channelId = useWatch({ control: form.control, name: "channelId" });
  const provider = useWatch({ control: form.control, name: "provider" });
  const sectorId = useWatch({ control: form.control, name: "sectorId" });
  const submit = async (input: InternalNumberInput) => {
    try {
      if (number) await update.mutateAsync(input);
      else await create.mutateAsync(input);
      toast.success(
        number ? "Cadastro atualizado" : "Vínculo estrutural salvo",
      );
      form.reset(EMPTY);
      onOpenChange(false);
    } catch (error) {
      const apiError = await extractApiError(error);
      toast.error(apiError.title, { description: apiError.message });
    }
  };
  return {
    channelId,
    channels: providers.data?.providers.flatMap((group) => group.channels) ?? [],
    form,
    pending: create.isPending || update.isPending,
    provider,
    routeToSector,
    sectorId,
    sectors: sectors.data?.items ?? [],
    submit,
  };
}

function NumberForm({
  state,
  onCancel,
}: {
  state: ReturnType<typeof useNumberDialog>;
  onCancel: () => void;
}) {
  return (
    <form className="space-y-4" onSubmit={state.form.handleSubmit(state.submit)}>
      <NumberFormFields state={state} />
      <RoutingField form={state.form} routeToSector={state.routeToSector} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button>
        <Button disabled={state.pending}>Salvar vínculo</Button>
      </DialogFooter>
    </form>
  );
}

function NumberFormFields({ state }: { state: ReturnType<typeof useNumberDialog> }) {
  const { form } = state;
  return (
    <>
      <FormField id="number-name" label="Nome" error={form.formState.errors.name?.message}>
        <Input id="number-name" {...form.register("name")} />
      </FormField>
      <FormField id="number-phone" label="Número E.164" error={form.formState.errors.phone?.message}>
        <Input id="number-phone" placeholder="+5592999990000" {...form.register("phone")} />
      </FormField>
      <ProviderSelect form={form} provider={state.provider} />
      <SectorSelect form={form} sectorId={state.sectorId} sectors={state.sectors} />
      <ChannelSelect form={form} channelId={state.channelId} channels={state.channels} />
    </>
  );
}

function RoutingField({
  form,
  routeToSector,
}: {
  form: ReturnType<typeof useForm<InternalNumberInput>>;
  routeToSector: boolean;
}) {
  return (
    <>
      <label className="flex gap-2 text-sm">
        <Checkbox checked={routeToSector} onCheckedChange={(value) => form.setValue("routeToSector", value === true)} />
        Encaminhar novas conversas para a fila do setor
      </label>
      <p className="text-xs text-muted-foreground">A conexão real é configurada nos formulários de provedor abaixo. Este cadastro não cria credenciais nem concessões de atendimento.</p>
    </>
  );
}

function ChannelSelect({
  form,
  channelId,
  channels,
}: {
  form: ReturnType<typeof useForm<InternalNumberInput>>;
  channelId: string | null | undefined;
  channels: Array<{
    id: string;
    name: string;
    provider: string;
    isActive: boolean;
  }>;
}) {
  return (
    <FormField id="number-channel" label="Canal externo existente">
      <Select
        value={channelId ?? "none"}
        onValueChange={(value) =>
          form.setValue("channelId", value === "none" ? null : value)
        }
      >
        <SelectTrigger aria-label="Canal externo existente">
          <SelectValue placeholder="Configurar depois" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Configurar depois</SelectItem>
          {channels
            .filter((channel) => channel.isActive)
            .map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name} · {channel.provider}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        Escolha somente um canal já configurado; o vínculo não altera permissões
        nem conexão.
      </p>
    </FormField>
  );
}

function ProviderSelect({
  form,
  provider,
}: {
  form: ReturnType<typeof useForm<InternalNumberInput>>;
  provider: InternalNumberInput["provider"];
}) {
  return (
    <FormField id="number-provider" label="Provedor">
      <Select
        value={provider}
        onValueChange={(value) =>
          form.setValue("provider", value as InternalNumberInput["provider"])
        }
      >
        <SelectTrigger aria-label="Provedor">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="META">Meta Cloud API</SelectItem>
          <SelectItem value="EVOLUTION">Evolution API</SelectItem>
          <SelectItem value="OTHER">Outro</SelectItem>
        </SelectContent>
      </Select>
    </FormField>
  );
}

function SectorSelect({
  form,
  sectorId,
  sectors,
}: {
  form: ReturnType<typeof useForm<InternalNumberInput>>;
  sectorId: string;
  sectors: Array<{ id: string; name: string }>;
}) {
  return (
    <FormField
      id="number-sector"
      label="Setor responsável"
      error={form.formState.errors.sectorId?.message}
    >
      <Select
        value={sectorId}
        onValueChange={(value) => form.setValue("sectorId", value)}
      >
        <SelectTrigger aria-label="Setor responsável">
          <SelectValue placeholder="Selecione" />
        </SelectTrigger>
        <SelectContent>
          {sectors.map((sector) => (
            <SelectItem key={sector.id} value={sector.id}>
              {sector.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function providerLabel(provider: InternalNumber["provider"]) {
  return { META: "Meta Cloud API", EVOLUTION: "Evolution API", OTHER: "Outro" }[
    provider
  ];
}

function numberInput(number: InternalNumber): InternalNumberInput {
  return {
    name: number.name,
    phone: number.phone,
    provider: number.provider,
    sectorId: number.sectorId ?? "",
    routeToSector: number.routeToSector,
    channelId: number.channelId,
  };
}
