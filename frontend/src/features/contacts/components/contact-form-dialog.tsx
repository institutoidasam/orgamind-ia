import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { HTTPError } from 'ky';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  createContactSchema,
  editContactSchema,
  type EditContactInput,
  type Contact,
} from '../schemas';
import { useCreateContact, useUpdateContact } from '../api';
import { useContactFacets } from '../facets-api';
import { FacetCombobox } from './facet-combobox';
import { TagsCombobox } from './tags-combobox';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
};

// `optedOut` lives in `editContactSchema`, so it survives the zod resolver on
// the edit path; on create it is simply left unset (defaults to active).
type FormValues = EditContactInput;

/** Empty/blank strings collapse to `undefined` so optional fields are omitted. */
function optional(value: string | undefined): string | undefined {
  return value || undefined;
}

function buildCreatePayload(data: FormValues) {
  const tags = data.tags ?? [];
  return {
    phone: data.phone,
    name: optional(data.name),
    city: optional(data.city),
    group: optional(data.group),
    tags: tags.length ? tags : undefined,
  };
}

function buildUpdateInput(data: FormValues) {
  return {
    name: optional(data.name),
    city: optional(data.city),
    group: optional(data.group),
    tags: data.tags ?? [],
    optedOut: data.optedOut,
  };
}

type ApiErrorBody = { code?: string; detail?: string } | null;

/** Read the JSON error body off a ky HTTPError, or `null` if absent/unparseable. */
async function readErrorBody(err: unknown): Promise<ApiErrorBody> {
  if (!(err instanceof HTTPError)) return null;
  return (await err.response
    .clone()
    .json()
    .catch(() => null)) as ApiErrorBody;
}

/**
 * Map a parsed API error body to a phone field-error message, or `null` when
 * the error is not a known phone-related code (caller falls back to a toast).
 */
function phoneFieldErrorMessage(body: ApiErrorBody): string | null {
  if (body?.code === 'contact.phone_conflict') {
    return 'Já existe um contato com esse telefone';
  }
  if (body?.code === 'contact.invalid_phone') {
    return body.detail ?? 'Telefone inválido';
  }
  return null;
}

export function ContactFormDialog({ open, onOpenChange, contact }: Props) {
  const isEdit = !!contact;
  const create = useCreateContact();
  const update = useUpdateContact();
  const pending = create.isPending || update.isPending;
  // Alimenta os combobox de cidade/grupo/tags com o que já existe em OUTROS
  // contatos — mesmo endpoint que já serve o filtro por facetas da campanha
  // (`facets-api.ts`), reaproveitado aqui em vez de um novo.
  const { data: facets } = useContactFacets();

  const form = useForm<FormValues>({
    resolver: zodResolver(isEdit ? editContactSchema : createContactSchema),
    defaultValues: {
      phone: '',
      name: '',
      city: '',
      group: '',
      tags: [],
      optedOut: false,
    },
  });

  useEffect(() => {
    if (!open) {
      form.reset();
      return;
    }
    if (contact) {
      form.reset({
        phone: contact.phoneE164,
        name: contact.name ?? '',
        city: contact.city ?? '',
        group: contact.group ?? '',
        tags: contact.tags,
        optedOut: contact.optedOut,
      });
    } else {
      form.reset({
        phone: '',
        name: '',
        city: '',
        group: '',
        tags: [],
        optedOut: false,
      });
    }
  }, [open, contact, form]);

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      if (isEdit && contact) {
        await update.mutateAsync({
          id: contact.id,
          input: buildUpdateInput(data),
        });
        toast.success('Contato atualizado');
      } else {
        await create.mutateAsync(buildCreatePayload(data));
        toast.success('Contato criado');
      }
      onOpenChange(false);
    } catch (err) {
      const phoneError = phoneFieldErrorMessage(await readErrorBody(err));
      if (phoneError) {
        form.setError('phone', { message: phoneError });
        return;
      }
      toast.error(isEdit ? 'Erro ao atualizar contato' : 'Erro ao criar contato');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar contato' : 'Novo contato'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="phone">Telefone *</Label>
            <Input
              id="phone"
              placeholder="+5592987654321 ou (92) 98765-4321"
              disabled={isEdit}
              {...form.register('phone')}
            />
            {form.formState.errors.phone && (
              <p className="text-xs text-destructive">
                {form.formState.errors.phone.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {isEdit
                ? 'O telefone identifica o contato e não pode ser alterado.'
                : 'Aceita E.164 ou DDD brasileiro — será normalizado.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" {...form.register('name')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="city">Cidade</Label>
              <FacetCombobox
                id="city"
                value={form.watch('city') ?? ''}
                onChange={(v) => form.setValue('city', v, { shouldDirty: true })}
                options={facets?.cities ?? []}
                placeholder="Buscar ou criar cidade"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="group">Grupo</Label>
              <FacetCombobox
                id="group"
                value={form.watch('group') ?? ''}
                onChange={(v) => form.setValue('group', v, { shouldDirty: true })}
                options={facets?.groups ?? []}
                placeholder="alunos / clientes"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tags">Tags</Label>
            <TagsCombobox
              id="tags"
              value={form.watch('tags') ?? []}
              onChange={(tags) => form.setValue('tags', tags, { shouldDirty: true })}
              options={facets?.tags ?? []}
              placeholder="Buscar ou criar tag"
            />
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.watch('optedOut') ?? false}
                onCheckedChange={(v) =>
                  form.setValue('optedOut', v === true, { shouldDirty: true })
                }
              />
              <span>Marcar como opt-out (não receber mensagens)</span>
            </label>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? isEdit
                  ? 'Salvando…'
                  : 'Criando…'
                : isEdit
                  ? 'Salvar alterações'
                  : 'Criar contato'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
