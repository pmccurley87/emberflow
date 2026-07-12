import type { WorkflowDefinition } from '../engine';

// Versioned: bump when the format changes incompatibly (stale saves are dropped).
const WORKSPACE_KEY = 'emberflow.workspace.v1';

export interface Workspace {
  flows: WorkflowDefinition[];
  activeId: string;
}

export function serializeFlow(flow: WorkflowDefinition): string {
  return JSON.stringify(flow, null, 2);
}

export function parseFlow(json: string): WorkflowDefinition {
  const parsed: unknown = JSON.parse(json);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as WorkflowDefinition).id !== 'string' ||
    !Array.isArray((parsed as WorkflowDefinition).nodes) ||
    !Array.isArray((parsed as WorkflowDefinition).edges)
  ) {
    throw new Error('Invalid flow JSON');
  }
  return parsed as WorkflowDefinition;
}

export function saveWorkspace(workspace: Workspace): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
}

export function loadWorkspace(): Workspace | null {
  if (typeof localStorage === 'undefined') return null;
  const json = localStorage.getItem(WORKSPACE_KEY);
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as Workspace).flows) ||
      typeof (parsed as Workspace).activeId !== 'string'
    ) {
      return null;
    }
    const flows = (parsed as Workspace).flows.map((f) => parseFlow(JSON.stringify(f)));
    if (flows.length === 0) return null;
    return { flows, activeId: (parsed as Workspace).activeId };
  } catch {
    return null;
  }
}
