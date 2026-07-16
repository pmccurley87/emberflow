import { NodeRegistry } from '../engine';
import { createLoginRegistry } from './login';
import { registerWeatherNodes } from './weather';
import { registerAnomalyNodes } from './anomaly';
import { registerFlowControlNodes } from './flow-control';
import { registerLoopNodes } from './loops';
import { registerPradarNodesModule } from './pradar';
import { registerResponseNodes } from './response';
import { registerRequireAuthNode } from './requireAuth';

/**
 * All built-in nodes: login examples, Open-Meteo weather, anomaly-detection API, EV charging demo, HTTP Response, requireAuth.
 * `opts.captureSourceRefs` is threaded from SERVER callers only (buildRegistries)
 * — this function is shared with the browser bundle, where capture stays off.
 *
 * `opts.includeDemoNodes` (default true — the repo's own studio and the
 * no-project sandbox seed demo flows that need them) controls the DEMO
 * registrars: login, weather, anomaly, the EV charging demo. CONSUMER projects
 * pass false — their palette is core control-flow + their own registered
 * nodes; demo domain nodes there are noise at best, and at worst an agent
 * builds a real operation on top of them.
 */
export function createDefaultRegistry(
  delayMs?: number,
  opts?: { captureSourceRefs?: boolean; includeDemoNodes?: boolean },
): NodeRegistry {
  const demos = opts?.includeDemoNodes ?? true;
  const registry = demos
    ? createLoginRegistry(delayMs, opts)
    : new NodeRegistry({ captureSourceRefs: opts?.captureSourceRefs });
  if (demos) {
    registerWeatherNodes(registry);
    registerAnomalyNodes(registry);
    registerPradarNodesModule(registry);
  }
  registerFlowControlNodes(registry);
  registerLoopNodes(registry);
  registerResponseNodes(registry);
  registerRequireAuthNode(registry);
  return registry;
}
