import type { BatchSituation, ImportField, RowClass } from './schemas';

export const ROW_CLASS_LABEL: Record<RowClass, string> = {
  CREATE: 'Criar',
  UPDATE: 'Atualizar',
  UNCHANGED: 'Sem alteração',
  INVALID: 'Inválida',
  DUPLICATE: 'Duplicada',
  CONFLICT: 'Conflito',
  IGNORED: 'Ignorada',
};

export const SITUATION_LABEL: Record<BatchSituation, string> = {
  PREVIEW: 'Em prévia',
  WRITING: 'Gravando',
  INTERRUPTED: 'Gravação interrompida',
  COMPLETED: 'Concluída',
  CLOSED: 'Encerrada',
};

/** Mesmos rótulos de `IMPORT_FIELD_LABEL` do backend. */
export const FIELD_LABEL: Record<ImportField, string> = {
  registration: 'Matrícula',
  name: 'Nome',
  phone: 'Telefone',
  jobTitle: 'Função',
  sector: 'Setor',
  shift: 'Turno',
  level: 'Nível',
  authorization: 'Autorização de contato',
  authorizationSource: 'Origem da autorização',
  authorizationNote: 'Detalhe da origem',
  authorizationDate: 'Data da autorização',
};

/**
 * Texto do botão e do diálogo de confirmação (E5). O substantivo concorda com o último
 * número citado; sem nenhum lado selecionado, não há o que confirmar.
 */
export function confirmText(toCreate: number, toUpdate: number): string {
  if (toCreate === 0 && toUpdate === 0) return 'Nenhuma pessoa selecionada';
  const noun = (toUpdate > 0 ? toUpdate : toCreate) === 1 ? 'pessoa' : 'pessoas';
  if (toUpdate === 0) return `Criar ${toCreate} ${noun}`;
  if (toCreate === 0) return `Atualizar ${toUpdate} ${noun}`;
  return `Criar ${toCreate} e atualizar ${toUpdate} ${noun}`;
}
