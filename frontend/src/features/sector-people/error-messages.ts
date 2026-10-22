import { HTTPError } from 'ky';
import { toast } from 'sonner';
import { extractApiError, readApiErrorBody } from '@/lib/api-error';
import type { SectorPeopleFailureReason } from './schemas';

export const SECTOR_FORBIDDEN_MESSAGE = 'Você não gerencia este setor.';

const SECTOR_PEOPLE_ERROR_MESSAGES: Record<string, string> = {
  'sector_people.forbidden': 'Você não pode mexer nesta pessoa.',
  'sector_people.has_access': 'Quem tem acesso muda de setor pelo cadastro em Usuários.',
  'sector_people.person_not_found': 'Pessoa não encontrada. Atualize a página.',
  'users.invalid_level': 'Nível inválido. Atualize a página e tente de novo.',
  'users.invalid_shift': 'Turno inválido. Atualize a página.',
  'user.sector_required': 'Defina o setor da pessoa em Editar antes de dar acesso a este perfil.',
  'user.sector_invalid': 'O setor da pessoa está inativo. Escolha outro em Editar.',
};

/** Motivo por contato que não virou pessoa (`failed` do lote). */
export const FAILURE_REASON_MESSAGES: Record<SectorPeopleFailureReason, string> = {
  invalid_phone: 'Telefone inválido',
  phone_taken: 'Número já usado por outra pessoa',
  already_person: 'Já é uma pessoa cadastrada',
  contact_not_found: 'Contato não encontrado',
};

export const addedPeopleMessage = (count: number) => `${count} pessoa(s) adicionada(s)`;

/** Mensagem pt-BR do código de erro de uma ação sobre pessoa do setor; undefined = erro genérico. */
export async function describeSectorPeopleError(error: unknown): Promise<string | undefined> {
  const code = (await readApiErrorBody(error))?.code;
  return code ? SECTOR_PEOPLE_ERROR_MESSAGES[code] : undefined;
}

/** Leitura da página negada: o gestor de outro setor (ou setor inexistente para ele) recebe 403. */
export function isSectorForbidden(error: unknown): boolean {
  return error instanceof HTTPError && error.response.status === 403;
}

/** Toast do erro de uma ação sobre pessoa: mensagem pt-BR do código conhecido, senão o erro genérico. */
export async function toastSectorPeopleError(error: unknown): Promise<void> {
  const message = await describeSectorPeopleError(error);
  if (message) {
    toast.error(message);
    return;
  }
  const { title, message: detail } = await extractApiError(error);
  toast.error(title, { description: detail });
}
