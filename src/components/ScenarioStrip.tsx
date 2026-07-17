import { cn } from '@/lib/utils';
import type { ScenarioDefinition } from '../engine/types';
import type { ScenarioTestReport } from '../store/serverRunner';

/** Quiet coverage strip: one chip per scenario, pass/fail dot from the last
 *  test report, click = run that scenario. Mounted under the flow header in
 *  RunbookView so scenario coverage is visible without opening the Scenarios
 *  panel or the toolbar's "Run a scenario" dropdown. */
export function ScenarioStrip({
  scenarios,
  report,
  onRun,
}: {
  scenarios: ScenarioDefinition[];
  report: ScenarioTestReport | undefined;
  onRun: (scenarioId: string) => void;
}) {
  if (scenarios.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {scenarios.map((sc) => {
        const result = report?.results.find((r) => r.scenario === sc.name);
        const dotClass =
          result?.status === 'passed'
            ? 'bg-success'
            : result?.status === 'failed'
              ? 'bg-destructive'
              : 'bg-muted-foreground/40';
        const textClass =
          result?.status === 'passed'
            ? 'text-success'
            : result?.status === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground';
        return (
          <button
            key={sc.id}
            type="button"
            onClick={() => onRun(sc.id)}
            title="Run this scenario"
            className={cn(
              'flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px]',
              textClass,
            )}
          >
            <span className={cn('size-1.5 rounded-full', dotClass)} />
            {sc.name}
          </button>
        );
      })}
    </div>
  );
}
