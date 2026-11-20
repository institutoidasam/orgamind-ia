/** Estrutura que a prévia nomeia nos textos de "não encontrado" e "ambíguo". */
export type StructureKind = 'Setor' | 'Turno' | 'Nível';

/** Os únicos textos de motivo e aviso de linha da importação (CX3, GX16). */
export const ROW_TEXT = {
  noKey: 'Sem matrícula nem telefone para identificar',
  phoneTaken: 'O telefone já pertence a outra pessoa cadastrada',
  registrationTaken: 'A matrícula já pertence a outra pessoa cadastrada',
  duplicateOf: (first: number) =>
    `Linha repetida: a mesma matrícula ou o mesmo telefone já aparece na linha ${first}`,
  invalidName: 'Nome inválido',
  newNeedsName: 'Pessoa nova precisa de nome',
  newNeedsPhone: 'Pessoa nova precisa de telefone',
  invalidPhone: 'Telefone inválido',
  /** Nome 120, Função 80, Matrícula 30, Detalhe da origem 120. */
  tooLong: (label: string, max: number) =>
    `${label} com mais de ${max} caracteres`,
  inactivePerson: 'Pessoa inativa; reative na ficha',
  notFound: (kind: StructureKind, text: string) =>
    `${kind} '${text}' não encontrado`,
  ambiguous: (kind: StructureKind, text: string) =>
    `${kind} '${text}' corresponde a mais de um`,
  notInReach: (text: string) =>
    `Setor '${text}' não encontrado entre os setores que você gerencia`,
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
} as const;
