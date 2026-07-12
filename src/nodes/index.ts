import type { NodeRegistry } from '../engine';
import { createLoginRegistry } from './login';
import { registerWeatherNodes } from './weather';
import { registerAnomalyNodes } from './anomaly';
import { registerFlowControlNodes } from './flow-control';
import { registerLoopNodes } from './loops';
import { registerPradarNodesModule } from './pradar';
import { registerResponseNodes } from './response';
import { registerRequireAuthNode } from './requireAuth';

/** All built-in nodes: login examples, Open-Meteo weather, anomaly-detection API, EV charging demo, HTTP Response, requireAuth. */
export function createDefaultRegistry(delayMs?: number): NodeRegistry {
  const registry = createLoginRegistry(delayMs);
  registerWeatherNodes(registry);
  registerAnomalyNodes(registry);
  registerFlowControlNodes(registry);
  registerLoopNodes(registry);
  registerPradarNodesModule(registry);
  registerResponseNodes(registry);
  registerRequireAuthNode(registry);
  return registry;
}
