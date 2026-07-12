import type { FieldMapping, WorkflowDefinition, WorkflowNode, WorkflowEdge } from '../engine';

const from = (sourceNodeId: string, sourceField: string): FieldMapping => ({ sourceNodeId, sourceField });

/**
 * Branching login flow:
 *   input → validate → fetch → route(isNew?)
 *     ├─ new      → welcome ─┐
 *     └─ existing → checkPlan ┴→ issueToken → result
 *
 * Route reads `isNew` off the fetched user: `true` takes the welcome branch,
 * anything else falls back to `existing` and runs the plan check. Both branches
 * converge on issueToken; on the new-user path checkPlan is skipped, so its
 * `plan` input resolves undefined and IssueToken falls back to 'free'.
 */
export function createLoginFlow(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    {
      id: 'input',
      type: 'Input',
      label: 'Login Request',
      position: { x: 60, y: 220 },
      config: {
        fields: [
          { name: 'username', type: 'string', required: true },
          { name: 'password', type: 'string', required: true },
        ],
        defaults: { username: 'ada', password: 'lovelace' },
      },
    },
    {
      id: 'validate',
      type: 'ValidateCredentials',
      label: 'Validate Credentials',
      position: { x: 300, y: 220 },
      config: {},
      inputMap: {
        username: from('input', 'username'),
        password: from('input', 'password'),
      },
    },
    {
      id: 'fetch',
      type: 'FetchUser',
      label: 'Fetch User',
      position: { x: 540, y: 220 },
      config: {},
      inputMap: {
        userId: { sourceNodeId: 'validate', sourceField: 'userId' },
      },
    },
    {
      id: 'route',
      type: 'Route',
      label: 'New user?',
      position: { x: 780, y: 220 },
      config: { field: 'isNew', branches: ['true'], fallback: 'existing' },
      inputMap: {
        value: { sourceNodeId: 'fetch', sourceField: '$' },
      },
    },
    {
      id: 'welcome',
      type: 'WelcomeUser',
      label: 'Welcome User',
      position: { x: 1020, y: 100 },
      config: {},
      inputMap: {
        user: { sourceNodeId: 'fetch', sourceField: '$' },
      },
    },
    {
      id: 'checkPlan',
      type: 'CheckPlan',
      label: 'Check Plan',
      position: { x: 1020, y: 340 },
      config: {},
      inputMap: {
        user: { sourceNodeId: 'fetch', sourceField: '$' },
      },
    },
    {
      id: 'issueToken',
      type: 'IssueToken',
      label: 'Issue Token',
      position: { x: 1260, y: 220 },
      config: {},
      inputMap: {
        userId: { sourceNodeId: 'fetch', sourceField: 'id' },
        plan: { sourceNodeId: 'checkPlan', sourceField: 'plan' },
      },
    },
    {
      id: 'result',
      type: 'Result',
      label: 'Result',
      position: { x: 1500, y: 220 },
      config: {},
      inputMap: {
        data: { sourceNodeId: 'issueToken', sourceField: '$' },
      },
    },
  ];

  // Branch handles live on the Route's outgoing edges (sourceHandle = branch
  // name). welcome→issueToken carries no targetHandle: it is a structural join,
  // not a data mapping (issueToken's inputs come from fetch and checkPlan).
  const edges: WorkflowEdge[] = [
    { id: 'e0', source: 'input', target: 'validate', targetHandle: 'username' },
    { id: 'e1', source: 'validate', target: 'fetch', targetHandle: 'userId' },
    { id: 'e2', source: 'fetch', target: 'route', targetHandle: 'value' },
    { id: 'e3', source: 'route', target: 'welcome', sourceHandle: 'true' },
    { id: 'e4', source: 'route', target: 'checkPlan', sourceHandle: 'existing' },
    { id: 'e5', source: 'welcome', target: 'issueToken' },
    { id: 'e6', source: 'checkPlan', target: 'issueToken', targetHandle: 'plan' },
    { id: 'e7', source: 'issueToken', target: 'result', targetHandle: 'data' },
  ];

  return {
    id: 'login-example',
    name: 'Login Example',
    version: 1,
    nodes,
    edges,
    // FetchUser derives isNew from a `new` name prefix and plan from a `pro`
    // substring, so the username alone steers every branch.
    scenarios: [
      {
        id: 'scn-new-user',
        name: 'new user',
        description: 'newton is new — welcome branch, checkPlan skipped',
        input: { username: 'newton', password: 'apple123' },
      },
      {
        id: 'scn-existing-pro',
        name: 'existing pro',
        description: 'ada-pro exists on the pro plan — plan-check branch',
        input: { username: 'ada-pro', password: 'lovelace' },
      },
      {
        id: 'scn-bad-password',
        name: 'bad password',
        description: 'password under 4 chars — validation fails the run',
        input: { username: 'ada', password: 'abc' },
      },
    ],
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  };
}
