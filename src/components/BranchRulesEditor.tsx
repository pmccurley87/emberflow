import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { useBuilderStore } from '../store/builderStore';
import type { WorkflowNode } from '../engine';

/** A single Conditional rule row: `{ name, op, value? }`. Mirrors src/nodes/flow-control.ts. */
interface BranchRule {
  name: string;
  op: string;
  value?: unknown;
}

const OP_OPTIONS: ComboboxOption[] = [
  { value: 'eq', label: '= eq' },
  { value: 'neq', label: '≠ neq' },
  { value: 'gt', label: '> gt' },
  { value: 'gte', label: '≥ gte' },
  { value: 'lt', label: '< lt' },
  { value: 'lte', label: '≤ lte' },
  { value: 'contains', label: 'contains' },
  { value: 'exists', label: 'exists' },
  { value: 'truthy', label: 'truthy' },
];

/** exists/truthy read only the input value — no comparand to configure. */
const NO_COMPARAND_OPS = new Set(['exists', 'truthy']);

/** Numbers, booleans, and everything else stays a string. */
export function parseComparand(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}

function comparandText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function asRules(raw: unknown): BranchRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const rule = (r !== null && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return {
      name: typeof rule.name === 'string' ? rule.name : '',
      op: typeof rule.op === 'string' ? rule.op : 'eq',
      value: rule.value,
    };
  });
}

/**
 * Custom Config editor for Conditional nodes — an ordered list of
 * name/operator/comparand rules plus a fallback branch, in place of the
 * generic config field list (which can't express structured rule rows).
 */
export function BranchRulesEditor({ node }: { node: WorkflowNode }) {
  const updateNodeConfig = useBuilderStore((s) => s.updateNodeConfig);
  const rules = asRules(node.config.branches);
  const fallback = typeof node.config.fallback === 'string' ? node.config.fallback : '';

  const setRules = (next: BranchRule[]) => updateNodeConfig(node.id, 'branches', next);

  const updateRule = (index: number, patch: Partial<BranchRule>) => {
    setRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const addRule = () => {
    setRules([...rules, { name: '', op: 'eq', value: '' }]);
  };

  return (
    <div>
      {rules.length === 0 ? (
        <div className="mb-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          No rules — every input takes the fallback.
        </div>
      ) : (
        <div className="mb-2 space-y-1">
          {rules.map((rule, index) => {
            const showComparand = !NO_COMPARAND_OPS.has(rule.op);
            return (
              <div key={index} className="group flex items-center gap-1.5">
                <span className="w-3 shrink-0 text-right font-mono text-[10px] text-muted-foreground/50">
                  {index + 1}
                </span>
                <Input
                  className="min-w-0 flex-1"
                  value={rule.name}
                  placeholder="branch name"
                  spellCheck={false}
                  onChange={(e) => updateRule(index, { name: e.target.value })}
                />
                <Combobox
                  className="w-28 shrink-0"
                  options={OP_OPTIONS}
                  value={rule.op}
                  onChange={(op) => updateRule(index, { op })}
                  placeholder="op"
                  searchPlaceholder="Search operators…"
                />
                {showComparand ? (
                  <Input
                    className="min-w-0 flex-1"
                    value={comparandText(rule.value)}
                    placeholder="value"
                    spellCheck={false}
                    onChange={(e) => updateRule(index, { value: parseComparand(e.target.value) })}
                  />
                ) : (
                  <div className="flex-1" />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={() => removeRule(index)}
                  aria-label="Remove rule"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="-ml-1.5 gap-1 text-muted-foreground"
        onClick={addRule}
      >
        <PlusIcon className="size-3.5" />
        Add branch
      </Button>
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
        <span className="shrink-0 text-[11.5px] text-muted-foreground">otherwise →</span>
        <Input
          className="min-w-0 flex-1"
          value={fallback}
          placeholder="fallback branch"
          spellCheck={false}
          onChange={(e) => updateNodeConfig(node.id, 'fallback', e.target.value)}
        />
      </div>
    </div>
  );
}
