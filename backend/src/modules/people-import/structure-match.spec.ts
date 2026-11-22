import { describe, expect, it } from 'vitest';
import { ROW_TEXT } from './row-texts';
import {
  matchStructure,
  normalizeStructureName,
  structureName,
  type StructureCatalog,
  type StructureKind,
  type StructureMatch,
} from './structure-match';

const option = (
  id: string,
  name: string,
  isActive = true,
  code: string | null = null,
) => ({ id, name, code, isActive });

const CATALOG: StructureCatalog = {
  sector: [
    option('s-prod', 'Produção', true, 'PRD'),
    option('s-log', 'Logística', true, 'LOG'),
    option('s-alm-1', 'Almoxarifado', true, 'ALM1'),
    option('s-alm-2', 'Almoxarifado', true, 'ALM2'),
    option('s-arq', 'Arquivo Morto', false, 'ARQ'),
  ],
  shift: [
    option('sh-man', 'Manhã'),
    option('sh-not', 'Noite', false),
    option('sh-mad-1', 'Madrugada'),
    option('sh-mad-2', 'Madrugada'),
    option('sh-int-on', 'Intermediário'),
    option('sh-int-off', 'Intermediário', false),
  ],
  level: [
    option('lv-op', 'Operacional'),
    option('lv-sen', 'Sênior'),
    option('lv-est', 'Estagiário', false),
  ],
};

type Overrides = {
  currentId?: string | null;
  reach?: readonly string[] | null;
};

function match(
  kind: StructureKind,
  text: string,
  overrides: Overrides = {},
): StructureMatch {
  return matchStructure({
    kind,
    text,
    catalog: CATALOG,
    currentId: overrides.currentId ?? null,
    reach: overrides.reach ?? null,
  });
}

describe('matchStructure: não achou (aceite 18)', () => {
  it('aceite 18: setor, turno e nível inexistentes ou inativos invalidam com o nome no motivo', () => {
    expect(match('sector', 'Diretoria')).toEqual({
      ok: false,
      reason: ROW_TEXT.notFound('Setor', 'Diretoria'),
    });
    expect(match('shift', 'Tarde')).toEqual({
      ok: false,
      reason: "Turno 'Tarde' não encontrado",
    });
    expect(match('level', 'Gerente')).toEqual({
      ok: false,
      reason: "Nível 'Gerente' não encontrado",
    });
    // inativos não são achados, nem pelo código do setor
    expect(match('sector', 'Arquivo Morto')).toEqual({
      ok: false,
      reason: "Setor 'Arquivo Morto' não encontrado",
    });
    expect(match('sector', 'ARQ')).toEqual({
      ok: false,
      reason: ROW_TEXT.notFound('Setor', 'ARQ'),
    });
    expect(match('shift', 'Noite')).toEqual({
      ok: false,
      reason: ROW_TEXT.notFound('Turno', 'Noite'),
    });
    expect(match('level', 'Estagiário')).toEqual({
      ok: false,
      reason: "Nível 'Estagiário' não encontrado",
    });
  });
});

describe('matchStructure: normalização e código', () => {
  it('sem diferenciar maiúsculas e acentos; setor também pelo código', () => {
    expect(match('sector', '  PRODUCAO ')).toEqual({ ok: true, id: 's-prod' });
    expect(match('sector', 'logistica')).toEqual({ ok: true, id: 's-log' });
    expect(match('sector', 'prd')).toEqual({ ok: true, id: 's-prod' });
    expect(match('shift', 'MANHA')).toEqual({ ok: true, id: 'sh-man' });
    expect(match('level', 'senior')).toEqual({ ok: true, id: 'lv-sen' });
  });

  it('o nome é normalizado: acento, caixa e espaços repetidos', () => {
    expect(normalizeStructureName('  Ação\t  Çedilha  ')).toBe('acao cedilha');
    expect(normalizeStructureName('')).toBe('');
  });
});

describe('matchStructure: mais de um e valor atual', () => {
  it('nome que casa com mais de um ativo dá corresponde a mais de um', () => {
    expect(match('sector', 'almoxarifado')).toEqual({
      ok: false,
      reason: ROW_TEXT.ambiguous('Setor', 'almoxarifado'),
    });
    expect(match('shift', 'Madrugada')).toEqual({
      ok: false,
      reason: "Turno 'Madrugada' corresponde a mais de um",
    });
    // a opção inativa de mesmo nome não conta: sobra uma só
    expect(match('shift', 'intermediário')).toEqual({
      ok: true,
      id: 'sh-int-on',
    });
  });

  it('valor igual ao atual vale mesmo inativo', () => {
    expect(match('sector', 'Arquivo Morto', { currentId: 's-arq' })).toEqual({
      ok: true,
      id: 's-arq',
    });
    expect(match('sector', 'arq', { currentId: 's-arq' }).ok).toBe(true);
    expect(match('shift', 'noite', { currentId: 'sh-not' })).toEqual({
      ok: true,
      id: 'sh-not',
    });
    expect(match('level', 'Estagiario', { currentId: 'lv-est' })).toEqual({
      ok: true,
      id: 'lv-est',
    });
    // o atual vence a ambiguidade; outro valor ativo continua valendo
    expect(match('shift', 'Madrugada', { currentId: 'sh-mad-2' })).toEqual({
      ok: true,
      id: 'sh-mad-2',
    });
    expect(match('shift', 'Manhã', { currentId: 'sh-not' })).toEqual({
      ok: true,
      id: 'sh-man',
    });
  });
});

const REACH = ['s-prod', 's-alm-1', 's-arq'];

describe('matchStructure: quem não é ADMIN (EX16)', () => {
  const reach = REACH;

  it('quem não é ADMIN: setor fora do alcance e inexistente dão o mesmo texto', () => {
    const outside = match('sector', 'Logística', { reach });
    const missing = match('sector', 'Diretoria', { reach });
    expect(outside).toEqual({
      ok: false,
      reason: ROW_TEXT.notInReach('Logística'),
    });
    expect(missing).toEqual({
      ok: false,
      reason:
        "Setor 'Diretoria' não encontrado entre os setores que você gerencia",
    });
    // o código do setor alheio e o setor inativo caem no mesmo texto
    expect(match('sector', 'LOG', { reach })).toEqual({
      ok: false,
      reason: ROW_TEXT.notInReach('LOG'),
    });
    expect(match('sector', 'Arquivo Morto', { reach })).toEqual({
      ok: false,
      reason: ROW_TEXT.notInReach('Arquivo Morto'),
    });
    // quem não gerencia nenhum setor não acha nenhum
    expect(match('sector', 'Produção', { reach: [] })).toEqual({
      ok: false,
      reason: ROW_TEXT.notInReach('Produção'),
    });
  });
});

describe('matchStructure: quem não é ADMIN, dentro do alcance', () => {
  const reach = REACH;

  it('acha setor do alcance pelo nome ou pelo código, e ambiguidade só entre os do alcance', () => {
    expect(match('sector', 'produção', { reach })).toEqual({
      ok: true,
      id: 's-prod',
    });
    expect(match('sector', 'PRD', { reach })).toEqual({
      ok: true,
      id: 's-prod',
    });
    // Almoxarifado tem dois ativos, só um no alcance: sem "mais de um"
    expect(match('sector', 'Almoxarifado', { reach })).toEqual({
      ok: true,
      id: 's-alm-1',
    });
    expect(
      match('sector', 'Almoxarifado', { reach: ['s-alm-1', 's-alm-2'] }),
    ).toEqual({
      ok: false,
      reason: ROW_TEXT.ambiguous('Setor', 'Almoxarifado'),
    });
  });

  it('o setor atual só vale se estiver no alcance; turno e nível não usam o alcance', () => {
    // setor atual fora do alcance não abre brecha pelo valor "igual ao atual"
    expect(match('sector', 'Logística', { reach, currentId: 's-log' })).toEqual(
      {
        ok: false,
        reason: ROW_TEXT.notInReach('Logística'),
      },
    );
    expect(match('sector', 'prd', { reach, currentId: 's-prod' }).ok).toBe(
      true,
    );
    expect(match('shift', 'Manhã', { reach })).toEqual({
      ok: true,
      id: 'sh-man',
    });
    expect(match('level', 'Gerente', { reach })).toEqual({
      ok: false,
      reason: ROW_TEXT.notFound('Nível', 'Gerente'),
    });
    expect(match('shift', 'Noite', { reach, currentId: 'sh-not' }).ok).toBe(
      true,
    );
  });
});

describe('structureName', () => {
  it('devolve o nome da opção, ativa ou não, ou null sem id ou sem opção', () => {
    expect(structureName(CATALOG, 'sector', 's-arq')).toBe('Arquivo Morto');
    expect(structureName(CATALOG, 'shift', 'sh-man')).toBe('Manhã');
    expect(structureName(CATALOG, 'level', null)).toBeNull();
    expect(structureName(CATALOG, 'level', 'nao-existe')).toBeNull();
  });
});
