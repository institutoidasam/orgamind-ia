/** As 11 colunas do modelo de importação (mesmos cabeçalhos da exportação). */
export const PEOPLE_TEMPLATE_COLUMNS = [
  'matricula',
  'nome',
  'telefone',
  'funcao',
  'setor',
  'turno',
  'nivel',
  'autorizacao_contato',
  'origem_autorizacao',
  'detalhe_origem',
  'data_autorizacao',
] as const;

/** As 11 do modelo mais `situacao` e `tem_acesso`. */
export const PEOPLE_EXPORT_COLUMNS = [
  ...PEOPLE_TEMPLATE_COLUMNS,
  'situacao',
  'tem_acesso',
] as const;

export type PeopleColumn = (typeof PEOPLE_EXPORT_COLUMNS)[number];

export const PEOPLE_COLUMN_MEANING: Readonly<Record<PeopleColumn, string>> = {
  matricula: 'Matrícula da pessoa na empresa.',
  nome: 'Nome da pessoa. Quando o nome é o próprio telefone e o telefone está mascarado, o nome também sai mascarado.',
  telefone:
    'Telefone no formato (92) 99111-2008; número de fora do Brasil sai no formato internacional. Mascarado (•••• 2008) para quem não pode vê-lo completo.',
  funcao: 'Função da pessoa.',
  setor: 'Setor na data de referência.',
  turno: 'Turno habitual na data de referência.',
  nivel: 'Nível na data de referência.',
  autorizacao_contato:
    'Sim quando a pessoa autorizou receber mensagens; Não quando não.',
  origem_autorizacao:
    'De onde veio a autorização: Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro ou Cadastro anterior.',
  detalhe_origem: 'Detalhe da origem, quando ela é Outro.',
  data_autorizacao: 'Data da autorização (DD/MM/AAAA).',
  situacao: 'Ativa ou Inativa.',
  tem_acesso: 'Sim quando a pessoa entra no sistema com login.',
};

export type AuthorizationSourceCode =
  | 'TERMO_ASSINADO'
  | 'FICHA_ADMISSAO'
  | 'ACEITE_WHATSAPP'
  | 'OUTRO'
  | 'CADASTRO_ANTERIOR';

export const AUTHORIZATION_SOURCE_CELL: Readonly<
  Record<AuthorizationSourceCode, string>
> = {
  TERMO_ASSINADO: 'Termo assinado',
  FICHA_ADMISSAO: 'Ficha de admissão',
  ACEITE_WHATSAPP: 'Aceite por WhatsApp',
  OUTRO: 'Outro',
  CADASTRO_ANTERIOR: 'Cadastro anterior',
};

export const PERSON_STATUS_CELL = {
  active: 'Ativa',
  inactive: 'Inativa',
} as const;
