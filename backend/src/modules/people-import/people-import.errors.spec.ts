import { describe, expect, it } from 'vitest';
import {
  alreadyConfirmed,
  batchNotFound,
  closeAdminOnly,
  importDuplicateHeader,
  importEmpty,
  importFileTooLarge,
  importInvalidFile,
  importNoData,
  importNoManagedSector,
  importTooManyRows,
  importUnreadable,
  mappingIncomplete,
  notConfirmer,
  notInPreview,
  notUploader,
  notWriting,
  nothingSelected,
  previewChanged,
} from './people-import.errors';
import { ROW_TEXT } from './row-texts';

const PREFIX = 'people_import.';

describe('erros da importação: a prévia mudou (EX6, EX8)', () => {
  it('previewChanged: 409 com o título e o texto da tela', () => {
    expect(previewChanged()).toMatchObject({
      code: 'people_import.preview_changed',
      status: 409,
      message: 'A prévia mudou',
      detail:
        'A prévia mudou depois que você a abriu. Confira de novo antes de confirmar.',
    });
  });
});

// [erro, code sem prefixo, status, texto da tela]
const ERROR_TABLE = [
  [
    importFileTooLarge(),
    'file_too_large',
    422,
    'O arquivo passa de 5 MB. Divida a planilha e envie em partes.',
  ],
  [
    importTooManyRows(),
    'too_many_rows',
    422,
    'A planilha tem linhas demais. Envie até 5.000 por vez.',
  ],
  [importInvalidFile(), 'invalid_file', 422, 'Envie um arquivo .csv ou .xlsx.'],
  [
    importUnreadable(),
    'unreadable',
    422,
    'Não foi possível ler a planilha. Confira se o arquivo abre no Excel e envie de novo.',
  ],
  [
    importUnreadable('O CSV tem aspas sem fechamento a partir da linha 7.'),
    'unreadable',
    422,
    'O CSV tem aspas sem fechamento a partir da linha 7.',
  ],
  [importEmpty(), 'empty', 422, 'A planilha está vazia.'],
  [
    importNoData(),
    'no_data',
    422,
    'A planilha não tem linhas de dados abaixo do cabeçalho.',
  ],
  [
    importDuplicateHeader('NOME'),
    'duplicate_header',
    422,
    "A coluna 'NOME' aparece mais de uma vez no cabeçalho.",
  ],
  [
    mappingIncomplete('Falta indicar a coluna do nome.'),
    'mapping_incomplete',
    422,
    'Falta indicar a coluna do nome.',
  ],
  [batchNotFound(), 'batch_not_found', 404, 'Lote não encontrado.'],
  [
    notUploader(),
    'not_uploader',
    403,
    'Só quem enviou a planilha pode mudar as colunas ou confirmar a importação.',
  ],
  [
    notConfirmer(),
    'not_confirmer',
    403,
    'Só quem confirmou a importação pode continuar a gravação.',
  ],
  [
    closeAdminOnly(),
    'close_admin_only',
    403,
    'Só o administrador pode encerrar a gravação.',
  ],
  [
    importNoManagedSector(),
    'no_managed_sector',
    403,
    'Você não gerencia nenhum setor.',
  ],
  [
    alreadyConfirmed(),
    'already_confirmed',
    409,
    'Esta importação já foi confirmada.',
  ],
  [
    notInPreview(),
    'not_preview',
    409,
    'A prévia deste lote não está mais disponível.',
  ],
  [
    notWriting(),
    'not_writing',
    409,
    'A gravação deste lote já terminou ou foi encerrada.',
  ],
  [
    nothingSelected(),
    'nothing_selected',
    422,
    'Escolha pelo menos uma linha para gravar.',
  ],
] as const;

// Textos fixos de CX3 (GX16), copiados à mão.
const STATIC_ROW_TEXT = {
  noKey: 'Sem matrícula nem telefone para identificar',
  phoneTaken: 'O telefone já pertence a outra pessoa cadastrada',
  registrationTaken: 'A matrícula já pertence a outra pessoa cadastrada',
  invalidName: 'Nome inválido',
  newNeedsName: 'Pessoa nova precisa de nome',
  newNeedsPhone: 'Pessoa nova precisa de telefone',
  invalidPhone: 'Telefone inválido',
  inactivePerson: 'Pessoa inativa; reative na ficha',
  sectorRequired: 'Informe o setor',
  cannotEditPerson: 'Você não pode alterar esta pessoa.',
  cannotEditPhone: 'Você não pode alterar o telefone desta pessoa.',
  cannotEditAuthorization: 'Você não pode alterar a autorização desta pessoa.',
  authorizationWithoutSource: 'Autorização ignorada: falta a origem.',
  authorizationWithoutNote: 'Autorização ignorada: falta o detalhe da origem.',
  noRevoke: 'A planilha não retira autorização; faça na ficha da pessoa.',
  invalidYesNo: 'Autorização de contato inválida: use Sim ou Não',
  invalidDate: 'Data da autorização inválida: use DD/MM/AAAA',
  futureDate: 'Data da autorização no futuro',
  newWithoutAuthorization:
    'Esta pessoa não receberá mensagens até ter a autorização registrada.',
  mustLoginAgain: 'Esta pessoa terá de entrar de novo no sistema.',
  example: 'Linha de exemplo',
  blank: 'Linha em branco',
  changedAfterPreview: 'A pessoa foi alterada depois da prévia',
  removedAfterPreview: 'A pessoa foi removida depois da prévia',
  structureInactive: 'Setor, turno ou nível não está mais ativo',
  notWrittenClosed: 'Não gravada: gravação encerrada',
  writeFailed: 'Não foi possível gravar esta linha.',
};

// [texto montado, texto esperado]
const FUNCTION_ROW_TEXT = [
  [
    ROW_TEXT.duplicateOf(4),
    'Linha repetida: a mesma matrícula ou o mesmo telefone já aparece na linha 4',
  ],
  [ROW_TEXT.tooLong('Nome', 120), 'Nome com mais de 120 caracteres'],
  [ROW_TEXT.notFound('Setor', 'Cozinha'), "Setor 'Cozinha' não encontrado"],
  [ROW_TEXT.notFound('Nível', 'Sênior'), "Nível 'Sênior' não encontrado"],
  [
    ROW_TEXT.ambiguous('Turno', 'Manhã'),
    "Turno 'Manhã' corresponde a mais de um",
  ],
  [
    ROW_TEXT.notInReach('Obra'),
    "Setor 'Obra' não encontrado entre os setores que você gerencia",
  ],
] as const;

describe('erros da importação', () => {
  it('cada erro tem code, status e o texto da tabela', () => {
    for (const [error, code, status, detail] of ERROR_TABLE) {
      expect(error).toMatchObject({ code: `${PREFIX}${code}`, status, detail });
      expect(error.message.length).toBeGreaterThan(0);
    }
    expect(alreadyConfirmed()).toMatchObject({
      code: 'people_import.already_confirmed',
      status: 409,
    });
  });
});

describe('ROW_TEXT', () => {
  it('ROW_TEXT: textos exatamente os de CX3', () => {
    const fixed = Object.fromEntries(
      Object.entries(ROW_TEXT).filter(([, v]) => typeof v === 'string'),
    );
    expect(fixed).toEqual(STATIC_ROW_TEXT);
    for (const [actual, expected] of FUNCTION_ROW_TEXT) {
      expect(actual).toBe(expected);
    }
  });
});
