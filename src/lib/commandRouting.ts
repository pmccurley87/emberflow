/**
 * The command bar's intent router: given the user's text and light context,
 * order the four agent doors (edit current op / build an API / add scenario /
 * ask) by likelihood. Heuristic and transparent — the UI always shows all
 * four; routing only picks the highlighted default. Keep rules dumb and
 * auditable; the agent-side prompts do the real understanding.
 */
export type RoutedKind = 'edit' | 'build' | 'scenario' | 'ask';

export interface RouteContext {
  currentFlowId: string | null;
  currentFlowName: string | null;
  hasOps: boolean;
}

export interface RoutedIntent {
  kind: RoutedKind;
  label: string;
}

const QUESTION_RE = /\?\s*$|^(why|how|what|where|when|which|who|does|is|are|can|should)\b/i;
const BUILD_RE = /\b(build|create|make|model|scaffold|new)\b.*\b(api|endpoint|endpoints|route|routes|service|worker|operations)\b/i;
const SCENARIO_RE = /\bscenarios?\b|\btest case\b/i;

export function routeCommand(text: string, ctx: RouteContext): RoutedIntent[] {
  const options: Record<RoutedKind, RoutedIntent> = {
    edit: { kind: 'edit', label: ctx.currentFlowName ? `Change ${ctx.currentFlowName}` : 'Change the open operation' },
    build: { kind: 'build', label: 'Build something new (the agent designs the API)' },
    scenario: { kind: 'scenario', label: ctx.currentFlowName ? `Add a scenario to ${ctx.currentFlowName}` : 'Add a scenario' },
    ask: { kind: 'ask', label: 'Ask about this project' },
  };
  let first: RoutedKind;
  if (QUESTION_RE.test(text.trim())) first = 'ask';
  else if (SCENARIO_RE.test(text)) first = 'scenario';
  else if (BUILD_RE.test(text) || !ctx.hasOps || !ctx.currentFlowId) first = 'build';
  else first = 'edit';
  const rest = (['edit', 'build', 'scenario', 'ask'] as RoutedKind[]).filter((k) => k !== first);
  // Options needing a current op drop out when there is none.
  const usable = [first, ...rest].filter((k) => (k === 'edit' || k === 'scenario' ? ctx.currentFlowId !== null : true));
  return usable.map((k) => options[k]);
}
