import type { NodeRegistry } from '../../engine';
import { registerPradarNodes } from './nodes';

/**
 * EV charge scheduler nodes for the EV charging demo. Pure decision logic lives
 * in ./logic; ./nodes wraps each function as a registry node. The vehicle /
 * push-notification effect nodes are simulated (see their PORT NOTEs).
 */
export function registerPradarNodesModule(registry: NodeRegistry): void {
  registerPradarNodes(registry);
}
