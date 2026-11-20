import { DomainError } from '../../shared/errors/domain.error';

const CODE_PREFIX = 'people_import.';

/** `message` é o título curto; `detail` é o texto que a tela mostra. */
function importError(
  code: string,
  status: number,
  message: string,
  detail: string,
): DomainError {
  return new DomainError({
    code: `${CODE_PREFIX}${code}`,
    status,
    message,
    detail,
  });
}

/** EX4: o arquivo passa de `IMPORT_MAX_BYTES`. */
export function importFileTooLarge(): DomainError {
  return importError(
    'file_too_large',
    422,
    'Arquivo grande demais',
    'O arquivo passa de 5 MB. Divida a planilha e envie em partes.',
  );
}

export function importTooManyRows(): DomainError {
  return importError(
    'too_many_rows',
    422,
    'Planilha grande demais',
    'A planilha tem linhas demais. Envie até 5.000 por vez.',
  );
}

export function importInvalidFile(): DomainError {
  return importError(
    'invalid_file',
    422,
    'Tipo de arquivo inválido',
    'Envie um arquivo .csv ou .xlsx.',
  );
}

export function importUnreadable(detail?: string): DomainError {
  return importError(
    'unreadable',
    422,
    'Planilha ilegível',
    detail ??
      'Não foi possível ler a planilha. Confira se o arquivo abre no Excel e envie de novo.',
  );
}

export function importEmpty(): DomainError {
  return importError('empty', 422, 'Planilha vazia', 'A planilha está vazia.');
}

export function importNoData(): DomainError {
  return importError(
    'no_data',
    422,
    'Planilha sem dados',
    'A planilha não tem linhas de dados abaixo do cabeçalho.',
  );
}

export function importDuplicateHeader(name: string): DomainError {
  return importError(
    'duplicate_header',
    422,
    'Cabeçalho repetido',
    `A coluna '${name}' aparece mais de uma vez no cabeçalho.`,
  );
}

/** `detail` é o texto de `mappingProblem` (CX6). */
export function mappingIncomplete(detail: string): DomainError {
  return importError('mapping_incomplete', 422, 'Colunas incompletas', detail);
}

export function batchNotFound(): DomainError {
  return importError(
    'batch_not_found',
    404,
    'Lote não encontrado',
    'Lote não encontrado.',
  );
}

export function notUploader(): DomainError {
  return importError(
    'not_uploader',
    403,
    'Ação não permitida',
    'Só quem enviou a planilha pode mudar as colunas ou confirmar a importação.',
  );
}

export function notConfirmer(): DomainError {
  return importError(
    'not_confirmer',
    403,
    'Ação não permitida',
    'Só quem confirmou a importação pode continuar a gravação.',
  );
}

export function closeAdminOnly(): DomainError {
  return importError(
    'close_admin_only',
    403,
    'Ação não permitida',
    'Só o administrador pode encerrar a gravação.',
  );
}

export function importNoManagedSector(): DomainError {
  return importError(
    'no_managed_sector',
    403,
    'Ação não permitida',
    'Você não gerencia nenhum setor.',
  );
}

export function alreadyConfirmed(): DomainError {
  return importError(
    'already_confirmed',
    409,
    'Importação já confirmada',
    'Esta importação já foi confirmada.',
  );
}

/** EX6/EX8: outro pedido remapeou o lote entre a leitura e a confirmação. */
export function previewChanged(): DomainError {
  return importError(
    'preview_changed',
    409,
    'A prévia mudou',
    'A prévia mudou depois que você a abriu. Confira de novo antes de confirmar.',
  );
}

export function notInPreview(): DomainError {
  return importError(
    'not_preview',
    409,
    'Prévia indisponível',
    'A prévia deste lote não está mais disponível.',
  );
}

export function notWriting(): DomainError {
  return importError(
    'not_writing',
    409,
    'Gravação encerrada',
    'A gravação deste lote já terminou ou foi encerrada.',
  );
}

export function nothingSelected(): DomainError {
  return importError(
    'nothing_selected',
    422,
    'Nenhuma linha escolhida',
    'Escolha pelo menos uma linha para gravar.',
  );
}
