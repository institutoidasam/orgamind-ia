import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sectorInputSchema, type Sector, type SectorInput } from "../schemas";
import { useAllUsers } from "@/features/users/api";
import { FormField } from "./form-field";

type Props = {
  sector?: Sector;
  pending: boolean;
  onSubmit: (input: SectorInput) => Promise<void>;
  onCancel: () => void;
};
const EMPTY: SectorInput = {
  name: "",
  code: "",
  description: undefined,
  managerId: null,
  isActive: true,
};

export function SectorForm({ sector, pending, onSubmit, onCancel }: Props) {
  const form = useForm<SectorInput>({
    resolver: zodResolver(sectorInputSchema) as never,
    defaultValues: EMPTY,
  });
  const users = useAllUsers();
  useEffect(() => form.reset(toValues(sector)), [sector, form]);
  return (
    <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
      <SectorIdentity form={form} />
      <SectorManager form={form} users={users.data ?? []} />
      <SectorState form={form} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <Button disabled={pending}>Salvar setor</Button>
      </div>
    </form>
  );
}

function SectorIdentity({
  form,
}: {
  form: ReturnType<typeof useForm<SectorInput>>;
}) {
  return (
    <>
      <FormField
        id="sector-name"
        label="Nome do setor"
        error={form.formState.errors.name?.message}
      >
        <Input id="sector-name" {...form.register("name")} />
      </FormField>
      <FormField
        id="sector-code"
        label="Sigla"
        error={form.formState.errors.code?.message}
      >
        <Input id="sector-code" maxLength={8} {...form.register("code")} />
      </FormField>
      <FormField
        id="sector-description"
        label="Descrição"
        error={form.formState.errors.description?.message}
      >
        <Textarea id="sector-description" {...form.register("description")} />
      </FormField>
    </>
  );
}

function SectorManager({
  form,
  users,
}: {
  form: ReturnType<typeof useForm<SectorInput>>;
  users: Array<{
    id: string;
    name: string | null;
    email: string;
    isActive: boolean;
    role: "ADMIN" | "SUPERVISOR" | "OPERATOR" | "VIEWER";
  }>;
}) {
  const managerId = useWatch({ control: form.control, name: "managerId" });
  return (
    <FormField id="sector-manager" label="Gestor">
      <Select
        value={managerId ?? "none"}
        onValueChange={(id) =>
          form.setValue("managerId", id === "none" ? null : id)
        }
      >
        <SelectTrigger aria-label="Gestor">
          <SelectValue placeholder="Definir depois" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Definir depois</SelectItem>
          {users
            .filter((user) => user.isActive && user.role !== "VIEWER")
            .map((user) => (
              <SelectItem value={user.id} key={user.id}>
                {user.name ?? user.email}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function SectorState({
  form,
}: {
  form: ReturnType<typeof useForm<SectorInput>>;
}) {
  const isActive = useWatch({ control: form.control, name: "isActive" });
  return (
    <FormField id="sector-state" label="Estado">
      <Select
        value={isActive ? "active" : "inactive"}
        onValueChange={(value) => form.setValue("isActive", value === "active")}
      >
        <SelectTrigger aria-label="Estado">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Ativo</SelectItem>
          <SelectItem value="inactive">Inativo</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        Setores inativos preservam o histórico e saem de novas seleções.
      </p>
    </FormField>
  );
}

function toValues(sector?: Sector): SectorInput {
  if (!sector) return EMPTY;
  return {
    name: sector.name,
    code: sector.code,
    description: sector.description ?? undefined,
    managerId: sector.managerId,
    isActive: sector.isActive,
  };
}
