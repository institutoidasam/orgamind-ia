import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus, AlertCircle } from 'lucide-react';
import type { FilterGroup, HistoryRule, Rule } from '../schemas';
import {
  hasExcludeInvalid,
  hasLegacyValidOnlyRule,
  isExcludeInvalidGroup,
  withExcludeInvalid,
  withoutExcludeInvalid,
} from '../exclude-invalid';

// Must mirror the backend filter field enum (`campaigns/schemas.ts` →
// `fieldSchema`). `optedOut` was never a valid backend field — it silently 400'd
// the preview — and `whatsappValid` (which *is* supported) was missing. The
// `satisfies` guard makes any future divergence from `Rule['field']` a compile
// error so this list can't drift again.
const FIELDS = [
  'name',
  'city',
  'group',
  'phoneE164',
  'tags',
  'whatsappValid',
  'lastFailureReason',
] as const satisfies readonly Rule['field'][];
const OPS = ['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull', 'notNull'] as const;
const MAX_DEPTH = 4;

// in/notIn expect a Prisma array; everything else is a scalar string.
const ARRAY_OPS: ReadonlySet<Rule['op']> = new Set(['in', 'notIn']);

// `whatsappValid` is a boolean column: the backend (filter.schema.ts) only
// accepts eq/ne/isNull/notNull AND requires a real boolean value — a text
// value like "true" is rejected. So this field gets a restricted op list and a
// Válido/Inválido select instead of the free-text input.
const WHATSAPP_VALID_OPS = ['eq', 'ne', 'isNull', 'notNull'] as const satisfies readonly Rule['op'][];
// `lastFailureReason` é uma coluna de ENUM: o back (filter.schema.ts) só
// aceita in/notIn/isNull/notNull. `in`/`notIn` já usam o input de texto
// separado por vírgula (ARRAY_OPS), então nenhum widget novo é necessário.
const FAILURE_REASON_OPS = ['in', 'notIn', 'isNull', 'notNull'] as const satisfies readonly Rule['op'][];
function opsFor(field: Rule['field']): readonly Rule['op'][] {
  if (field === 'whatsappValid') return WHATSAPP_VALID_OPS;
  if (field === 'lastFailureReason') return FAILURE_REASON_OPS;
  return OPS;
}

type RuleNode = Rule & { __uid: string };
// F1 review fix — a `HistoryRule` node (§stripIds/attachIds/Group below) is
// NEITHER a Rule NOR a Group: it has no `field`/`op`/`value` and no
// `combinator`/`rules`. Treating it as a RuleNode (the pre-fix behaviour)
// produced a "ghost" RuleRow with everything undefined, and editing/deleting
// through it silently rewrote the node into `{field:undefined,op:undefined,
// value:undefined}` via stripIds — destroying the exclusion without any
// error. It gets its own branch everywhere the union is handled.
type HistoryNode = HistoryRule & { __uid: string };
type GroupNode = {
  combinator: 'and' | 'or';
  rules: Array<RuleNode | HistoryNode | GroupNode>;
  __uid: string;
};

function isGroupNode(n: RuleNode | HistoryNode | GroupNode): n is GroupNode {
  return 'combinator' in n;
}

function isHistoryNode(n: RuleNode | HistoryNode | GroupNode): n is HistoryNode {
  return 'kind' in n;
}

// The read-only chip's label. Only `received`+`negate` is produced by the
// wizard today (F1 T7 — history-exclusion.ts), but the schema allows the
// other events/polarities (a hand-edited segment could carry them), so the
// wording adapts instead of assuming.
function historyChipLabel(rule: HistoryRule): string {
  const campaignCount = rule.campaignIds?.length ?? 0;
  const templateCount = rule.templateIds?.length ?? 0;
  const eventLabel =
    rule.event === 'received'
      ? 'já recebeu'
      : rule.event === 'failed'
        ? 'teve falha no envio'
        : 'respondeu';
  const prefix = rule.negate ? 'Excluir quem' : 'Incluir apenas quem';
  return `${prefix} ${eventLabel}: ${campaignCount} campanha(s), ${templateCount} template(s)`;
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `uid-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// Render a rule value back into the single text input. Arrays (in/notIn) are
// shown comma+space separated; scalars are stringified as-is.
function valueToInput(value: Rule['value']): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}

// Parse the comma-separated input for array ops, trimming each entry and
// dropping empties so `"a, b ,"` → `['a','b']`.
function splitToArray(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function attachIds(g: FilterGroup): GroupNode {
  return {
    combinator: g.combinator,
    __uid: uid(),
    rules: g.rules.map((r): RuleNode | HistoryNode | GroupNode => {
      if ('combinator' in r) return attachIds(r);
      // History nodes get a `__uid` too (the list needs a React key and a
      // stable identity to update-in-place), but are NOT reshaped into a
      // Rule — see the HistoryNode comment above.
      if ('kind' in r) return { ...r, __uid: uid() };
      return { ...r, __uid: uid() };
    }),
  };
}

function stripIds(g: GroupNode): FilterGroup {
  return {
    combinator: g.combinator,
    rules: g.rules.map((r) => {
      if (isGroupNode(r)) return stripIds(r);
      if (isHistoryNode(r)) {
        // Preserve the node as-is (minus `__uid`) — NOT `{field,op,value}`,
        // which would silently corrupt it into an all-undefined Rule and
        // destroy the exclusion without any error.
        const { __uid: _uid, ...historyRule } = r;
        return historyRule;
      }
      return { field: r.field, op: r.op, value: r.value };
    }),
  };
}

// Cheap structural compare to detect external value changes that aren't from us
function sameShape(a: FilterGroup, b: FilterGroup): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function FilterBuilder({
  value,
  onChange,
}: {
  value: FilterGroup;
  onChange: (v: FilterGroup) => void;
}) {
  const [tree, setTree] = useState<GroupNode>(() => attachIds(value));
  const lastEmitted = useRef<FilterGroup>(value);

  // If parent value changes externally (different object content), resync.
  useEffect(() => {
    if (!sameShape(value, lastEmitted.current)) {
      setTree(attachIds(value));
      lastEmitted.current = value;
    }
  }, [value]);

  const update = (next: GroupNode) => {
    setTree(next);
    const stripped = stripIds(next);
    lastEmitted.current = stripped;
    onChange(stripped);
  };

  // ★ B.4 — "Excluir inválidos confirmados", no lugar de "Apenas números
  // válidos (WhatsApp)". O toggle antigo emitia UMA regra (`whatsappValid eq
  // true`) que, numa base majoritariamente NULL, selecionava ZERO pessoas — a
  // campanha saía vazia sem erro nenhum. O novo emite o grupo null-safe de
  // `exclude-invalid.ts`, que pergunta "quem NÃO é comprovadamente inválido?".
  const excludeInvalid = hasExcludeInvalid(stripIds(tree));
  const toggleExcludeInvalid = (checked: boolean) => {
    const next = checked
      ? withExcludeInvalid(stripIds(tree))
      : withoutExcludeInvalid(stripIds(tree));
    update(attachIds(next));
  };
  const legacyValidOnly = hasLegacyValidOnlyRule(stripIds(tree));

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-sm font-medium">
        <Checkbox
          checked={excludeInvalid}
          onCheckedChange={(c) => toggleExcludeInvalid(c === true)}
          aria-label="Excluir inválidos confirmados"
        />
        Excluir inválidos confirmados
      </label>
      {legacyValidOnly && (
        <div
          data-testid="legacy-valid-only-warning"
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Este filtro tem a regra antiga "whatsappValid é igual a Válido". Ela
            deixa de fora todos os contatos <strong>não validados</strong> — que
            hoje são a maior parte da base. Se a intenção era só não mandar para
            número recusado, remova a regra e ligue "Excluir inválidos
            confirmados" acima.
          </span>
        </div>
      )}
      <Group group={tree} onChange={update} depth={0} />
    </div>
  );
}

function Group({
  group,
  onChange,
  depth,
}: {
  group: GroupNode;
  onChange: (v: GroupNode) => void;
  depth: number;
}) {
  return (
    <div className={`min-w-0 space-y-2 rounded border p-3 ${depth > 0 ? 'bg-muted/30' : ''}`}>
      <Select
        value={group.combinator}
        onValueChange={(v) => onChange({ ...group, combinator: v as 'and' | 'or' })}
      >
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="and">E (AND)</SelectItem>
          <SelectItem value="or">OU (OR)</SelectItem>
        </SelectContent>
      </Select>

      {group.rules.map((rule, i) => (
        <div key={rule.__uid} className="flex min-w-0 items-start gap-2">
          {isExcludeInvalidGroup(rule) ? (
            <span
              data-testid="exclude-invalid-chip"
              className="rounded border bg-muted px-2 py-1 text-xs"
              title="whatsappValid é nulo ou verdadeiro, E o motivo da última falha é nulo ou não é SEM_WHATSAPP/TELEFONE_INVALIDO"
            >
              Inválidos confirmados excluídos
            </span>
          ) : isGroupNode(rule) ? (
            <Group
              group={rule}
              onChange={(updated) => {
                const newRules = [...group.rules];
                newRules[i] = updated;
                onChange({ ...group, rules: newRules });
              }}
              depth={depth + 1}
            />
          ) : isHistoryNode(rule) ? (
            <HistoryChip rule={rule} />
          ) : (
            <RuleRow
              rule={rule}
              onChange={(updated) => {
                const newRules = [...group.rules];
                newRules[i] = { ...updated, __uid: rule.__uid };
                onChange({ ...group, rules: newRules });
              }}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              isExcludeInvalidGroup(rule)
                ? 'Remover exclusão de inválidos'
                : isGroupNode(rule)
                  ? 'Remover grupo'
                  : isHistoryNode(rule)
                    ? 'Remover exclusão de histórico'
                    : 'Remover regra'
            }
            onClick={() => {
              const newRules = group.rules.filter((_, idx) => idx !== i);
              onChange({ ...group, rules: newRules });
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onChange({
              ...group,
              rules: [
                ...group.rules,
                { field: 'city', op: 'eq', value: '', __uid: uid() },
              ],
            });
          }}
        >
          <Plus className="mr-1 h-3 w-3" /> Regra
        </Button>
        {depth < MAX_DEPTH && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onChange({
                ...group,
                rules: [
                  ...group.rules,
                  { combinator: 'and', rules: [], __uid: uid() },
                ],
              });
            }}
          >
            <Plus className="mr-1 h-3 w-3" /> Grupo
          </Button>
        )}
      </div>
    </div>
  );
}

// F1 review fix — a history node (e.g. the "excluir quem já recebeu" node
// materialized by history-exclusion.ts) isn't editable through this builder:
// it has no field/op/value to bind a RuleRow to. Rendering it as a read-only
// chip (instead of forcing it through RuleRow, which produced a "ghost" row
// with field/op undefined) keeps it legible and removable — via the row's
// own Trash2 button, same as any other node — without pretending it can be
// edited here.
function HistoryChip({ rule }: { rule: HistoryNode }) {
  return (
    <div
      data-testid="history-chip"
      className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--border)] bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="truncate">{historyChipLabel(rule)}</span>
    </div>
  );
}

function RuleRow({
  rule,
  onChange,
}: {
  rule: RuleNode;
  onChange: (r: RuleNode) => void;
}) {
  const isWaValid = rule.field === 'whatsappValid';
  const noValue = rule.op === 'isNull' || rule.op === 'notNull';

  // Switching TO whatsappValid forces a valid op + a real boolean value;
  // switching AWAY resets the (boolean) value back to a text-friendly default.
  const changeField = (field: Rule['field']) => {
    if (field === 'whatsappValid') {
      onChange({ ...rule, field, op: 'eq', value: true });
    } else if (rule.field === 'whatsappValid') {
      onChange({ ...rule, field, value: '' });
    } else {
      onChange({ ...rule, field });
    }
  };

  const changeOp = (op: Rule['op']) => {
    // eq/ne on whatsappValid need a boolean; seed one if the value isn't already.
    if (isWaValid && (op === 'eq' || op === 'ne') && typeof rule.value !== 'boolean') {
      onChange({ ...rule, op, value: true });
    } else {
      onChange({ ...rule, op });
    }
  };

  return (
    // `flex-wrap` + `min-w-0`: num container estreito (ex.: o dialog de
    // consentimento em massa), os selects de campo/operador têm largura fixa
    // e não cedem espaço — sem quebra de linha, o input de VALOR era
    // espremido/cortado e a linha inteira acabava transbordando (rolagem
    // horizontal no dialog). Com wrap, campo+operador ficam numa linha e o
    // valor cai para a linha seguinte, sempre com largura total e utilizável.
    <div
      data-testid="rule-row"
      className="flex min-w-0 flex-wrap gap-2"
    >
      <Select value={rule.field} onValueChange={(v) => changeField(v as Rule['field'])}>
        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={rule.op} onValueChange={(v) => changeOp(v as Rule['op'])}>
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          {opsFor(rule.field).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
      {noValue ? null : isWaValid ? (
        <Select
          value={rule.value === true ? 'true' : rule.value === false ? 'false' : ''}
          onValueChange={(v) => onChange({ ...rule, value: v === 'true' })}
        >
          <SelectTrigger className="min-w-32 flex-1"><SelectValue placeholder="Válido?" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Válido</SelectItem>
            <SelectItem value="false">Inválido</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="min-w-32 flex-1"
          placeholder={ARRAY_OPS.has(rule.op) ? 'valores separados por vírgula' : undefined}
          value={valueToInput(rule.value)}
          onChange={(e) =>
            onChange({
              ...rule,
              value: ARRAY_OPS.has(rule.op)
                ? splitToArray(e.target.value)
                : e.target.value,
            })
          }
        />
      )}
    </div>
  );
}
