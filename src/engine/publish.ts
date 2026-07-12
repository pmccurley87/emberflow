import type { FieldDefinition, NodeImplementation, WorkflowDefinition } from './types';
import type { NodeRegistry } from './registry';
import { validateFlow } from './validation';

/**
 * A sealed, executable flow artifact. Carries the flow, the input schema lifted
 * from its Input node, and a SHA-256 hash of every node type's implementation
 * so the runner can refuse to execute a flow whose code has drifted.
 */
export interface PublishedArtifact {
  $artifact: 'emberflow/v1';
  publishedAt: string;
  inputSchema: FieldDefinition[];
  /** node TYPE -> sha256 hex of implementation.toString() */
  nodeHashes: Record<string, string>;
  flow: WorkflowDefinition;
}

const ARTIFACT_TAG = 'emberflow/v1';

/** SHA-256 hex of an implementation's source text (WebCrypto — browser + Node). */
export async function hashImplementation(impl: NodeImplementation): Promise<string> {
  const bytes = new TextEncoder().encode(impl.toString());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Distinct node types used by a flow, in first-seen order. */
function distinctTypes(flow: WorkflowDefinition): string[] {
  const seen: string[] = [];
  for (const node of flow.nodes) {
    if (!seen.includes(node.type)) seen.push(node.type);
  }
  return seen;
}

/** Lift the declared input schema from the flow's first Input node (or []). */
function liftInputSchema(flow: WorkflowDefinition): FieldDefinition[] {
  const input = flow.nodes.find((n) => n.type === 'Input');
  const fields = input?.config?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter(
    (f): f is FieldDefinition =>
      f !== null && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string',
  );
}

/**
 * Deep-copy a flow and strip dev-only fixtures: metadata.pinnedOutput from
 * every node, and top-level scenarios. Both are authoring aids that have no
 * business shipping in a published artifact.
 */
function sealFlow(flow: WorkflowDefinition): WorkflowDefinition {
  const copy = structuredClone(flow);
  for (const node of copy.nodes) {
    if (!node.metadata) continue;
    delete node.metadata.pinnedOutput;
    if (Object.keys(node.metadata).length === 0) delete node.metadata;
  }
  delete copy.scenarios;
  return copy;
}

/**
 * Seal a flow into a PublishedArtifact: validate (error-severity issues throw),
 * strip pins, lift the input schema, and hash each node type's implementation.
 */
export async function publishFlow(
  flow: WorkflowDefinition,
  registry: NodeRegistry,
  now: () => string = () => new Date().toISOString(),
): Promise<PublishedArtifact> {
  const errors = validateFlow(flow, registry).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Cannot publish: ${errors.map((i) => i.message).join('; ')}`);
  }

  const sealed = sealFlow(flow);
  const nodeHashes: Record<string, string> = {};
  for (const type of distinctTypes(sealed)) {
    nodeHashes[type] = await hashImplementation(registry.get(type).implementation);
  }

  return {
    $artifact: ARTIFACT_TAG,
    publishedAt: now(),
    inputSchema: liftInputSchema(sealed),
    nodeHashes,
    flow: sealed,
  };
}

/**
 * Verify every node hash in an artifact against a live registry. Returns the
 * list of drifted (hash mismatch) or unknown (unregistered) node types; an
 * empty list means the artifact is safe to execute on this registry.
 */
export async function verifyArtifact(
  artifact: PublishedArtifact,
  registry: NodeRegistry,
): Promise<string[]> {
  const bad: string[] = [];
  for (const [type, expected] of Object.entries(artifact.nodeHashes)) {
    if (!registry.has(type)) {
      bad.push(type);
      continue;
    }
    const actual = await hashImplementation(registry.get(type).implementation);
    if (actual !== expected) bad.push(type);
  }
  return bad;
}

/** Structural type guard for a PublishedArtifact envelope. */
export function isArtifact(value: unknown): value is PublishedArtifact {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.$artifact === ARTIFACT_TAG &&
    typeof v.publishedAt === 'string' &&
    Array.isArray(v.inputSchema) &&
    v.nodeHashes !== null &&
    typeof v.nodeHashes === 'object' &&
    v.flow !== null &&
    typeof v.flow === 'object'
  );
}
